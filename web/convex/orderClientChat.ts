// Переписка с клиентом из карточки заказа (ТЗ п.9.12, п.16.2). Сообщение во вкладке «Клиенту» уходит клиенту в его канал —
// в последний диалог, куда можно написать сейчас (clientNotify.replyChannel: Telegram, WhatsApp в 24-часовом окне, тред OLX),
// тем же путём, что ответ из «Сообщений» (inbox.queueReply → inbox._deliver, статусы «отправлено / доставлено / ошибка»).
// Писать некуда — текст остаётся заметкой по клиенту в заказе, оператор видит «позвоните». Ответы клиента — лента
// диалогов клиента за период заказа. Только владелец и операторы: руководителю направления и мастеру переписка не видна.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { currentUser, requireRole, STAFF } from "./lib/access";
import { log, nowIso, userActor } from "./lib/domain";
import { fileSigner } from "./lib/files";
import { replyBlock } from "./lib/outbound";
import { REPLY_BLOCK } from "./lib/chat";
import { replyChannel } from "./clientNotify";
import { CHANNEL_IN, queueReply } from "./inbox";
import { NO_CHANNEL, type OrderClientMessage, type OrderClientSend, type OrderClientThread } from "../src/data/orderClientChat";

/** Сколько последних диалогов клиента смотрим. */
const RECENT_CONVERSATIONS = 20;
/** Сообщений в ленте заказа — последние. */
const MAX_MESSAGES = 200;
/** Обращение обычно начинается раньше заявки: сутки до неё — в ленте заказа. */
const BEFORE_MS = 86400_000;
/** После закрытия заказа клиент ещё отвечает на «спасибо» и просьбу оценить: трое суток — в ленте. */
const AFTER_MS = 3 * 86400_000;
/** Длина заметки, если написать некуда, — как у сообщения заказа. */
const MAX_NOTE = 4000;

async function orderSpan(ctx: QueryCtx, o: Doc<"orders">): Promise<{ from: string; to: string | null }> {
  const lead = o.leadId ? await ctx.db.get(o.leadId) : null;
  const start = [o.createdAt, lead?.createdAt].filter((x): x is string => !!x).sort()[0]!;
  return {
    from: new Date(Date.parse(start) - BEFORE_MS).toISOString(),
    to: o.closedAt ? new Date(Date.parse(o.closedAt) + AFTER_MS).toISOString() : null,
  };
}

/** Почему написать некуда: если клиент писал в WhatsApp, но окно закрылось, — так и скажем. */
async function noChannelReason(ctx: QueryCtx, recent: readonly Doc<"conversations">[]): Promise<string> {
  for (const c of recent) {
    if (c.channel === "whatsapp" && (await replyBlock(ctx, c, Date.now())) === REPLY_BLOCK.windowClosed) return `${NO_CHANNEL}: окно WhatsApp закрыто — клиент писал больше суток назад`;
  }
  return NO_CHANNEL;
}

async function recentConversations(ctx: QueryCtx, clientId: Id<"clients">): Promise<Doc<"conversations">[]> {
  return ctx.db
    .query("conversations")
    .withIndex("by_client", (q) => q.eq("clientId", clientId))
    .order("desc")
    .take(RECENT_CONVERSATIONS);
}

/** Лента переписки с клиентом для карточки заказа. Не владелец и не оператор — null (вкладка остаётся заметками). */
export const feed = query({
  args: { orderId: v.id("orders"), t: v.optional(v.number()) },
  handler: async (ctx, { orderId }): Promise<OrderClientThread | null> => {
    const me = await currentUser(ctx);
    if (!me || !STAFF.includes(me.role)) return null;
    const o = await ctx.db.get(orderId);
    if (!o) return null;
    const client = await ctx.db.get(o.clientId);
    const convs = await recentConversations(ctx, o.clientId);
    const span = await orderSpan(ctx, o);
    const rows: { m: Doc<"conversationMessages">; c: Doc<"conversations"> }[] = [];
    for (const c of convs) {
      if (c.lastMessageAt < span.from) continue;
      const list = await ctx.db
        .query("conversationMessages")
        .withIndex("by_conversation", (q) => (span.to ? q.eq("conversationId", c._id).gte("at", span.from).lte("at", span.to) : q.eq("conversationId", c._id).gte("at", span.from)))
        .order("desc")
        .take(MAX_MESSAGES);
      for (const m of list) rows.push({ m, c });
    }
    rows.sort((a, b) => (a.m.at < b.m.at ? -1 : a.m.at > b.m.at ? 1 : 0));
    const last = rows.slice(-MAX_MESSAGES);
    const names = new Map<string, string>();
    for (const { m } of last) {
      if (m.authorId && !names.has(m.authorId)) names.set(m.authorId, (await ctx.db.get(m.authorId))?.name ?? "Сотрудник");
    }
    const signer = await fileSigner(ctx);
    const messages: OrderClientMessage[] = last.map(({ m, c }) => ({
      id: m._id,
      conversationId: c._id,
      channel: c.channel,
      direction: m.direction,
      kind: m.kind,
      text: m.text,
      at: m.at,
      authorName: m.authorId ? names.get(m.authorId) : undefined,
      contactName: c.contactName ?? client?.name,
      status: m.status,
      error: m.error,
      fileUrl: signer.url(m.fileId, m.kind === "file" ? m.fileName : undefined),
      fileName: m.fileName,
    }));
    const target = client && !client.anonymizedAt ? await replyChannel(ctx, o.clientId) : null;
    return {
      target: target ? { conversationId: target._id, channel: target.channel } : null,
      blocked: target ? undefined : await noChannelReason(ctx, convs),
      dialogId: target?._id ?? convs[0]?._id,
      messages,
    };
  },
});

/**
 * Сообщение клиенту из заказа. Есть канал — в отправку (статус доставки — в ленте); нет — заметка по клиенту в заказе
 * (мастеру не видна) и причина для оператора.
 */
export const send = mutation({
  args: { orderId: v.id("orders"), text: v.string() },
  handler: async (ctx, { orderId, text }): Promise<OrderClientSend> => {
    const me = await requireRole(ctx, STAFF);
    const o = await ctx.db.get(orderId);
    if (!o) throw new ConvexError("Заказ не найден");
    const body = text.replace(/\u0000/g, "").trim();
    if (!body) throw new ConvexError("Напишите сообщение");
    const client = await ctx.db.get(o.clientId);
    const c = client && !client.anonymizedAt ? await replyChannel(ctx, o.clientId) : null;
    const actor = userActor(me._id);
    if (c) {
      await queueReply(ctx, me, c, body, { orderId });
      await log(ctx, orderId, "comment", `Сообщение клиенту ${CHANNEL_IN[c.channel]}`, actor);
      return { sent: true, channel: c.channel };
    }
    const reason = await noChannelReason(ctx, await recentConversations(ctx, o.clientId));
    await ctx.db.insert("messages", { orderId, author: actor, channel: "client", text: body.slice(0, MAX_NOTE), files: [], at: nowIso() });
    await log(ctx, orderId, "comment", "Заметка по клиенту: клиент не на связи в мессенджерах", actor);
    return { sent: false, reason };
  },
});
