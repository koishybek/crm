// Деньги заказа — общие правила для сервера (convex/orders.ts, convex/finance.ts, convex/payouts.ts) и интерфейса
// (ТЗ п.10, п.13): когда принимаем оплату, когда заказ «Оплачен», что мешает закрыть, кому сообщать о смене условий.
import { FINISHED_STATUSES } from "./catalog";
import { paidAmount, payout, refundedAmount } from "./logic";
import type { Order, OrderStatus } from "./types";
import { money } from "../lib/format";

/** Полученные деньги за вычетом возвратов. */
export const netReceived = (o: Pick<Order, "payments" | "refunds">) => paidAmount(o) - refundedAmount(o);

/** Где оплату не принимаем — и что ответить. В остальных статусах можно, в том числе предоплату по заказу в работе. */
export const PAYMENT_BLOCKED: Partial<Record<OrderStatus, string>> = {
  new: "Заказ ещё не передан исполнителю — оплату вносят после назначения",
  awaiting_executor: "Заказ ещё не передан исполнителю — оплату вносят после назначения",
  cancelled: "Заказ отменён — оплату по нему не принять",
  refund: "По заказу оформлен возврат — оплату по нему не принять",
};

/** Оплаченный, закрытый и возвращённый заказ: деньги в нём правит только владелец (аудит L-4). */
export const OWNER_MONEY_STATUSES: readonly OrderStatus[] = ["paid", "closed", "refund"];

/** Возврат оформляют по выполненному (в том числе оплаченному и закрытому) или отменённому заказу. */
export const REFUNDABLE_STATUSES: readonly OrderStatus[] = ["done", "awaiting_payment", "paid", "closed", "cancelled"];

/** Статусы, в которых статус по деньгам считается сам: «Ожидает оплаты» ↔ «Оплачен». */
export const SETTLED_STATUSES: readonly OrderStatus[] = ["done", "awaiting_payment", "paid"];

/**
 * Куда заказ должен перейти по деньгам, когда работа сдана: оплачено всё — «Оплачен», есть долг — «Ожидает оплаты».
 * null — статус по деньгам не пересчитывается (заказ в работе, закрыт, отменён, возврат).
 */
export function settledStatus(o: Pick<Order, "status" | "clientPrice" | "payments">): OrderStatus | null {
  if (!SETTLED_STATUSES.includes(o.status)) return null;
  return paidAmount(o) >= o.clientPrice ? "paid" : "awaiting_payment";
}

/** Выплата исполнителю проведена или проводить нечего. */
export const payoutSettled = (o: Pick<Order, "payoutPaid" | "executorId" | "clientPrice" | "payoutMode" | "payoutValue">) => o.payoutPaid || !o.executorId || payout(o) <= 0;

/** Что мешает закрыть заказ: долг клиента и непроведённая выплата. Пусто — закрыть может любой сотрудник. */
export function closeProblems(o: Pick<Order, "clientPrice" | "payments" | "payoutPaid" | "executorId" | "payoutMode" | "payoutValue">): string[] {
  const out: string[] = [];
  const owed = Math.max(0, o.clientPrice - paidAmount(o));
  if (owed > 0) out.push(`долг клиента ${money(owed)}`);
  if (!payoutSettled(o)) out.push(`выплата исполнителю ${money(payout(o))} не проведена`);
  return out;
}

/** Статусы, в которых за заказом закреплён исполнитель: смена выплаты — повод сразу ему сообщить (E7). */
export const TERMS_WATCH_STATUSES: readonly OrderStatus[] = ["assigned", "accepted", "in_progress", "awaiting_client", "done", "awaiting_payment", "paid", "closed"];

/** Статусы, где исполнитель уже принял заказ и ещё не сдал: правка срока, адреса или описания — ему с разницей. */
export const INFO_WATCH_STATUSES: readonly OrderStatus[] = ["accepted", "in_progress", "awaiting_client"];

// ── Выплаты исполнителям ─────────────────────────────────────────────────────

/** Сколько времени после проведения выплату ещё можно отменить. */
export const PAYOUT_UNDO_MS = 24 * 3600_000;
/** Заказов в одной выплате — не больше. */
export const PAYOUT_MAX_ORDERS = 100;

/** Заказ ждёт выплаты мастеру: работа сдана, исполнитель есть, выплата не проведена. */
export const isPayoutDue = (o: Pick<Order, "status" | "payoutPaid" | "executorId" | "clientPrice" | "payoutMode" | "payoutValue">) =>
  FINISHED_STATUSES.includes(o.status) && !!o.executorId && !o.payoutPaid && payout(o) > 0;

// ── Даты денег ───────────────────────────────────────────────────────────────

/** Алматы живёт по UTC+5 круглый год. */
const ALMATY_MS = 5 * 3600_000;

/** «2026-10-13» — сегодняшний день по Алматы, для поля даты. */
export const almatyDateInput = (t: number): string => new Date(t + ALMATY_MS).toISOString().slice(0, 10);

/**
 * Дата из поля «Дата оплаты» → момент для сервера: сегодня — «сейчас», прошедший день — полдень по Алматы
 * (чтобы оплата попала в свой день отчёта в любом часовом поясе). Пусто или мусор — null.
 */
export function moneyMoment(day: string, now = Date.now()): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (day === almatyDateInput(now)) return new Date(now).toISOString();
  const t = Date.parse(`${day}T12:00:00+05:00`);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
