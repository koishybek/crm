// Деньги заказа на сервере: проверки сумм и дат, статус по оплате, сдача работы, сообщение исполнителю о смене выплаты.
// Сами правила (когда «Оплачен», что мешает закрыть) — общие с интерфейсом: src/data/money.ts.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "./functions";
import { orderNotice } from "../clientNotify";
import { almatyStamp } from "./audit";
import { executorUser, log, notify, nowIso, setStatus, uid, type StatusMove } from "./domain";
import { PAYMENT_METHODS } from "../../src/data/catalog";
import { cleanMoney, cleanText } from "./limits";
import { refreshStats } from "./stats90";
import { almatyDayStart } from "./tg";
import { emitEvent } from "./webhookEvents";
import { paidAmount } from "../../src/data/logic";
import { settledStatus, TERMS_WATCH_STATUSES } from "../../src/data/money";
import type { Actor, OrderStatus } from "../../src/data/types";
import { money } from "../../src/lib/format";

/** Автоматические переходы по деньгам делает система, а не тот, кто внёс оплату. */
const SYSTEM: Actor = { type: "system" };
/** Часы браузера и сервера могут расходиться на минуты: «сейчас» из браузера будущим не считаем. */
const CLOCK_SKEW_MS = 10 * 60_000;
/** Комментарий к оплате, причина сторно, возврата и закрытия — не длиннее. */
export const NOTE_MAX = 300;

/** Сумма денежной операции: конечное число больше нуля, в целых тенге (аудит L-4: Infinity и NaN — отказ). */
export function positiveMoney(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new ConvexError(`${label}: сумма должна быть больше нуля`);
  const amount = cleanMoney(value, label);
  if (amount < 1) throw new ConvexError(`${label}: сумма должна быть больше нуля`);
  return amount;
}

/**
 * Дата денежной операции. Не передана — «сейчас». Задним числом можно, но не в будущее и не раньше дня
 * создания заказа по Алматы: иначе деньги попали бы в чужой период отчёта.
 */
export function moneyDate(input: string | undefined, label: string, notBefore?: string): string {
  if (input === undefined) return nowIso();
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new ConvexError(`${label}: неверная дата`);
  if (t > Date.now() + CLOCK_SKEW_MS) throw new ConvexError(`${label}: дата не может быть в будущем`);
  if (notBefore && t < almatyDayStart(Date.parse(notBefore))) throw new ConvexError(`${label}: дата раньше создания заказа`);
  return new Date(t).toISOString();
}

/** Обязательная причина: сторно, возврат, закрытие с долгом. */
export function reasonText(value: string | undefined, label: string): string {
  const s = cleanText(value ?? "", NOTE_MAX, label);
  if (s.length < 3) throw new ConvexError(`${label}: укажите причину`);
  return s;
}

/** Необязательный комментарий: пустой — нет комментария. */
export function noteText(value: string | undefined, label: string): string | undefined {
  return cleanText(value ?? "", NOTE_MAX, label) || undefined;
}

/** Самое позднее движение денег по заказу — по нему индекс by_money находит заказы с оплатами за период. */
export const laterMoment = (current: string | undefined, at: string): string => (current && current > at ? current : at);

/**
 * Статус по деньгам (ТЗ п.10): работа сдана и есть долг — «Ожидает оплаты», оплачено всё — «Оплачен».
 * Зовётся после сдачи работы и после любой правки цены, оплаты или сторно. Возвращает переход, если он был.
 */
export async function settle(ctx: MutationCtx, o: Doc<"orders">): Promise<StatusMove | null> {
  const to = settledStatus(o);
  if (!to || to === o.status) return null;
  const owed = Math.max(0, o.clientPrice - paidAmount(o));
  const text = to === "paid" ? "Оплачен: клиент оплатил заказ полностью" : `Ожидает оплаты: долг клиента ${money(owed)}`;
  await setStatus(ctx, o, to, SYSTEM, text, to === "paid" ? {} : { paidAt: undefined });
  if (to === "paid") await emitEvent(ctx, "order.paid", { orderId: o._id });
  return { from: o.status, to };
}

