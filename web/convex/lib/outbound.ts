// Ответ клиенту из «Сообщений» — одно место на все каналы.
// block() — можно ли ответить сейчас (без сети: зовётся и из запросов, чтобы интерфейс заранее выключил поле ответа);
// send() — сама отправка, только из actions. Новый канал = новый адаптер в ADAPTERS, остальной код не меняется.
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { Channel } from "../../src/data/types";
import { env } from "../env";
import { tg } from "../telegram";
import { REPLY_BLOCK, whatsappWindowClosed } from "./chat";
import { esc } from "./tg";

export type ReplyTarget = Pick<Doc<"conversations">, "channel" | "externalId" | "contactPhone" | "replyUntil">;

/** Ошибка отправки. Текст — для оператора; systemic — сломан сам канал (токен, сеть), а не конкретный чат. */
export class ChannelError extends ConvexError<string> {
  constructor(
    message: string,
    readonly systemic: boolean,
  ) {
    super(message);
  }
}

interface ChannelAdapter {
  /** Почему ответить нельзя; null — можно. */
  block(c: ReplyTarget): string | null;
  /** Отправить текст. externalId — id сообщения, уникальный в пределах канала (для статусов доставки). */
  send(c: ReplyTarget, text: string): Promise<{ externalId?: string }>;
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
  async send(c, text) {
    const res = await tg("sendMessage", { chat_id: c.externalId, text: esc(text), parse_mode: "HTML", disable_web_page_preview: true });
    if (!res) throw new ChannelError("Telegram не ответил — попробуйте ещё раз", true);
    if (!res.ok) throw telegramError(res.description);
    // id сообщения в Telegram уникален только внутри чата — ключ «чат:сообщение», как у входящих.
    const id = (res.result as { message_id?: number } | undefined)?.message_id;
    return { externalId: id === undefined ? undefined : `${c.externalId}:${id}` };
  },
};

/** Канал, отправку в который подключает следующий этап (WhatsApp Cloud API, OLX Partner API). */
const pending: ChannelAdapter = {
  block: () => NOT_CONNECTED,
  send: () => Promise.reject(new ChannelError(NOT_CONNECTED, false)),
};

/** Форма сайта: обратного канала нет — только звонок. */
const site: ChannelAdapter = {
  block: () => CALL_CLIENT,
  send: () => Promise.reject(new ChannelError(CALL_CLIENT, false)),
};

const ADAPTERS: Record<Channel, ChannelAdapter> = { telegram, whatsapp: pending, olx: pending, site };

/** Почему нельзя ответить в этот диалог сейчас; null — можно. */
export function replyBlock(c: ReplyTarget, now: number): string | null {
  const reason = ADAPTERS[c.channel].block(c);
  if (reason) return reason;
  if (c.channel === "whatsapp" && whatsappWindowClosed(c.replyUntil, now)) return WINDOW_CLOSED;
  return null;
}

export function sendToChannel(c: ReplyTarget, text: string): Promise<{ externalId?: string }> {
  return ADAPTERS[c.channel].send(c, text);
}
