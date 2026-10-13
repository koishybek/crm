// Сообщения клиенту о его заказе (ТЗ п.18): мастер и время приезда, работа выполнена (с просьбой оценить), заказ отменён.
// Пишем туда, где клиент на связи: в его последний диалог, куда можно отправить прямо сейчас, — Telegram, WhatsApp
// (только в 24-часовом окне) или тред OLX. Уходит тем же путём, что ответ оператора из «Сообщений» (inbox._deliver),
// автоматическим сообщением (kind "system"). Владелец выключает это в «Настройках». Каждое событие — не больше раза.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { audit, lowerFirst } from "./lib/audit";
import { log, nowIso } from "./lib/domain";
import { channelReady, replyBlock } from "./lib/outbound";
import { whenAlmaty, type TgButton } from "./lib/tg";
import { CHANNEL_IN } from "./inbox";
import { issueReviewLink, submitFromChannel } from "./reviews";
import { env } from "./env";
import { APP_NAME } from "../src/data/catalog";
import { CLIENT_NOTICE_LABEL, type ClientNoticeEvent, type ClientNotifySettings } from "../src/data/notifyRules";
import { isReviewable } from "../src/data/reviews";
import type { Channel } from "../src/data/types";
import { firstName } from "../src/lib/format";

/** Настройка владельца: "off" — не писать клиентам; нет записи — пишем (по умолчанию включено). */
const SETTING = "clientNotify";
/** Сколько последних диалогов клиента перебираем в поисках канала, куда можно написать. */
const RECENT_CONVERSATIONS = 20;

async function settingRow(ctx: QueryCtx): Promise<Doc<"settings"> | null> {
  return ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", SETTING))
    .unique();
}

const isOn = (row: Doc<"settings"> | null): boolean => row?.value !== "off";

/** Последний диалог клиента, куда можно написать прямо сейчас. Форма сайта и закрытое окно WhatsApp — не в счёт. */
export async function replyChannel(ctx: QueryCtx, clientId: Id<"clients">, now = Date.now()): Promise<Doc<"conversations"> | null> {
  const recent = await ctx.db
    .query("conversations")
    .withIndex("by_client", (q) => q.eq("clientId", clientId))
    .order("desc")
    .take(RECENT_CONVERSATIONS);
  for (const c of recent) if (!(await replyBlock(ctx, c, now))) return c;
  return null;
}

export interface ClientMessage {
  text: string;
  /** Кнопки под сообщением — только в Telegram. */
  buttons?: TgButton[][];
}

export type ToClientResult =
  | { queued: true; channel: Channel; conversationId: Id<"conversations">; messageId: Id<"conversationMessages"> }
  | { queued: false; reason: "off" | "sent" | "no_channel" };

/**
 * Сообщение клиенту в его последний доступный канал. message — текст или его сборка под выбранный канал (ссылку в OLX
 * не шлём, звёзды — только в Telegram). once — ключ события: с ним сообщение уходит не больше одного раза.
 * Возвращает, поставлено ли сообщение в отправку; итог доставки — в «Сообщениях», как у ответа оператора.
 */
export async function toClient(
  ctx: MutationCtx,
  clientId: Id<"clients">,
  message: string | ((channel: Channel) => ClientMessage | Promise<ClientMessage>),
  opts: { once?: string } = {},
): Promise<ToClientResult> {
  if (!isOn(await settingRow(ctx))) return { queued: false, reason: "off" };
  const once = opts.once;
  if (
    once &&
    (await ctx.db
      .query("clientNotices")
      .withIndex("by_key", (q) => q.eq("key", once))
      .first())
  ) {
    return { queued: false, reason: "sent" };
  }
  const c = await replyChannel(ctx, clientId);
  if (!c) return { queued: false, reason: "no_channel" };
  const m = typeof message === "string" ? { text: message } : await message(c.channel);
  const at = nowIso();
  // Как автоответ бота: в ленте диалога, но превью и «непрочитанные» не трогаем — клиент нам ничего не писал.
  const messageId = await ctx.db.insert("conversationMessages", { conversationId: c._id, direction: "out", kind: "system", text: m.text, at, status: "sending" });
  if (once) await ctx.db.insert("clientNotices", { key: once, clientId, conversationId: c._id, messageId, at });
  const buttons = c.channel === "telegram" && m.buttons?.length ? m.buttons : undefined;
  await ctx.scheduler.runAfter(0, internal.inbox._deliver, { messageId, buttons });
  return { queued: true, channel: c.channel, conversationId: c._id, messageId };
}