export interface PaymentInput {
  amount: number;
  method: Doc<"orders">["payments"][number]["method"];
  at: string;
  by?: Id<"users">;
  note?: string;
}

export interface RecordedPayment {
  payment: Doc<"orders">["payments"][number];
  /** Оплачено всего после этой оплаты. */
  paid: number;
  /** Переплата сверх цены (0 — нет). */
  over: number;
  settled: StatusMove | null;
  /** «Kaspi, дата оплаты …, переплата …» — для истории и журнала. */
  details: string[];
}

/**
 * Оплата в заказе — один путь для сотрудника («Внести оплату») и для онлайн-оплаты по уведомлению провайдера
 * (payments.ts, автор — «Система»): запись платежа, история заказа, статус по деньгам (settle). Проверки, кто и когда
 * может вносить оплату, — у вызывающего.
 */
export async function recordPayment(ctx: MutationCtx, o: Doc<"orders">, input: PaymentInput, actor: Actor): Promise<RecordedPayment> {
  const paid = paidAmount(o) + input.amount;
  const over = Math.max(0, paid - o.clientPrice);
  const payment = { id: uid("p"), amount: input.amount, method: input.method, at: input.at, ...(input.by ? { by: input.by } : {}), ...(input.note ? { note: input.note } : {}) };
  await ctx.db.patch(o._id, { payments: [...o.payments, payment], moneyAt: laterMoment(o.moneyAt, input.at) });
  const backdated = Math.abs(Date.now() - Date.parse(input.at)) > 10 * 60_000;
  const details = [PAYMENT_METHODS[input.method], ...(backdated ? [`дата оплаты ${almatyStamp(input.at)}`] : []), ...(over > 0 ? [`переплата ${money(over)}`] : [])];
  await log(ctx, o._id, "payment", `Внесена оплата ${money(input.amount)} (${details.join(", ")})`, actor);
  const settled = await settle(ctx, (await ctx.db.get(o._id))!);
  return { payment, paid, over, settled, details };
}

/**
 * Работа сдана (мастер нажал «Работа выполнена» или сотрудник перевёл в «Выполнен»): «Выполнен», клиенту —
 * «заказ выполнен» (один раз на заказ), и сразу статус по деньгам. Возвращает итоговый статус и авто-переход.
 */
export async function finishWork(ctx: MutationCtx, o: Doc<"orders">, actor: Actor, text?: string): Promise<{ status: OrderStatus; settled: StatusMove | null }> {
  await setStatus(ctx, o, "done", actor, text);
  // Событие «выполнен» отправляем явно: через мгновение статус уже «Ожидает оплаты» или «Оплачен».
  await orderNotice(ctx, o._id, "done");
  // Сдача работы — в историю мастера за 90 дней (ТЗ п.12.6): вовремя ли и сколько заняло.
  await refreshStats(ctx, o.executorId);
  const fresh = (await ctx.db.get(o._id))!;
  const settled = await settle(ctx, fresh);
  return { status: settled?.to ?? fresh.status, settled };
}

/**
 * Выплату поменяли, когда заказ уже за исполнителем (E7): ему — колокольчик и Telegram «было → стало».
 * true — сообщили.
 */
export async function notifyPayoutChange(ctx: MutationCtx, o: Doc<"orders">, before: number, after: number): Promise<boolean> {
  if (!o.executorId || before === after || !TERMS_WATCH_STATUSES.includes(o.status)) return false;
  const u = await executorUser(ctx, o.executorId);
  if (!u || u.active === false) return false;
  await notify(ctx, [u._id], `Выплата по заказу №${o.number} изменена: ${money(before)} → ${money(after)}`, { link: `/w/orders/${o._id}`, tone: "warn" });
  return true;
}
