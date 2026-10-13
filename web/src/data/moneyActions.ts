// Деньги заказа и выплаты мастерам: действия интерфейса → convex/orders.ts, convex/finance.ts, convex/payouts.ts.
// Каждое возвращает Result, текст ошибки — для тоста.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run } from "./convex";
import type { PaymentMethod } from "./types";

const oid = (id: string) => id as Id<"orders">;

export interface PaymentInput {
  amount: number;
  method: PaymentMethod;
  /** Дата оплаты (ISO); нет — «сейчас». */
  paidAt?: string;
  note?: string;
  /** Клиент заплатил больше цены — сотрудник это подтвердил. */
  confirmOverpay?: boolean;
}

export const addPayment = (orderId: string, p: PaymentInput) =>
  run(convex.mutation(api.orders.addPayment, { id: oid(orderId), amount: p.amount, method: p.method, paidAt: p.paidAt, note: p.note?.trim() || undefined, confirmOverpay: p.confirmOverpay }));

/** Сторно ошибочной оплаты — только владелец. */
export const voidPayment = (orderId: string, paymentId: string, reason: string) => run(convex.mutation(api.finance.voidPayment, { id: oid(orderId), paymentId, reason: reason.trim() }));

/** Возврат клиенту — только владелец. */
export const addRefund = (orderId: string, r: { amount: number; method: PaymentMethod; at?: string; reason: string }) =>
  run(convex.mutation(api.finance.addRefund, { id: oid(orderId), amount: r.amount, method: r.method, at: r.at, reason: r.reason.trim() }));

/** Выплата мастеру за выбранные заказы — только владелец. */
export const createPayout = (executorId: string, orderIds: string[], p: { method: PaymentMethod; at?: string; note?: string }) =>
  run(convex.mutation(api.payouts.create, { executorId: executorId as Id<"executors">, orderIds: orderIds.map(oid), method: p.method, at: p.at, note: p.note?.trim() || undefined }));

/** Отменить ошибочную выплату (в течение суток). */
export const undoPayout = (payoutId: string) => run(convex.mutation(api.payouts.undo, { id: payoutId as Id<"payouts"> }));
