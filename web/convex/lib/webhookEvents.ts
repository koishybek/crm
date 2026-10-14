// События для исходящих вебхуков (ТЗ п.20.7, п.26.7): emitEvent(ctx, тип, ссылка) зовётся одной строкой там, где событие
// происходит (приём заявки, смена статуса, оплата, отзыв), в той же транзакции. Подписок на событие нет — ничего не делаем.
// Тело события — без персональных данных и денег: номера, статусы, услуга, город, даты, метки рекламы.
// Отправка, подпись и повторы — convex/webhooks.ts.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "./functions";
import { hmacSha256Hex, randomToken, safeEqual } from "./crypto";
import type { LeadStatus, OrderStatus } from "../../src/data/types";
import type { WebhookEvent, WebhookEventOrTest } from "../../src/data/webhookEvents";

/** Что передаёт место события: ссылку на документ (и прежний статус); тело события собирается здесь. */
export interface EventPayloads {
  "lead.created": { leadId: Id<"leads"> };
  "lead.status_changed": { leadId: Id<"leads">; from: LeadStatus };
  "order.created": { orderId: Id<"orders"> };
  "order.status_changed": { orderId: Id<"orders">; from: OrderStatus };
  "order.paid": { orderId: Id<"orders"> };
  "review.created": { reviewId: Id<"reviews"> };
}

type Data = Record<string, unknown>;

/** Заявка наружу: без имени, телефона, адреса, бюджета и текста клиента. */
function leadData(l: Doc<"leads">): Data {
  return {
    number: l.number,
    status: l.status,
    source: l.source,
    origin: l.origin ?? "operator",
    serviceId: l.serviceId,
    city: l.city,
    createdAt: l.createdAt,
    ...(l.orderId ? { orderNumber: l.number } : {}),
    ...(l.utm ? { utm: l.utm } : {}),
    ...(l.campaign ? { campaign: l.campaign } : {}),
  };
}

/** Заказ наружу: статус и даты; без клиента, адреса, цены и выплаты. */
export function orderData(o: Doc<"orders">): Data {
  return {
    number: o.number,
    status: o.status,
    serviceId: o.serviceId,
    category: o.category,
    city: o.city,
    createdAt: o.createdAt,
    deadline: o.deadline,
    ...(o.doneAt ? { doneAt: o.doneAt } : {}),
    ...(o.paidAt ? { paidAt: o.paidAt } : {}),
    ...(o.closedAt ? { closedAt: o.closedAt } : {}),
    ...(o.leadId ? { leadNumber: o.number } : {}),
    ...(o.utm ? { utm: o.utm } : {}),
    ...(o.campaign ? { campaign: o.campaign } : {}),
  };
}

async function eventData<E extends WebhookEvent>(ctx: MutationCtx, p: EventPayloads[E]): Promise<Data | null> {
  if ("leadId" in p) {
    const l = await ctx.db.get(p.leadId);
    return l ? { ...leadData(l), ...("from" in p ? { previousStatus: p.from } : {}) } : null;
  }
  if ("orderId" in p) {
    const o = await ctx.db.get(p.orderId);
    return o ? { ...orderData(o), ...("from" in p ? { previousStatus: p.from } : {}) } : null;
  }
  const r = await ctx.db.get(p.reviewId);
  const o = r ? await ctx.db.get(r.orderId) : null;
  return r && o ? { orderNumber: o.number, rating: r.rating, via: r.via, hasComment: !!r.text, createdAt: r.at } : null;
}

/** Поставить событие в отправку подписчикам: одна доставка на подписку, отправка — после коммита. */
export async function enqueueEvent(ctx: MutationCtx, subs: readonly Doc<"webhooks">[], type: WebhookEventOrTest, data: Data, test = false): Promise<Id<"webhookDeliveries">[]> {
  const createdAt = new Date().toISOString();
  const eventId = `evt_${randomToken(16)}`;
  const body = JSON.stringify({ id: eventId, type, createdAt, data });
  const ids: Id<"webhookDeliveries">[] = [];
  for (const w of subs) {
    const id = await ctx.db.insert("webhookDeliveries", { webhookId: w._id, event: type, eventId, body, status: "pending", attempts: 0, createdAt, ...(test ? { test: true } : {}) });
    await ctx.scheduler.runAfter(0, internal.webhooks._deliver, { deliveryId: id });
    ids.push(id);
  }
  return ids;
}

/** Событие → подписчикам. Возвращает, сколько доставок поставлено (0 — никто не подписан). */
export async function emitEvent<E extends WebhookEvent>(ctx: MutationCtx, type: E, payload: EventPayloads[E]): Promise<number> {
  const subs = (
    await ctx.db
      .query("webhooks")
      .withIndex("by_active", (q) => q.eq("active", true))
      .collect()
  ).filter((w) => w.events.includes(type));
  if (!subs.length) return 0;
  const data = await eventData<E>(ctx, payload);
  return data ? (await enqueueEvent(ctx, subs, type, data)).length : 0;
}

// ── Подпись ──────────────────────────────────────────────────────────────────

/**
 * Заголовок X-HMS-Signature: «t=<unix-секунды>,v1=<hex HMAC-SHA256(секрет, "<t>.<тело>")>». Время входит в подпись:
 * получатель отвергает подписи старше 5 минут, а повтор с подменённым временем подпись не пройдёт.
 */
export const signatureHeader = (secret: string, body: string, t: number): string => `t=${t},v1=${hmacSha256Hex(secret, `${t}.${body}`)}`;

/** Проверка подписи на стороне получателя (пример в OpenAPI и тестах): верная подпись и свежее время. */
export function verifySignature(secret: string, body: string, header: string, nowSec: number, toleranceSec: number): boolean {
  const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isSafeInteger(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  return safeEqual(parts.v1, hmacSha256Hex(secret, `${t}.${body}`));
}
