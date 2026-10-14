import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./_generated/server";
import { inScope, OWNER, requireRole, scopeOf, TEAM } from "./lib/access";
import { autoLeadIds, spendRows } from "./analytics";
import { loadCatalog } from "./catalog";
import { orderWithoutMoney as withoutMoney, toLead, toOrder } from "./lib/dto";
import { monthOf } from "../src/data/analytics";
import { ACTIVE_STATUSES } from "../src/data/catalog";

/** «Главной» не владельца хватает воронки за 90 дней и сравнения 30 дней с прошлыми 30 — глубже срез не отдаём. */
const TEAM_MAX_DAYS = 92;

/** Граница среза: любая дата → ISO UTC (как поля createdAt и doneAt); мусор — понятная ошибка. */
function isoFrom(from: string): string {
  const t = Date.parse(from);
  if (Number.isNaN(t)) throw new ConvexError("Неверная дата");
  return new Date(t).toISOString();
}

/**
 * Сырой срез: заявки с даты from, заказы — активные, созданные или выполненные с этой даты, и заказы этих заявок.
 * Экраны его больше не читают — показатели за период берутся из предрасчёта (convex/stats.ts, O(дней)); срез остаётся
 * эталоном для сверки предрасчёта с формулами (src/data/metrics.ts, src/data/analytics.ts) и для разбора расхождений.
 */
async function slice(ctx: Parameters<typeof requireRole>[0], from: string, scope: string[] | null = null, withMoney = false): Promise<{ leads: Doc<"leads">[]; orders: Doc<"orders">[] }> {
  const leads = await ctx.db.query("leads").withIndex("by_created", (q) => q.gte("createdAt", from)).collect();
  const byId = new Map<string, Doc<"orders">>();
  const add = (o: Doc<"orders"> | null) => o && byId.set(o._id, o);
  for (const s of ACTIVE_STATUSES) (await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()).forEach(add);
  (await ctx.db.query("orders").withIndex("by_created", (q) => q.gte("createdAt", from)).collect()).forEach(add);
  (await ctx.db.query("orders").withIndex("by_done", (q) => q.gte("doneAt", from)).collect()).forEach(add);
  // «Получено» — по датам оплат и возвратов: заказ, выполненный раньше периода, мог быть оплачен в нём.
  if (withMoney) (await ctx.db.query("orders").withIndex("by_money", (q) => q.gte("moneyAt", from)).collect()).forEach(add);
  for (const l of leads) if (l.orderId && !byId.has(l.orderId)) add(await ctx.db.get(l.orderId));
  if (!scope) return { leads, orders: [...byId.values()] };
  const cat = await loadCatalog(ctx);
  const catOf = (sid: string) => cat.services.find((s) => s.id === sid)?.category ?? "";
  return {
    leads: leads.filter((l) => inScope(scope, catOf(l.serviceId))),
    orders: [...byId.values()].filter((o) => inScope(scope, o.category)),
  };
}

export const dashboard = query({
  args: { from: v.string() },
  handler: async (ctx, { from }) => {
    const me = await requireRole(ctx, TEAM);
    const start = isoFrom(from);
    if (me.role === "owner") {
      const s = await slice(ctx, start);
      return { leads: s.leads.map(toLead), orders: s.orders.map(toOrder) };
    }
    const floor = new Date(Date.now() - TEAM_MAX_DAYS * 86400_000).toISOString();
    const s = await slice(ctx, start > floor ? start : floor, scopeOf(me));
    return { leads: s.leads.map(toLead), orders: s.orders.map((o) => withoutMoney(toOrder(o))) };
  },
});

/**
 * «Аналитика» владельца: срез (с заказами, по которым были деньги с даты from) + какие заявки завела система
 * (их не засчитываем операторам) + расходы на рекламу за месяцы периода (для стоимости заявки и заказа)
 * + выплаты мастерам по датам выплат (реестр payouts) — для «Выплачено мастерам».
 */
export const analytics = query({
  args: { from: v.string() },
  handler: async (ctx, { from }) => {
    await requireRole(ctx, OWNER);
    const start = isoFrom(from);
    const s = await slice(ctx, start, null, true);
    const payouts = await ctx.db
      .query("payouts")
      .withIndex("by_at", (q) => q.gte("at", start))
      .collect();
    return {
      leads: s.leads.map(toLead),
      orders: s.orders.map(toOrder),
      autoLeads: await autoLeadIds(ctx, s.leads),
      adSpend: await spendRows(ctx, monthOf(Date.parse(start)), monthOf(Date.now())),
      payouts: payouts.map((p) => ({ at: p.at, amount: p.amount })),
    };
  },
});
