// Исправление денег заказа (ТЗ п.10, п.13; E1, E3; аудит L-4): сторно ошибочной оплаты и возврат клиенту — право
// «Менять деньги заказа» (по умолчанию — только владелец, ТЗ п.5.12).
// Ничего не удаляется: сторнированный платёж остаётся в списке с причиной, возврат — отдельной записью с суммой,
// способом, датой и причиной. Статус по деньгам и выручка пересчитываются сами (lib/money.ts, src/data/money.ts).
import { ConvexError, v } from "convex/values";
import { mutation } from "./_generated/server";
import { assertScope, requirePerm } from "./lib/access";
import { almatyStamp, audit, lowerFirst } from "./lib/audit";
import { executorUser, log, notify, nowIso, setStatus, uid, userActor } from "./lib/domain";
import { laterMoment, moneyDate, positiveMoney, reasonText, settle } from "./lib/money";
import { paymentMethod } from "./schema";
import { FINISHED_STATUSES, ORDER_STATUS, PAYMENT_METHODS } from "../src/data/catalog";
import { paidAmount, refundedAmount } from "../src/data/logic";
import { REFUNDABLE_STATUSES } from "../src/data/money";
import { money } from "../src/lib/format";

/**
 * Сторно оплаты: платёж внесли по ошибке. Он остаётся в списке (кто, когда и почему сторнировал), но в оплаченную
 * сумму больше не входит — долг и статус («Оплачен» → «Ожидает оплаты») пересчитываются.
 */
export const voidPayment = mutation({
  args: { id: v.id("orders"), paymentId: v.string(), reason: v.string() },
  handler: async (ctx, { id, paymentId, reason }) => {
    const me = await requirePerm(ctx, "money.edit");
    const o = await ctx.db.get(id);
    if (!o) throw new ConvexError("Заказ не найден");
    assertScope(me, o.category);
    const p = o.payments.find((x) => x.id === paymentId);
    if (!p) throw new ConvexError("Платёж не найден");
    if (p.voidedAt) throw new ConvexError("Этот платёж уже сторнирован");
    const why = reasonText(reason, "Причина сторно");
    const paid = paidAmount(o) - p.amount;
    const refunded = refundedAmount(o);
    if (refunded > paid) throw new ConvexError(`По заказу уже возвращено ${money(refunded)} — после сторно возврат оказался бы больше оплаты`);
    const at = nowIso();
    await ctx.db.patch(id, { payments: o.payments.map((x) => (x.id === paymentId ? { ...x, voidedAt: at, voidedBy: me._id, voidReason: why } : x)) });
    const what = `Сторно оплаты ${money(p.amount)} (${PAYMENT_METHODS[p.method]}, ${almatyStamp(p.at)}): ${why}`;
    await log(ctx, id, "payment", what, userActor(me._id));
    const settled = await settle(ctx, (await ctx.db.get(id))!);
    const status = settled ? `; статус «${ORDER_STATUS[settled.from].label}» → «${ORDER_STATUS[settled.to].label}»` : "";
    await audit(ctx, me, "order.paymentVoided", `Заказ №${o.number}: ${lowerFirst(what)}; оплачено ${money(paid)} из ${money(o.clientPrice)}${status}`, {
      entityId: id,
      meta: { paymentId, amount: p.amount, method: p.method, at: p.at, reason: why, paid, ...(settled ? { status: settled } : {}) },
    });
  },
});

/**
 * Возврат клиенту (ТЗ п.10 «Возврат», E1): не больше полученного, со способом, датой и причиной. Вернули всё полученное
 * по сданной работе — статус «Возврат», заказ уходит из выручки; частичный возврат статус не меняет и уменьшает выручку.
 * По отменённому заказу возвращают предоплату — он остаётся отменённым.
 */
export const addRefund = mutation({
  args: { id: v.id("orders"), amount: v.number(), method: paymentMethod, at: v.optional(v.string()), reason: v.string() },
  handler: async (ctx, { id, amount, method, at, reason }) => {
    const me = await requirePerm(ctx, "money.edit");
    const o = await ctx.db.get(id);
    if (!o) throw new ConvexError("Заказ не найден");
    assertScope(me, o.category);
    if (!REFUNDABLE_STATUSES.includes(o.status)) throw new ConvexError(`Возврат оформляется по выполненному или отменённому заказу, а этот — «${ORDER_STATUS[o.status].label}»`);
    const value = positiveMoney(amount, "Возврат");
    const received = paidAmount(o) - refundedAmount(o);
    if (value > received) throw new ConvexError(received > 0 ? `Вернуть можно не больше полученного: ${money(received)}` : "По заказу нет полученных денег — возвращать нечего");
    const when = moneyDate(at, "Дата возврата", o.createdAt);
    const why = reasonText(reason, "Причина возврата");
    const refund = { id: uid("r"), amount: value, method, at: when, reason: why, by: me._id };
    await ctx.db.patch(id, { refunds: [...(o.refunds ?? []), refund], moneyAt: laterMoment(o.moneyAt, when) });

    const full = value === received;
    const toRefund = full && FINISHED_STATUSES.includes(o.status);
    const actor = userActor(me._id);
    const what = `${full ? "Возврат всей полученной суммы" : "Частичный возврат"} ${money(value)} (${PAYMENT_METHODS[method]}): ${why}`;
    if (toRefund) await setStatus(ctx, o, "refund", actor, what);
    else await log(ctx, id, "payment", what, actor);
    await audit(ctx, me, "order.refund", `Заказ №${o.number}: ${lowerFirst(what)}${toRefund ? `; «${ORDER_STATUS[o.status].label}» → «Возврат»` : ""}`, {
      entityId: id,
      meta: { refundId: refund.id, amount: value, method, at: when, reason: why, paid: paidAmount(o), refunded: refundedAmount(o) + value, full, ...(toRefund ? { status: { from: o.status, to: "refund" } } : {}) },
    });
    // Как при любой смене статуса сотрудником: исполнитель видит, что заказ ушёл в возврат.
    if (toRefund && o.executorId) await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Заказ №${o.number}: оформлен возврат клиенту`, { link: `/w/orders/${id}`, tone: "bad" });
  },
});
