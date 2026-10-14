// «Главная» сейчас (ТЗ п.5, §26.6): заказы в работе, просрочки, ждущие оплаты и последние заявки — то, что живёт минутами.
// Показатели за период «Главная» берёт из предрасчёта (convex/stats.ts), поэтому здесь нет среза заказов за 90 дней.
import { query } from "./lib/functions";
import type { Doc } from "./_generated/dataModel";
import { loadCatalog } from "./catalog";
import { inScope, requireRole, scopeOf, TEAM } from "./lib/access";
import { orderWithoutMoney, toLead, toOrder } from "./lib/dto";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import type { Lead, Order, OrderStatus } from "../src/data/types";

/** Последних заявок на «Главной». */
const LAST_LEADS = 5;
/** Руководителю отбираем свои из большего окна: чужие направления среди последних заявок — обычное дело. */
const SCOPED_WINDOW = 100;
/** Кроме заказов в работе «Главной» нужны сданные и не оплаченные — «требуют внимания», если ждут оплату дольше суток. */
const LIVE_STATUSES: readonly OrderStatus[] = [...ACTIVE_STATUSES, "awaiting_payment"];

export const live = query({
  args: {},
  handler: async (ctx): Promise<{ leads: Lead[]; orders: Order[] }> => {
    const me = await requireRole(ctx, TEAM);
    const scope = scopeOf(me);
    const byId = new Map<string, Doc<"orders">>();
    for (const s of LIVE_STATUSES) {
      for (const o of await ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", s))
        .collect()) {
        if (inScope(scope, o.category)) byId.set(o._id, o);
      }
    }
    let leads = await ctx.db
      .query("leads")
      .withIndex("by_created")
      .order("desc")
      .take(scope ? SCOPED_WINDOW : LAST_LEADS);
    if (scope) {
      const catalog = await loadCatalog(ctx);
      const catOf = (sid: string) => catalog.services.find((s) => s.id === sid)?.category ?? "";
      leads = leads.filter((l) => inScope(scope, catOf(l.serviceId))).slice(0, LAST_LEADS);
    }
    // Статус заявки на «Главной» зависит от её заказа — он может быть уже закрыт.
    for (const l of leads) {
      if (!l.orderId || byId.has(l.orderId)) continue;
      const o = await ctx.db.get(l.orderId);
      if (o && inScope(scope, o.category)) byId.set(o._id, o);
    }
    const money = me.role === "owner";
    return { leads: leads.map(toLead), orders: [...byId.values()].map((o) => (money ? toOrder(o) : orderWithoutMoney(toOrder(o)))) };
  },
});