// ── События заказа ───────────────────────────────────────────────────────────

/** «сегодня до 14:00», «завтра до 10:00», «15 окт. до 12:00» по Алматы; срок уже прошёл — null. */
function arrival(deadline: string, now: number): string | null {
  const t = Date.parse(deadline);
  if (!Number.isFinite(t) || t <= now) return null;
  const [day, time] = whenAlmaty(deadline, now).split(", ");
  return day && time ? `${day.toLowerCase()} до ${time}` : null;
}

/** Звёзды под «Заказ выполнен»: rv:<заказ>:<оценка> — обработчик в telegram.ts. */
const stars = (orderId: Id<"orders">): TgButton[][] => [[1, 2, 3, 4, 5].map((n) => ({ text: `⭐${n}`, data: `rv:${orderId}:${n}` }))];

const isRated = async (ctx: QueryCtx, orderId: Id<"orders">): Promise<boolean> =>
  !!(await ctx.db
    .query("reviews")
    .withIndex("by_order", (q) => q.eq("orderId", orderId))
    .first());

/** Ссылка на оценку для клиента; без APP_URL её не открыть — тогда и не создаём. */
async function ratingLink(ctx: MutationCtx, o: Doc<"orders">): Promise<string | null> {
  if (!env("APP_URL")) return null;
  const { url } = await issueReviewLink(ctx, o, "Система");
  return /^https?:\/\//.test(url) ? url : null;
}

/** Текст под событие и канал. Клиенту — номер заказа, имя мастера и время; без цен, выплат и телефона мастера. */
async function noticeMessage(ctx: MutationCtx, o: Doc<"orders">, event: ClientNoticeEvent, ch: Channel): Promise<ClientMessage> {
  if (event === "cancelled") return { text: `Заказ №${o.number} отменён. Если это ошибка или понадобится помощь — напишите нам сюда.` };
  if (event === "master") {
    const ex = o.executorId ? await ctx.db.get(o.executorId) : null;
    const who = ex ? `мастер ${firstName(ex.name)}` : "мастер";
    const when = arrival(o.deadline, Date.now());
    return { text: when ? `Заказ №${o.number}: ${who} приедет ${when}. Если планы изменятся — просто напишите сюда.` : `Заказ №${o.number}: ${who} уже взялся за работу и скоро свяжется с вами.` };
  }
  const thanks = `Заказ №${o.number} выполнен — спасибо, что выбрали ${APP_NAME}!`;
  // В переписку OLX ссылок не шлём; оценённый заказ второй раз не оценить.
  if (ch === "olx" || !isReviewable(o) || (await isRated(ctx, o._id))) return { text: thanks };
  const link = await ratingLink(ctx, o);
  if (ch === "telegram") return { text: `${thanks}\nОцените, пожалуйста, работу мастера — нажмите на звезду ниже.${link ? `\nОтзыв с комментарием: ${link}` : ""}`, buttons: stars(o._id) };
  return { text: link ? `${thanks}\nОцените, пожалуйста, работу мастера: ${link}` : thanks };
}

function noticeEvent(o: Doc<"orders">): ClientNoticeEvent | null {
  if (o.status === "accepted" && o.executorId) return "master";
  if (o.status === "done") return "done";
  if (o.status === "cancelled") return "cancelled";
  return null;
}

