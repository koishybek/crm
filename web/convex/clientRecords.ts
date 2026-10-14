// Карточка клиента (ТЗ п.5 «Клиенты: звонки, файлы»): звонки клиента с записями и файлы его заказов и переписки.
// Только владельцу и операторам — как и сама клиентская база. Ссылки на записи и файлы — подписанные, на 15 минут
// (lib/files.ts); t — метка их обновления (src/data/files.ts).
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { query } from "./lib/functions";
import { can, noAccess, requirePerm } from "./lib/access";
import { toCall } from "./lib/dto";
import { fileSigner } from "./lib/files";
import type { ClientFile, ClientFileGroup, ClientFileKind } from "../src/data/clientRecords";
import { SOURCES } from "../src/data/catalog";
import type { Call } from "../src/data/types";

/** Последних звонков клиента в карточке. */
const CALLS_MAX = 50;
/** Файлы — из стольких последних заказов и диалогов клиента, сообщений диалога — не больше. */
const FILE_ORDERS = 50;
const FILE_CHATS = 10;
const CHAT_MESSAGES = 300;
/** Всего файлов в ответе. */
const FILES_MAX = 300;

/** Номер клиента в звонке: у входящего — кто звонил, у исходящего — кому. */
const clientNumber = (c: Pick<Doc<"calls">, "direction" | "from" | "to">) => (c.direction === "in" ? c.from : c.to);
const newestFirst = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);

/**
 * Звонки клиента, новые сверху: привязанные к карточке и пришедшие с его номера раньше, чем клиента завели
 * (у них нет карточки). Запись — по подписанной ссылке, с расшифровкой и разбором AI.
 */
export const calls = query({
  args: { clientId: v.id("clients"), t: v.optional(v.number()) },
  handler: async (ctx, { clientId }): Promise<Call[] | null> => {
    const me = await requirePerm(ctx, "clients.view");
    if (!can(me, "calls.view")) throw new ConvexError(noAccess("calls.view"));
    const c = await ctx.db.get(clientId);
    if (!c) return null;
    const linked = await ctx.db
      .query("calls")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .order("desc")
      .take(CALLS_MAX);
    // У обезличенного клиента в поле телефона — заглушка: по номеру не ищем.
    const byNumber = c.anonymizedAt
      ? []
      : [
          ...(await ctx.db
            .query("calls")
            .withIndex("by_from", (q) => q.eq("from", c.phone))
            .order("desc")
            .take(CALLS_MAX)),
          ...(await ctx.db
            .query("calls")
            .withIndex("by_to", (q) => q.eq("to", c.phone))
            .order("desc")
            .take(CALLS_MAX)),
        ].filter((x) => !x.clientId && clientNumber(x) === c.phone);
    const seen = new Set<string>();
    const rows = [...linked, ...byNumber]
      .filter((x) => (seen.has(x._id) ? false : (seen.add(x._id), true)))
      .sort((a, b) => newestFirst(a.startedAt, b.startedAt))
      .slice(0, CALLS_MAX);
    const signer = await fileSigner(ctx);
    return rows.map((x) => toCall(x, signer));
  },
});

const chatKind = (kind: Doc<"conversationMessages">["kind"]): ClientFileKind => (kind === "image" ? "image" : kind === "audio" ? "audio" : "file");
const CHAT_FILE_NAME: Record<ClientFileKind, string> = { image: "Фото", audio: "Голосовое сообщение", file: "Файл" };

/**
 * Файлы клиента по группам: каждого заказа (вложения переписки по заказу и фотоотчёт мастера) и каждой переписки
 * в «Сообщениях» (что клиент прислал и что ему отправили). Группы — от новых к старым.
 */
export const files = query({
  args: { clientId: v.id("clients"), t: v.optional(v.number()) },
  handler: async (ctx, { clientId }): Promise<ClientFileGroup[] | null> => {
    await requirePerm(ctx, "clients.view");
    const c = await ctx.db.get(clientId);
    if (!c) return null;
    const signer = await fileSigner(ctx);
    const groups: ClientFileGroup[] = [];
    let total = 0;
    const take = (files: ClientFile[]) => {
      const room = Math.max(0, FILES_MAX - total);
      total += Math.min(room, files.length);
      return files.slice(0, room);
    };

    const orders = await ctx.db
      .query("orders")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .order("desc")
      .take(FILE_ORDERS);
    for (const o of orders) {
      const list = take(
        o.files
          .filter((f) => f.storageId !== undefined)
          .map((f): ClientFile => ({ id: f.id, name: f.name, kind: f.kind, src: signer.url(f.storageId, f.kind === "file" ? f.name : undefined) })),
      );
      if (list.length) groups.push({ key: `order:${o._id}`, source: "order", title: `Заказ №${o.number}`, link: `/orders/${o._id}`, at: o.createdAt, files: list });
    }

    const chats = await ctx.db
      .query("conversations")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .order("desc")
      .take(FILE_CHATS);
    for (const chat of chats) {
      const messages = await ctx.db
        .query("conversationMessages")
        .withIndex("by_conversation", (q) => q.eq("conversationId", chat._id))
        .order("desc")
        .take(CHAT_MESSAGES);
      const list = take(
        messages
          .filter((m) => m.fileId !== undefined)
          .map((m): ClientFile => {
            const kind = chatKind(m.kind);
            return { id: m._id, name: m.fileName || CHAT_FILE_NAME[kind], kind, src: signer.url(m.fileId, kind === "file" ? m.fileName : undefined), at: m.at };
          }),
      );
      if (list.length) groups.push({ key: `chat:${chat._id}`, source: "chat", title: `Переписка в ${SOURCES[chat.channel].label}`, link: `/inbox?c=${chat._id}`, at: chat.lastMessageAt, files: list });
    }
    return groups.sort((a, b) => newestFirst(a.at, b.at));
  },
});
