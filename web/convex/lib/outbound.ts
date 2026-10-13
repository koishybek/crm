// Ответ клиенту из «Сообщений» — одно место на все каналы.
// block() — можно ли ответить сейчас (без запросов к каналу: зовётся и из запросов, чтобы интерфейс заранее выключил
// поле ответа); send() — сама отправка, только из actions; read() — оператор прочитал диалог, отметить и в канале.
// Новый канал = новый адаптер в ADAPTERS, остальной код не меняется.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Channel } from "../../src/data/types";
import { canSend as whatsappCanSend, sendWhatsApp } from "../channels/whatsapp";
import { env } from "../env";
import { tg } from "../telegram";
import { REPLY_BLOCK, whatsappWindowClosed } from "./chat";
import { OLX_MAX_TEXT } from "./olx";
import { olxReplyBlock, scheduleOlxRead, sendOlx } from "./olxApi";
import { esc } from "./tg";

export type ReplyTarget = Pick<Doc<"conversations">, "channel" | "externalId" | "contactPhone" | "replyUntil">;

/**
 * Ошибка отправки. Текст — для оператора; systemic — сломан сам канал (токен, сеть), а не конкретный чат;
 * closeWindow — канал сообщил, что окно ответа закрыто (WhatsApp: прошло 24 часа), поле ответа выключаем.
 */
export class ChannelError extends ConvexError<string> {
  constructor(
    message: string,
    readonly systemic: boolean,
    readonly closeWindow = false,
  ) {
    super(message);
  }
}

interface ChannelAdapter {
  /** Почему ответить нельзя; null — можно. */
  block(ctx: QueryCtx, c: ReplyTarget): string | null | Promise<string | null>;
  /** Отправить текст. externalId — id сообщения, уникальный в пределах канала (для статусов доставки и от дублей). */
  send(ctx: ActionCtx, c: ReplyTarget, text: string): Promise<{ externalId?: string }>;
  /** Оператор прочитал диалог — отметить прочитанным и в самом канале (если канал это умеет). */
  read?(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<void>;
  /** Предел длины ответа в канале; по умолчанию — общий предел чата. */
  maxText?: number;
}

const { notConnected: NOT_CONNECTED, callClient: CALL_CLIENT, windowClosed: WINDOW_CLOSED } = REPLY_BLOCK;

/** Ошибки Bot API → понятный оператору текст. */
function telegramError(description: string | undefined): ChannelError {
  const d = description ?? "";
  if (/blocked by the user|user is deactivated/i.test(d)) return new ChannelError("Клиент заблокировал бота — сообщение не доставлено", false);
  if (/chat not found|peer_id_invalid/i.test(d)) return new ChannelError("Чат с клиентом не найден в Telegram", false);
  if (/too many requests/i.test(d)) return new ChannelError("Telegram просит подождать — повторите через минуту", false);
  if (/unauthorized/i.test(d)) return new ChannelError("Бот отключён: проверьте токен Telegram", true);
  return new ChannelError("Telegram не принял сообщение", true);
}

const telegram: ChannelAdapter = {
  block: () => (env("TELEGRAM_BOT_TOKEN") ? null : "Telegram-бот не подключён"),
  async send(_ctx, c, text) {
    const res = await tg("sendMessage", { chat_id: c.externalId, text: esc(text), parse_mode: "HTML", disable_web_page_preview: true });
    if (!res) throw new ChannelError("Telegram не ответил — попробуйте ещё раз", true);
    if (!res.ok) throw telegramError(res.description);
    // id сообщения в Telegram уникален только внутри чата — ключ «чат:сообщение», как у входящих.
    const id = (res.result as { message_id?: number } | undefined)?.message_id;
    return { externalId: id === undefined ? undefined : `${c.externalId}:${id}` };
  },
};

/** WhatsApp Cloud API: текст — только в 24-часовом окне (channels/whatsapp.ts проверяет его и сам, без запроса к Meta). */
const whatsapp: ChannelAdapter = {
  block: () => (whatsappCanSend() ? null : NOT_CONNECTED),
  async send(_ctx, c, text) {
    const r = await sendWhatsApp(c, text);
    if (!r.ok) throw new ChannelError(r.error, r.systemic, r.closeWindow);
    return { externalId: r.wamid };
  },
};

/** OLX Partner API: ответ только в существующий тред (новый API начать не даёт); externalId диалога — uuid треда. */
const olx: ChannelAdapter = {
  block: (ctx) => olxReplyBlock(ctx),
  async send(ctx, c, text) {
    const r = await sendOlx(ctx, c.externalId, text);
    if (!r.ok) throw new ChannelError(r.error, r.systemic);
    return { externalId: r.id };
  },
  read: (ctx, conversationId) => scheduleOlxRead(ctx, conversationId),
  maxText: OLX_MAX_TEXT,
};

/** Форма сайта: обратного канала нет — только звонок. */
const site: ChannelAdapter = {
  block: () => CALL_CLIENT,
  send: () => Promise.reject(new ChannelError(CALL_CLIENT, false)),
};

const ADAPTERS: Record<Channel, ChannelAdapter> = { telegram, whatsapp, olx, site };

/** Почему нельзя ответить в этот диалог сейчас; null — можно. */
export async function replyBlock(ctx: QueryCtx, c: ReplyTarget, now: number): Promise<string | null> {
  const reason = await ADAPTERS[c.channel].block(ctx, c);
  if (reason) return reason;
  if (c.channel === "whatsapp" && whatsappWindowClosed(c.replyUntil, now)) return WINDOW_CLOSED;
  return null;
}

export function sendToChannel(ctx: ActionCtx, c: ReplyTarget, text: string): Promise<{ externalId?: string }> {
  return ADAPTERS[c.channel].send(ctx, c, text);
}

/** Предел длины ответа в канале диалога. */
export const replyMaxText = (ch: Channel, fallback: number): number => ADAPTERS[ch].maxText ?? fallback;

/** Оператор прочитал диалог — то же в канале (OLX), если канал умеет. */
export async function markChannelRead(ctx: MutationCtx, c: Pick<Doc<"conversations">, "_id" | "channel">): Promise<void> {
  await ADAPTERS[c.channel].read?.(ctx, c._id);
}
