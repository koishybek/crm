// Карточка клиента (ТЗ п.5 «Клиенты: звонки, оплаты, файлы»): оплаты — из заказов клиента, которые уже отдаёт
// clients.detail; звонки и файлы со ссылками — отдельными запросами (convex/clientRecords.ts).
import { paidAmount, refundedAmount } from "./logic";
import type { Order, PaymentMethod } from "./types";

/** Оплата или возврат клиента по одному из его заказов. */
export interface ClientPaymentRow {
  id: string;
  kind: "payment" | "refund";
  orderId: string;
  number: number;
  amount: number;
  method: PaymentMethod;
  at: string;
  /** Комментарий к оплате или причина возврата. */
  note?: string;
  /** Кто внёс оплату или оформил возврат. */
  by?: string;
  /** Сторно: платёж ошибочный и в оплаченную сумму не входит. */
  voided?: { at: string; reason?: string };
}

/** Оплаты и возвраты клиента по всем его заказам, новые сверху. Сторнированные остаются в списке с пометкой. */
export function clientPayments(orders: readonly Order[]): ClientPaymentRow[] {
  const rows: ClientPaymentRow[] = [];
  for (const o of orders) {
    for (const p of o.payments) {
      rows.push({
        id: p.id,
        kind: "payment",
        orderId: o.id,
        number: o.number,
        amount: p.amount,
        method: p.method,
        at: p.at,
        note: p.note,
        by: p.by,
        voided: p.voidedAt ? { at: p.voidedAt, reason: p.voidReason } : undefined,
      });
    }
    for (const r of o.refunds ?? []) rows.push({ id: r.id, kind: "refund", orderId: o.id, number: o.number, amount: r.amount, method: r.method, at: r.at, note: r.reason, by: r.by });
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Итоги по клиенту: получено (без сторнированных) и возвращено — те же формулы, что в заказе. */
export function clientPaymentTotals(orders: readonly Order[]): { received: number; refunded: number } {
  return { received: orders.reduce((s, o) => s + paidAmount(o), 0), refunded: orders.reduce((s, o) => s + refundedAmount(o), 0) };
}

export type ClientFileKind = "image" | "audio" | "file";

export interface ClientFile {
  id: string;
  name: string;
  kind: ClientFileKind;
  /** Подписанная ссылка на 15 минут (обновляется вместе с ответом сервера). */
  src?: string;
  /** Когда прислали — у файлов переписки. */
  at?: string;
}

/** Файлы одного заказа или одной переписки с клиентом. */
export interface ClientFileGroup {
  key: string;
  source: "order" | "chat";
  /** «Заказ №1024» или «Переписка в WhatsApp». */
  title: string;
  /** Куда ведёт заголовок: карточка заказа или диалог в «Сообщениях». */
  link: string;
  /** Дата заказа или последнего сообщения — группы идут от новых к старым. */
  at: string;
  files: ClientFile[];
}
