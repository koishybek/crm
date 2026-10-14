// Выплаты исполнителям (ТЗ п.13 «выплата», п.14 «доход», п.17 «выплаты исполнителям») — реестр вместо флажка в заказе.
// Владелец видит, сколько должен каждому мастеру, выбирает заказы и проводит выплату (способ, дата, комментарий):
// появляется строка реестра, заказы отмечаются выплаченными, мастер получает уведомление. Ошибку можно отменить в течение суток.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { can, EXECUTOR, noAccess, requirePerm, requireRole, STAFF, type Me } from "./lib/access";
import { almatyStamp, audit } from "./lib/audit";
import { executorUser, log, notify, nowIso, TENANT, userActor } from "./lib/domain";
import { moneyDate, noteText } from "./lib/money";
import { paymentMethod } from "./schema";
import { PAYMENT_METHODS } from "../src/data/catalog";
import { paidAmount, payout } from "../src/data/logic";
import { isPayoutDue, PAYOUT_MAX_ORDERS, PAYOUT_UNDO_MS } from "../src/data/money";
import type { OwedExecutor, PayoutEntry, WorkerPayout } from "../src/data/types";
import { money, shortName } from "../src/lib/format";

/** Строк реестра на экране владельца и у мастера. */
const LIST_LIMIT = 100;
const MINE_LIMIT = 30;

/** «№1001, №1002 и ещё 3» — заказы выплаты для уведомления и журнала. */
function numbersText(numbers: readonly number[]): string {
  const head = numbers.slice(0, 5).map((n) => `№${n}`).join(", ");
  return numbers.length > 5 ? `${head} и ещё ${numbers.length - 5}` : head;
}

/** Провести или отменить выплату: видеть выплаты и менять деньги (ТЗ п.5.12; по умолчанию — владелец). */
async function payer(ctx: QueryCtx): Promise<Me> {
  const me = await requirePerm(ctx, "money.payouts", STAFF);
  if (!can(me, "money.edit")) throw new ConvexError(noAccess("money.edit"));
  return me;
}

/** Кому и сколько компания должна сейчас: сданные заказы, выплата за которые не проведена. Больший долг — выше. */
export const owed = query({
  args: {},
  handler: async (ctx): Promise<OwedExecutor[]> => {
    await requirePerm(ctx, "money.payouts", STAFF);
    // Невыплаченные выполненные — по индексу, без перебора всей истории заказов.
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_payout", (q) => q.eq("payoutPaid", false).gt("doneAt", ""))
      .collect();
    const byExecutor = new Map<Id<"executors">, Doc<"orders">[]>();
    for (const o of rows) {
      if (!o.executorId || !isPayoutDue(o)) continue;
      byExecutor.set(o.executorId, [...(byExecutor.get(o.executorId) ?? []), o]);
    }
    const out: OwedExecutor[] = [];
    for (const [executorId, list] of byExecutor) {
      const e = await ctx.db.get(executorId);
      list.sort((a, b) => (a.doneAt ?? "").localeCompare(b.doneAt ?? ""));
      out.push({
        executorId,
        name: e?.name ?? "Исполнитель удалён",
        amount: list.reduce((s, o) => s + payout(o), 0),
        orders: list.map((o) => ({ id: o._id, number: o.number, serviceId: o.serviceId, status: o.status, doneAt: o.doneAt, payout: payout(o), clientPaid: paidAmount(o) >= o.clientPrice })),
      });
    }
    return out.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, "ru"));
  },
});

async function toEntry(ctx: QueryCtx, p: Doc<"payouts">, names: Map<string, string>, now: number): Promise<PayoutEntry> {
  const name = async (id: Id<"executors"> | Id<"users">): Promise<string> => {
    if (!names.has(id)) names.set(id, (await ctx.db.get(id))?.name ?? "");
    return names.get(id) ?? "";
  };
  return {
    id: p._id,
    executorId: p.executorId,
    executorName: (await name(p.executorId)) || "Исполнитель удалён",
    orders: p.orderIds.map((id, i) => ({ id, number: p.orderNumbers[i] ?? 0 })),
    amount: p.amount,
    method: p.method,
    at: p.at,
    byName: (await name(p.by)) || "Сотрудник",
    note: p.note,
    createdAt: p.createdAt,
    canUndo: now - Date.parse(p.createdAt) < PAYOUT_UNDO_MS,
  };
}

/** Реестр выплат, новые сверху; executorId — только выплаты этого мастера. */
export const list = query({
  args: { executorId: v.optional(v.id("executors")) },
  handler: async (ctx, { executorId }): Promise<PayoutEntry[]> => {
    await requirePerm(ctx, "money.payouts", STAFF);
    const rows = executorId
      ? await ctx.db
          .query("payouts")
          .withIndex("by_executor", (q) => q.eq("executorId", executorId))
          .order("desc")
          .take(LIST_LIMIT)
      : await ctx.db.query("payouts").withIndex("by_at").order("desc").take(LIST_LIMIT);
    const names = new Map<string, string>();
    const now = Date.now();
    const out: PayoutEntry[] = [];
    for (const p of rows) out.push(await toEntry(ctx, p, names, now));
    return out;
  },
});

/**
 * Провести выплату мастеру за выбранные заказы: способ, дата (по умолчанию — сейчас), комментарий.
 * Заказы — только этого мастера, сданные и ещё не выплаченные; сумма — их выплаты на сейчас.
 */
