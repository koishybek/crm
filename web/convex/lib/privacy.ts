// Обезличивание клиента по его запросу (ТЗ п.26, Закон РК «О персональных данных и их защите»).
// Удаляется всё, по чему можно узнать человека: имя, телефон, email, адрес, заметки и теги, записи звонков
// и расшифровки, AI-разборы, тексты и файлы переписки, комментарии о нём. Остаются номера заявок и заказов,
// услуги, даты, статусы и деньги — для отчётности и рейтинга мастеров.
// Журнал действий не переписывается: это юридически значимая история действий сотрудников.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "./functions";
import { ACTIVE_STATUSES } from "../../src/data/catalog";
import { nowIso } from "./domain";
import { dropFile } from "./files";

export const ANON_NAME = "Клиент удалён";
export const ERASED_TEXT = "Удалено по запросу клиента";

/**
 * Телефон-заглушка «7000XXXXXXX»: кода +7 000 нет ни в Казахстане, ни в России — никуда не дозвонится,
 * но проходит проверки формата и уникален в индексе by_phone.
 */
const PLACEHOLDER_PREFIX = "7000";
const PLACEHOLDER_COUNTER = "anonymizedClients";

const OPEN_LEAD: ReadonlySet<Doc<"leads">["status"]> = new Set(["new", "qualifying", "waiting"]);

export interface ErasedCounts {
  leads: number;
  orders: number;
  calls: number;
  recordings: number;
  conversations: number;
  messages: number;
  files: number;
  notes: number;
  interactions: number;
  reviews: number;
}

async function placeholderPhone(ctx: MutationCtx): Promise<string> {
  const row = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", PLACEHOLDER_COUNTER))
    .unique();
  let n = row?.value ?? 0;
  let phone: string;
  do {
    n += 1;
    phone = `${PLACEHOLDER_PREFIX}${String(n).padStart(7, "0")}`;
  } while (
    await ctx.db
      .query("clients")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first()
  );
  if (row) await ctx.db.patch(row._id, { value: n });
  else await ctx.db.insert("counters", { name: PLACEHOLDER_COUNTER, value: n });
  return phone;
}

/**
 * Обезличить нельзя, пока с клиентом идёт работа: мастер едет по адресу, оператор ждёт ответа.
 * Сначала заказы завершают или отменяют, заявки — закрывают.
 */
export function assertCanErase(leads: readonly Doc<"leads">[], orders: readonly Doc<"orders">[]): void {
  const active = orders.filter((o) => ACTIVE_STATUSES.includes(o.status)).map((o) => `№${o.number}`);
  if (active.length) throw new ConvexError(`Сначала завершите или отмените заказы клиента: ${active.join(", ")}`);
  const open = leads.filter((l) => OPEN_LEAD.has(l.status)).map((l) => `№${l.number}`);
  if (open.length) throw new ConvexError(`Сначала закройте заявки клиента: ${open.join(", ")}`);
}

/** Каналы, где диалог ведётся по номеру телефона (externalId = номер). */
const PHONE_CHANNELS = ["whatsapp", "site"] as const;

/** Снимок треда OLX без id собеседника: счётчики нужны синхронизации, чтобы не забирать тред заново. */
function olxCounters(meta: unknown): { olx: Record<string, unknown> } | undefined {
  if (typeof meta !== "object" || meta === null || !("olx" in meta)) return undefined;
  const olx: unknown = meta.olx;
  if (typeof olx !== "object" || olx === null) return undefined;
  const counters: Record<string, unknown> = { ...olx };
  delete counters.interlocutorId;
  return { olx: counters };
}

/** Номер клиента в звонке: у входящего — кто звонит, у исходящего — кому. */
const clientSide = (c: Doc<"calls">): Partial<Doc<"calls">> => (c.direction === "in" ? { from: "" } : { to: "" });

/** Адрес в истории правок заказа («адрес «…» → «…»») — тоже персональные данные. */
const ADDRESS_CHANGE = /адрес «[^»]*» → «[^»]*»/g;