/**
 * Событие заказа → сообщение клиенту. Зовётся одной строкой в конце мутаций, меняющих статус (orders.ts, worker.ts);
 * что писать, решает статус: «Принят исполнителем» — мастер и время, «Выполнен» — спасибо и оценка, «Отменён».
 * Ключ события «мастер» — с мастером: если заказ перешёл к другому, клиент узнает, кто приедет на самом деле.
 * event — событие задано явно: сдача работы (lib/money.ts finishWork), после которой статус сразу уходит дальше по деньгам.
 */
export async function orderNotice(ctx: MutationCtx, orderId: Id<"orders">, forced?: ClientNoticeEvent): Promise<ToClientResult | null> {
  const o = await ctx.db.get(orderId);
  const event = o ? (forced ?? noticeEvent(o)) : null;
  if (!o || !event) return null;
  const once = event === "master" ? `order:${o._id}:master:${o.executorId}` : `order:${o._id}:${event}`;
  const r = await toClient(ctx, o.clientId, (ch) => noticeMessage(ctx, o, event, ch), { once });
  if (!r.queued) return r;
  const what = `Клиенту отправлено ${CHANNEL_IN[r.channel]}: ${CLIENT_NOTICE_LABEL[event]}`;
  await log(ctx, o._id, "comment", what, { type: "system" });
  await audit(ctx, "Система", "order.clientNotice", `Заказ №${o.number}: ${lowerFirst(what)}`, { entityId: o._id, meta: { event, channel: r.channel, conversationId: r.conversationId } });
  return r;
}

// ── Оценка звёздами в Telegram ───────────────────────────────────────────────

export type TelegramRating = { ok: true } | { ok: false; error: string; /** Заказ уже оценён — звёзды можно убрать. */ rated: boolean };

/** Звезда под «Заказ выполнен». Оценка — только из чата клиента этого заказа: чужой чат (подделанная кнопка) — отказ. */
export const _rateFromTelegram = internalMutation({
  args: { chatId: v.string(), orderId: v.string(), rating: v.number() },
  handler: async (ctx, a): Promise<TelegramRating> => {
    const id = ctx.db.normalizeId("orders", a.orderId);
    const o = id ? await ctx.db.get(id) : null;
    const conv = await ctx.db
      .query("conversations")
      .withIndex("by_channel_external", (q) => q.eq("channel", "telegram").eq("externalId", a.chatId))
      .unique();
    if (!o || !conv?.clientId || conv.clientId !== o.clientId) return { ok: false, error: "Оценить этот заказ можно только из чата клиента, который его оформил", rated: false };
    const r = await submitFromChannel(ctx, { orderId: o._id, rating: a.rating, via: "telegram" });
    if (!r.ok) return { ok: false, error: r.error, rated: await isRated(ctx, o._id) };
    // Оператору в «Сообщениях» видно, что клиент ответил на просьбу об оценке.
    await ctx.db.insert("conversationMessages", { conversationId: conv._id, direction: "in", kind: "system", text: `Клиент оценил работу: ${a.rating}★`, at: nowIso() });
    return { ok: true };
  },
});

// ── Настройка владельца ──────────────────────────────────────────────────────

/** Карточка «Уведомления клиентам»: включено ли и в какие каналы сейчас можно писать. */
export const settings = query({
  args: {},
  handler: async (ctx): Promise<ClientNotifySettings> => {
    await requireRole(ctx, OWNER);
    const [row, telegram, whatsapp, olx] = await Promise.all([settingRow(ctx), channelReady(ctx, "telegram"), channelReady(ctx, "whatsapp"), channelReady(ctx, "olx")]);
    return { enabled: isOn(row), channels: { telegram, whatsapp, olx } };
  },
});

export const setEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const row = await settingRow(ctx);
    if (isOn(row) === enabled) return;
    const value = enabled ? "on" : "off";
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key: SETTING, value });
    await audit(ctx, me, "settings.clientNotify", `${enabled ? "Включены" : "Выключены"} автоматические сообщения клиентам о заказах`, { meta: { enabled } });
  },
});