export const create = mutation({
  args: { executorId: v.id("executors"), orderIds: v.array(v.id("orders")), method: paymentMethod, at: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ id: Id<"payouts">; amount: number }> => {
    const me = await payer(ctx);
    const ids = [...new Set(a.orderIds)];
    if (!ids.length) throw new ConvexError("Выберите заказы для выплаты");
    if (ids.length > PAYOUT_MAX_ORDERS) throw new ConvexError(`Не больше ${PAYOUT_MAX_ORDERS} заказов в одной выплате`);
    const e = await ctx.db.get(a.executorId);
    if (!e) throw new ConvexError("Исполнитель не найден");
    const orders: Doc<"orders">[] = [];
    for (const id of ids) {
      const o = await ctx.db.get(id);
      if (!o) throw new ConvexError("Заказ не найден");
      if (o.executorId !== a.executorId) throw new ConvexError(`Заказ №${o.number} выполнял другой исполнитель`);
      if (o.payoutPaid) throw new ConvexError(`За заказ №${o.number} выплата уже проведена`);
      if (!isPayoutDue(o)) throw new ConvexError(`Заказ №${o.number} ещё не сдан или по нему нечего выплачивать`);
      orders.push(o);
    }
    orders.sort((x, y) => x.number - y.number);
    const earliest = orders.reduce((m, o) => (o.createdAt < m ? o.createdAt : m), orders[0]!.createdAt);
    const at = moneyDate(a.at, "Дата выплаты", earliest);
    const note = noteText(a.note, "Комментарий к выплате");
    const amount = orders.reduce((s, o) => s + payout(o), 0);
    const numbers = orders.map((o) => o.number);
    const id = await ctx.db.insert("payouts", {
      tenantId: TENANT,
      executorId: a.executorId,
      orderIds: orders.map((o) => o._id),
      orderNumbers: numbers,
      amount,
      method: a.method,
      at,
      by: me._id,
      ...(note ? { note } : {}),
      createdAt: nowIso(),
    });
    const actor = userActor(me._id);
    for (const o of orders) {
      await ctx.db.patch(o._id, { payoutPaid: true, payoutPaidAt: at, payoutId: id });
      await log(ctx, o._id, "finance", `Исполнителю выплачено ${money(payout(o))} (${PAYMENT_METHODS[a.method]}, ${almatyStamp(at)})`, actor);
    }
    const what = `${money(amount)} (${PAYMENT_METHODS[a.method]}) за заказы ${numbersText(numbers)}`;
    await audit(ctx, me, "executor.payout", `Выплата ${shortName(e.name)}: ${what}`, { entityId: a.executorId, meta: { payoutId: id, amount, method: a.method, at, orders: numbers } });
    await notify(ctx, [(await executorUser(ctx, a.executorId))?._id], `Выплата ${what}`, { link: "/w/income", tone: "ok" });
    return { id, amount };
  },
});

/** Отменить ошибочную выплату — в течение суток после проведения: заказы снова «к выплате», мастер получает уведомление. */
export const undo = mutation({
  args: { id: v.id("payouts") },
  handler: async (ctx, { id }) => {
    const me = await payer(ctx);
    const p = await ctx.db.get(id);
    if (!p) throw new ConvexError("Выплата не найдена — возможно, её уже отменили");
    if (Date.now() - Date.parse(p.createdAt) >= PAYOUT_UNDO_MS) throw new ConvexError("Отменить выплату можно только в течение суток после проведения");
    const actor = userActor(me._id);
    for (const orderId of p.orderIds) {
      const o = await ctx.db.get(orderId);
      // Отметку снимаем только с заказов этой выплаты.
      if (!o || o.payoutId !== id) continue;
      await ctx.db.patch(orderId, { payoutPaid: false, payoutPaidAt: undefined, payoutId: undefined });
      await log(ctx, orderId, "finance", `Выплата исполнителю отменена (${money(payout(o))})`, actor);
    }
    await ctx.db.delete(id);
    const e = await ctx.db.get(p.executorId);
    const what = `${money(p.amount)} (${PAYMENT_METHODS[p.method]}) за заказы ${numbersText(p.orderNumbers)}`;
    await audit(ctx, me, "executor.payoutUndone", `Отменена выплата ${shortName(e?.name ?? "исполнителю")}: ${what}`, { entityId: p.executorId, meta: { payoutId: id, amount: p.amount, at: p.at, orders: p.orderNumbers } });
    await notify(ctx, [(await executorUser(ctx, p.executorId))?._id], `Выплата ${what} отменена офисом`, { link: "/w/income", tone: "warn" });
  },
});

/** Выплаты мне (кабинет мастера, «Доход»): дата, сумма, способ и заказы — без комментариев офиса. */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<WorkerPayout[]> => {
    const me = await requireRole(ctx, EXECUTOR);
    const executorId = me.executorId;
    if (!executorId) return [];
    const rows = await ctx.db
      .query("payouts")
      .withIndex("by_executor", (q) => q.eq("executorId", executorId))
      .order("desc")
      .take(MINE_LIMIT);
    return rows.map((p) => ({ id: p._id, at: p.at, amount: p.amount, method: p.method, orders: p.orderIds.map((id, i) => ({ id, number: p.orderNumbers[i] ?? 0 })) }));
  },
});