/** Всё о клиенте — обезличить. Вызывать после assertCanErase, в той же мутации. */
export async function eraseClient(ctx: MutationCtx, c: Doc<"clients">, leads: readonly Doc<"leads">[], orders: readonly Doc<"orders">[]): Promise<ErasedCounts> {
  const n: ErasedCounts = { leads: leads.length, orders: orders.length, calls: 0, recordings: 0, conversations: 0, messages: 0, files: 0, notes: 0, interactions: 0, reviews: 0 };

  await ctx.db.patch(c._id, {
    name: ANON_NAME,
    phone: await placeholderPhone(ctx),
    email: undefined,
    address: undefined,
    notes: undefined,
    tags: [],
    preferredChannel: undefined,
    anonymizedAt: nowIso(),
  });

  for (const l of leads) await ctx.db.patch(l._id, { clientName: ANON_NAME, clientPhone: "", description: ERASED_TEXT, comment: undefined, ai: undefined, address: undefined, preferredTime: undefined });

  for (const o of orders) {
    // Комментарий к оплате — свободный текст («платила сестра с карты…»): суммы и даты остаются, слова — нет.
    const payments = o.payments.map((p) => {
      const { note, ...rest } = p;
      void note;
      return rest;
    });
    await ctx.db.patch(o._id, { clientName: ANON_NAME, clientPhone: "", address: "", description: ERASED_TEXT, payments });
    for (const h of await ctx.db
      .query("history")
      .withIndex("by_order", (q) => q.eq("orderId", o._id))
      .collect()) {
      const text = h.kind === "edited" ? h.text.replace(ADDRESS_CHANGE, "адрес изменён") : h.text;
      if (text !== h.text) await ctx.db.patch(h._id, { text });
    }
    // Оценка остаётся (из неё рейтинг мастера), слова клиента — нет.
    for (const r of await ctx.db
      .query("reviews")
      .withIndex("by_order", (q) => q.eq("orderId", o._id))
      .collect()) {
      if (r.text === undefined) continue;
      await ctx.db.patch(r._id, { text: undefined });
      n.reviews++;
    }
    // Неиспользованная ссылка «оцените работу» иначе вернула бы в базу новый текст от клиента.
    for (const rr of await ctx.db
      .query("reviewRequests")
      .withIndex("by_order", (q) => q.eq("orderId", o._id))
      .collect())
      if (!rr.usedAt) await ctx.db.delete(rr._id);
  }

  // Звонки: по клиенту, по его заявкам и по номеру — звонок мог прийти до того, как клиента завели в базу.
  const callIds = new Set<Id<"calls">>(leads.flatMap((l) => (l.callId ? [l.callId] : [])));
  for (const call of await ctx.db
    .query("calls")
    .withIndex("by_client", (q) => q.eq("clientId", c._id))
    .collect())
    callIds.add(call._id);
  for (const call of await ctx.db
    .query("calls")
    .withIndex("by_from", (q) => q.eq("from", c.phone))
    .collect())
    if (call.direction === "in") callIds.add(call._id);
  for (const call of await ctx.db
    .query("calls")
    .withIndex("by_to", (q) => q.eq("to", c.phone))
    .collect())
    if (call.direction === "out") callIds.add(call._id);
  for (const id of callIds) {
    const call = await ctx.db.get(id);
    if (!call) continue;
    if (call.recordingId && (await dropFile(ctx, call.recordingId))) n.recordings++;
    // Звонок привязываем к обезличенной карточке: разбор, который ещё идёт, увидит это и не вернёт расшифровку (calls._saveAi).
    await ctx.db.patch(id, {
      ...clientSide(call),
      clientId: c._id,
      clientName: ANON_NAME,
      recordingId: undefined,
      recordingUrl: undefined,
      transcript: undefined,
      ai: undefined,
      draft: undefined,
      aiError: undefined,
      aiStatus: "none",
    });
    n.calls++;
  }

  // Переписка: диалоги клиента, его заявок и WhatsApp по его номеру.
  const convIds = new Set<Id<"conversations">>();
  for (const x of await ctx.db
    .query("conversations")
    .withIndex("by_client", (q) => q.eq("clientId", c._id))
    .collect())
    convIds.add(x._id);
  for (const l of leads) {
    for (const x of await ctx.db
      .query("conversations")
      .withIndex("by_lead", (q) => q.eq("leadId", l._id))
      .collect())
      convIds.add(x._id);
  }
  for (const channel of PHONE_CHANNELS) {
    for (const x of await ctx.db
      .query("conversations")
      .withIndex("by_channel_external", (q) => q.eq("channel", channel).eq("externalId", c.phone))
      .collect())
      convIds.add(x._id);
  }
  for (const id of convIds) {
    const conv = await ctx.db.get(id);
    if (!conv) continue;
    // OLX забирает переписку сам, по ключам треда и сообщений: без них следующая синхронизация
    // загрузила бы всю историю заново. Ключи OLX — случайные id, в них нет данных человека.
    const olx = conv.channel === "olx";
    for (const m of await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", id))
      .collect()) {
      if (m.fileId && (await dropFile(ctx, m.fileId))) n.files++;
      // Id сообщений WhatsApp и Telegram содержат номер или чат человека — их не храним.
      await ctx.db.patch(m._id, { text: ERASED_TEXT, fileId: undefined, fileName: undefined, ...(olx ? {} : { externalId: undefined }) });
      n.messages++;
    }
    // Черновик заявки в боте Telegram (до получения телефона) — тоже слова клиента.
    if (conv.channel === "telegram") {
      for (const b of await ctx.db
        .query("botChats")
        .withIndex("by_chat", (q) => q.eq("chatId", conv.externalId))
        .collect())
        await ctx.db.delete(b._id);
    }
    // Диалог отвязан от клиента: если человек напишет снова, заявка из чата заведёт нового клиента.
    // В Telegram, WhatsApp и на сайте — новый externalId: следующее сообщение начнёт новый диалог.
    await ctx.db.patch(id, {
      externalId: olx ? conv.externalId : `erased:${id}`,
      contactName: ANON_NAME,
      contactPhone: undefined,
      clientId: undefined,
      leadId: undefined,
      waUserId: undefined,
      meta: olx ? olxCounters(conv.meta) : undefined,
      lastText: ERASED_TEXT,
      unread: 0,
      status: "closed",
      replyUntil: undefined,
    });
    n.conversations++;
  }

  for (const note of await ctx.db
    .query("clientNotes")
    .withIndex("by_client", (q) => q.eq("clientId", c._id))
    .collect()) {
    await ctx.db.delete(note._id);
    n.notes++;
  }
  for (const i of await ctx.db
    .query("interactions")
    .withIndex("by_client", (q) => q.eq("clientId", c._id))
    .collect()) {
    if (!i.text) continue;
    await ctx.db.patch(i._id, { text: "" });
    n.interactions++;
  }

  // Антиспам формы сайта помнит номер в ключе — убираем и его.
  const limit = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", `site:phone:${c.phone}`))
    .unique();
  if (limit) await ctx.db.delete(limit._id);
  return n;
}
