import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { inScope, OWNER, requireRole, scopeOf, TEAM } from "./lib/access";
import { loadCatalog } from "./catalog";
import { toLead, toOrder } from "./lib/dto";
import { ACTIVE_STATUSES } from "../src/data/catalog";

/**
 * Срез для «Главной» и «Аналитики»: заявки с даты from, заказы — активные, созданные или выполненные
 * с этой даты, и заказы этих заявок. Формулы считаются на фронте (src/data/metrics.ts) — одни на оба экрана.
 */
async function slice(ctx: Parameters<typeof requireRole>[0], from: string, scope: string[] | null = null) {
  const leads = await ctx.db.query("leads").withIndex("by_created", (q) => q.gte("createdAt", from)).collect();
  const byId = new Map<string, Doc<"orders">>();
  const add = (o: Doc<"orders"> | null) => o && byId.set(o._id, o);
  for (const s of ACTIVE_STATUSES) (await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()).forEach(add);
  (await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from)).collect()).forEach(add);
  (await ctx.db.query("orders").withIndex("by_done", (q) => q.gte("doneAt", from)).collect()).forEach(add);
  for (const l of leads) if (l.orderId && !byId.has(l.orderId)) add(await ctx.db.get(l.orderId));
  if (!scope) return { leads: leads.map(toLead), orders: [...byId.values()].map(toOrder) };
  const cat = await loadCatalog(ctx);
  const catOf = (sid: string) => cat.services.find((s) => s.id === sid)?.category ?? "";
  return {
    leads: leads.filter((l) => inScope(scope, catOf(l.serviceId))).map(toLead),
    orders: [...byId.values()].filter((o) => inScope(scope, o.category)).map(toOrder),
  };
}

export const dashboard = query({
  args: { from: v.string() },
  handler: async (ctx, { from }) => {
    const me = await requireRole(ctx, TEAM);
    return slice(ctx, from, scopeOf(me));
  },
});

export const analytics = query({
  args: { from: v.string() },
  handler: async (ctx, { from }) => {
    await requireRole(ctx, OWNER);
    return slice(ctx, from);
  },
});
