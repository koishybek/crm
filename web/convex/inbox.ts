// Единый чат «Сообщения» (ТЗ п.3, п.16): переписка с клиентами из Telegram, WhatsApp, OLX и с сайта в одном месте.
// Каналы кладут входящие через ingest — повторная доставка вебхука ничего не дублирует. Оператор отвечает отсюда же:
// ответ сохраняется со статусом «sending» и уходит в канал фоном (lib/outbound.ts), итог — sent/failed с причиной.
// Доступ — владелец и операторы; руководителю направления и мастерам переписка с клиентами не видна.
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { currentUser, requireRole, STAFF } from "./lib/access";
import { audit, type AuditActor } from "./lib/audit";
import { isMeaningful, isPlaceholder, PLACEHOLDER } from "./lib/chat";
import { notify, nowIso, TENANT } from "./lib/domain";
import { fileSigner, type FileSigner } from "./lib/files";
import { markError, markOk } from "./lib/health";
import { intakeLead } from "./lib/intake";
import { markChannelRead, replyBlock, replyMaxText, sendToChannel, ChannelError } from "./lib/outbound";
import { contactPhone, findKzPhone, isClientPhone } from "./lib/phone";
import { hitLimit } from "./lib/rateLimit";
import { canExtract, extract, toSummary, type CatalogHint } from "./ai";
import { aiSummary, channel, messageKind } from "./schema";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import { phone as fmtPhone } from "../src/lib/format";
import type { AiDraft, AiSummary, Channel, Conversation, ConversationDetail, ConversationDraft, ConversationMessage, MessageKind } from "../src/data/types";

const MAX_TEXT = 4000;
const PREVIEW = 160;
const NOTIFY_EVERY_MS = 10 * 60_000;
const OPEN_LEAD_MS = 3 * 86400_000;
/** Клиенты пишут очередью коротких сообщений: заявку собираем, когда они допишут. */
export const AUTO_LEAD_DELAY_MS = 45_000;
const WA_WINDOW_MS = 24 * 3600_000;
const DRAFT_MESSAGES = 15;
const DRAFT_TEXT = 3000;

/** «в Telegram», «на OLX» — в уведомлениях и журнале. */
export const CHANNEL_IN: Record<Channel, string> = { telegram: "в Telegram", whatsapp: "в WhatsApp", olx: "на OLX", site: "с сайта" };
/** «из WhatsApp» — откуда пришла заявка. */
export const CHANNEL_FROM: Record<Channel, string> = { telegram: "из Telegram", whatsapp: "из WhatsApp", olx: "с OLX", site: "с сайта" };
const CHANNEL_ACTOR: Record<Channel, AuditActor> = { telegram: "Telegram", whatsapp: "WhatsApp", olx: "OLX", site: "Сайт" };

export const inboxFilter = v.union(v.literal("all"), v.literal("unread"), v.literal("mine"), v.literal("closed"), channel);

// ── Мелкие помощники ─────────────────────────────────────────────────────────

const clip = (s: string | undefined, max: number) => (s ?? "").replace(/\u0000/g, "").trim().slice(0, max);
const preview = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, PREVIEW);

/** Время сообщения от канала: в будущее не пускаем (сломанные часы отправителя), без даты — сейчас. */
function messageAt(raw: string | undefined, now: number): string {
  const t = raw ? Date.parse(raw) : NaN;
  return new Date(Number.isFinite(t) ? Math.min(t, now) : now).toISOString();
}

/** Ссылка на объявление и т.п. — только http(s), иначе не сохраняем. */
function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString().slice(0, 500) : undefined;
  } catch {
    return undefined;
  }
}

/** Служебные данные канала (id треда OLX, @username) — небольшие и сериализуемые. */
function mergeMeta(prev: unknown, next: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const base = prev && typeof prev === "object" && !Array.isArray(prev) ? (prev as Record<string, unknown>) : undefined;
  if (!next) return base;
  try {
    const merged = { ...base, ...next };
    const json = JSON.stringify(merged);
    return json.length <= 4000 ? (JSON.parse(json) as Record<string, unknown>) : base;
  } catch {
    return base;
  }
}

// ── DTO ──────────────────────────────────────────────────────────────────────

const toConversation = (c: Doc<"conversations">): Conversation => ({
  id: c._id,
  channel: c.channel,
  contactName: c.contactName,
  contactPhone: c.contactPhone,
  clientId: c.clientId,
  leadId: c.leadId,
  subject: c.subject,
  subjectUrl: c.subjectUrl,
  lastMessageAt: c.lastMessageAt,
  lastText: c.lastText,
  lastDirection: c.lastDirection,
  unread: c.unread,
  status: c.status,
  assigneeId: c.assigneeId,
  replyUntil: c.replyUntil,
});

function toMessage(m: Doc<"conversationMessages">, signer: FileSigner): ConversationMessage {
  return {
    id: m._id,
    conversationId: m.conversationId,
    direction: m.direction,
    kind: m.kind,
    text: m.text,
    at: m.at,
    authorId: m.authorId,
    fileUrl: signer.url(m.fileId, m.kind === "file" ? m.fileName : undefined),
    fileName: m.fileName,
    status: m.status,
    error: m.error,
  };
}

// ── Входящие ─────────────────────────────────────────────────────────────────

export interface IngestInput {
  channel: Channel;
  /** Собеседник в канале: id чата Telegram, номер WhatsApp, тред OLX, телефон с формы сайта. */
  externalId: string;
  contactName?: string;
  contactPhone?: string;
  text: string;
  kind: MessageKind;
  /** Id сообщения, уникальный в пределах канала (Telegram — «чат:сообщение»). Повтор → без дубля. */
  externalMessageId?: string;
  at?: string;
  fileId?: Id<"_storage">;
  fileName?: string;
  subject?: string;
  subjectUrl?: string;
  meta?: Record<string, unknown>;
  /**
   * out — сообщение компании, отправленное мимо «Сообщений» (например, с сайта OLX) и подтянутое синхронизацией:
   * ложится в ленту как отправленное, без «непрочитанных», уведомлений и авто-заявки. По умолчанию — in.
   */
  direction?: "in" | "out";
  /**
   * История канала (первая загрузка OLX после подключения): входящее ложится в ленту без «непрочитанных»,
   * уведомлений и авто-заявки — старые переписки не должны засыпать команду и плодить заявки.
   */
  history?: boolean;
  /** false — канал уведомит команду сам (бот — о заявке, сайт — о новой заявке). */
  notify?: boolean;
  /** false — заявку создаёт сам канал (бот Telegram, форма сайта). */
  autoLead?: boolean;
}

export interface IngestResult {
  conversationId: Id<"conversations">;
  messageId: Id<"conversationMessages">;
  duplicate: boolean;
  created: boolean;
}

/** Ключ сообщения канала в conversationMessages.externalId: индекс общий для всех каналов — с префиксом канала. */
export const externalKey = (ch: Channel, id: string): string => `${ch}:${id.slice(0, 200)}`;

async function byExternal(ctx: QueryCtx, ch: Channel, externalId: string): Promise<Doc<"conversations"> | null> {
  return ctx.db
    .query("conversations")
    .withIndex("by_channel_external", (q) => q.eq("channel", ch).eq("externalId", externalId))
    .unique();
}

async function clientByPhone(ctx: QueryCtx, phone: string | undefined): Promise<Doc<"clients"> | null> {
  if (!phone || !isClientPhone(phone)) return null;
  return ctx.db
    .query("clients")
    .withIndex("by_phone", (q) => q.eq("phone", phone))
    .first();
}

/** Входящее сообщение → диалог (создать или открыть заново) + сообщение + уведомление + авто-заявка. */
export async function ingestMessage(ctx: MutationCtx, a: IngestInput): Promise<IngestResult> {
  const now = Date.now();
  const extKey = a.externalMessageId ? externalKey(a.channel, a.externalMessageId) : undefined;
  if (extKey) {
    const dup = await ctx.db
      .query("conversationMessages")
      .withIndex("by_external", (q) => q.eq("externalId", extKey))
      .first();
    if (dup) return { conversationId: dup.conversationId, messageId: dup._id, duplicate: true, created: false };
  }
  const externalId = clip(a.externalId, 200);
  if (!externalId) throw new ConvexError("Пустой id собеседника");
  const inbound = a.direction !== "out";
  // «Живое» входящее: считается непрочитанным, уведомляет команду и может стать заявкой.
  const live = inbound && !a.history;
  const at = messageAt(a.at, now);
  const text = clip(a.text, MAX_TEXT) || PLACEHOLDER.attachment;
  const name = clip(a.contactName, 120) || undefined;
  // Номер: из канала (WhatsApp, контакт Telegram) или из текста клиента («мой номер 8 701 …» — частое на OLX).
  const phone = contactPhone(a.contactPhone) ?? (inbound && a.kind !== "system" ? (findKzPhone(text) ?? undefined) : undefined);
  const subject = clip(a.subject, 300) || undefined;
  const subjectUrl = safeUrl(a.subjectUrl);
  // Окно ответа WhatsApp открывает только сообщение клиента; служебные отметки (реакция, «не поддерживается») его не продлевают.
  const replyUntil = inbound && a.channel === "whatsapp" && a.kind !== "system" ? new Date(Date.parse(at) + WA_WINDOW_MS).toISOString() : undefined;

  let conv = await byExternal(ctx, a.channel, externalId);
  const created = !conv;
  if (!conv) {
    const client = await clientByPhone(ctx, phone);
    const id = await ctx.db.insert("conversations", {
      tenantId: TENANT,
      channel: a.channel,
      externalId,
      contactName: name ?? client?.name,
      contactPhone: phone,
      clientId: client?._id,
      subject,
      subjectUrl,
      lastMessageAt: at,
      lastText: preview(text),
      lastDirection: inbound ? "in" : "out",
      unread: live ? 1 : 0,
      status: "open",
      replyUntil,
      meta: mergeMeta(undefined, a.meta),
    });
    conv = (await ctx.db.get(id))!;
  } else {
    const patch: Partial<Doc<"conversations">> = { unread: live ? conv.unread + 1 : conv.unread, status: "open" };
    // Вебхуки приходят не по порядку: превью — по самому позднему сообщению.
    if (at >= conv.lastMessageAt) Object.assign(patch, { lastMessageAt: at, lastText: preview(text), lastDirection: inbound ? "in" : "out" });
    if (name) patch.contactName = name;
    if (phone && !conv.contactPhone) patch.contactPhone = phone;
    if (!conv.clientId) {
      const client = await clientByPhone(ctx, phone ?? conv.contactPhone);
      if (client) patch.clientId = client._id;
    }
    if (subject) patch.subject = subject;
    if (subjectUrl) patch.subjectUrl = subjectUrl;
    if (replyUntil && (!conv.replyUntil || replyUntil > conv.replyUntil)) patch.replyUntil = replyUntil;
    if (a.meta) patch.meta = mergeMeta(conv.meta, a.meta);
    await ctx.db.patch(conv._id, patch);
    conv = (await ctx.db.get(conv._id))!;
  }

  const messageId = await ctx.db.insert("conversationMessages", {
    conversationId: conv._id,
    direction: inbound ? "in" : "out",
    kind: a.kind,
    text,
    at,
    externalId: extKey,
    fileId: a.fileId,
    fileName: clip(a.fileName, 200) || undefined,
    status: inbound ? undefined : "sent",
  });
  if (live && a.notify !== false) await notifyNewMessage(ctx, conv, text);
  if (live && a.autoLead !== false) await scheduleAutoLead(ctx, conv, messageId, text, now);
  return { conversationId: conv._id, messageId, duplicate: false, created };
}

export const ingest = internalMutation({
  args: {
    channel,
    externalId: v.string(),
    contactName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    text: v.string(),
    kind: messageKind,
    externalMessageId: v.optional(v.string()),
    at: v.optional(v.string()),
    fileId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
    subject: v.optional(v.string()),
    subjectUrl: v.optional(v.string()),
    meta: v.optional(v.record(v.string(), v.any())),
    direction: v.optional(v.union(v.literal("in"), v.literal("out"))),
    history: v.optional(v.boolean()),
    notify: v.optional(v.boolean()),
    autoLead: v.optional(v.boolean()),
  },
  handler: (ctx, a): Promise<IngestResult> => ingestMessage(ctx, a),
});

const DELIVERY_RANK = { sending: 0, sent: 1, delivered: 2, read: 3, failed: 1 } as const;

/** Окно ответа закрылось раньше, чем мы считали (Meta вернула «прошло 24 часа»): дальше — только звонок. */
async function closeReplyWindow(ctx: MutationCtx, id: Id<"conversations">): Promise<void> {
  const c = await ctx.db.get(id);
  const now = nowIso();
  if (c && (!c.replyUntil || c.replyUntil > now)) await ctx.db.patch(id, { replyUntil: now });
}

/**
 * Статус доставки от канала (вебхук WhatsApp: delivered/read/failed) по id сообщения в канале.
 * Статус не откатывается назад: «прочитано» после «доставлено» — да, «доставлено» после «прочитано» — нет.
 */
export const _deliveryStatus = internalMutation({
  args: {
    channel,
    externalMessageId: v.string(),
    status: v.union(v.literal("sent"), v.literal("delivered"), v.literal("read"), v.literal("failed")),
    error: v.optional(v.string()),
    /** Канал сообщил, что окно ответа закрыто (WhatsApp: прошло 24 часа) — выключаем поле ответа. */
    closeWindow: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<boolean> => {
    const m = await ctx.db
      .query("conversationMessages")
      .withIndex("by_external", (q) => q.eq("externalId", externalKey(a.channel, a.externalMessageId)))
      .first();
    if (!m || m.direction !== "out") return false;
    const current = m.status ?? "sent";
    if (a.status === "failed") {
      if (current === "delivered" || current === "read" || current === "failed") return false;
      await ctx.db.patch(m._id, { status: "failed", error: clip(a.error, 300) || "Сообщение не доставлено" });
      if (a.closeWindow) await closeReplyWindow(ctx, m.conversationId);
      return true;
    }
    if (DELIVERY_RANK[a.status] <= DELIVERY_RANK[current] && current !== "failed") return false;
    await ctx.db.patch(m._id, { status: a.status, error: undefined });
    return true;
  },
});

/** Это сообщение канала уже записано? — чтобы не расшифровывать голосовое повторно при повторе вебхука. */
export const _seen = internalQuery({
  args: { channel, externalMessageId: v.string() },
  handler: async (ctx, a): Promise<boolean> =>
    !!(await ctx.db
      .query("conversationMessages")
      .withIndex("by_external", (q) => q.eq("externalId", externalKey(a.channel, a.externalMessageId)))
      .first()),
});

/** Диалог канала по собеседнику (или null) — например, чтобы записать ответ бота на команду. */
export const _find = internalQuery({
  args: { channel, externalId: v.string() },
  handler: async (ctx, a): Promise<Id<"conversations"> | null> => (await byExternal(ctx, a.channel, a.externalId))?._id ?? null,
});

/** Автоответ бота — в ленту диалога серым «системным» сообщением. Превью и «непрочитанные» не меняет. */
export const _logBot = internalMutation({
  args: { conversationId: v.id("conversations"), text: v.string(), ok: v.boolean(), externalMessageId: v.optional(v.string()) },
  handler: async (ctx, a): Promise<void> => {
    const c = await ctx.db.get(a.conversationId);
    if (!c) return;
    await ctx.db.insert("conversationMessages", {
      conversationId: c._id,
      direction: "out",
      kind: "system",
      text: clip(a.text, MAX_TEXT) || "—",
      at: nowIso(),
      externalId: a.externalMessageId ? externalKey(c.channel, a.externalMessageId) : undefined,
      status: a.ok ? "sent" : "failed",
    });
  },
});

/** Диалог канала ↔ заявка и клиент (бот создал заявку, оператор связал вручную). */
export async function linkConversation(
  ctx: MutationCtx,
  ch: Channel,
  externalId: string,
  link: { leadId?: Id<"leads">; clientId?: Id<"clients">; phone?: string },
): Promise<Id<"conversations"> | null> {
  const c = await byExternal(ctx, ch, externalId);
  if (!c) return null;
  const patch: Partial<Doc<"conversations">> = {};
  if (link.leadId) patch.leadId = link.leadId;
  if (link.clientId && (link.leadId || !c.clientId)) patch.clientId = link.clientId;
  if (link.phone && !c.contactPhone) patch.contactPhone = link.phone;
  if (Object.keys(patch).length) await ctx.db.patch(c._id, patch);
  return c._id;
}

/** Кому сообщать о новых сообщениях: назначенному сотруднику, иначе — владельцам и операторам. */
async function inboxRecipients(ctx: QueryCtx, c: Doc<"conversations">): Promise<Id<"users">[]> {
  if (c.assigneeId) {
    const u = await ctx.db.get(c.assigneeId);
    if (u && u.active !== false && (u.role === "owner" || u.role === "operator")) return [u._id];
  }
  const ids: Id<"users">[] = [];
  for (const role of ["owner", "operator"] as const) {
    for (const u of await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", role))
      .collect()) {
      if (u.active !== false) ids.push(u._id);
    }
  }
  return ids;
}

/** Не чаще раза в 10 минут на диалог: клиент, пишущий очередью, не засыпает команду уведомлениями. */
async function notifyNewMessage(ctx: MutationCtx, c: Doc<"conversations">, text: string): Promise<void> {
  if (!(await hitLimit(ctx, `inbox:notify:${c._id}`, 1, NOTIFY_EVERY_MS))) return;
  const who = c.contactName || (c.contactPhone ? fmtPhone(c.contactPhone) : "клиента");
  const short = text.length > 80 ? `${text.slice(0, 79)}…` : text;
  await notify(ctx, await inboxRecipients(ctx, c), `Новое сообщение ${CHANNEL_IN[c.channel]} от ${who}: «${short}»`, { link: `/inbox?c=${c._id}`, tone: "info" });
}

// ── Авто-заявка из переписки ─────────────────────────────────────────────────

const isOpenLead = (l: Doc<"leads">, now: number) => l.status !== "converted" && l.status !== "rejected" && now - Date.parse(l.createdAt) < OPEN_LEAD_MS;

/**
 * Есть ли у собеседника работа в процессе: открытая заявка за 3 дня, активный заказ или заказ, сданный за 3 дня
 * («Спасибо, всё работает» — не новая заявка). Возвращает открытую заявку, если она есть.
 */
async function openWork(ctx: QueryCtx, c: Doc<"conversations">, now: number): Promise<{ busy: boolean; lead: Doc<"leads"> | null }> {
  if (c.leadId) {
    const l = await ctx.db.get(c.leadId);
    if (l && isOpenLead(l, now)) return { busy: true, lead: l };
  }
  if (!c.clientId) return { busy: false, lead: null };
  const since = new Date(now - OPEN_LEAD_MS).toISOString();
  const leads = await ctx.db
    .query("leads")
    .withIndex("by_client", (q) => q.eq("clientId", c.clientId!).gte("createdAt", since))
    .collect();
  const lead = leads.find((l) => isOpenLead(l, now)) ?? null;
  if (lead) return { busy: true, lead };
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_client", (q) => q.eq("clientId", c.clientId!))
    .order("desc")
    .take(20);
  return { busy: orders.some((o) => ACTIVE_STATUSES.includes(o.status) || (!!o.doneAt && o.doneAt >= since)), lead: null };
}

async function scheduleAutoLead(ctx: MutationCtx, c: Doc<"conversations">, messageId: Id<"conversationMessages">, text: string, now: number): Promise<void> {
  // Без телефона (обычно OLX) заявку создаёт оператор из чата одной кнопкой.
  if (!c.contactPhone || !isClientPhone(c.contactPhone) || !isMeaningful(text)) return;
  const work = await openWork(ctx, c, now);
  if (work.lead && c.leadId !== work.lead._id) await ctx.db.patch(c._id, { leadId: work.lead._id });
  if (work.busy) return;
  await ctx.scheduler.runAfter(AUTO_LEAD_DELAY_MS, internal.inbox._autoLead, { conversationId: c._id, messageId });
}

/** Последние сообщения клиента одним текстом — для AI и описания заявки. */
async function clientText(ctx: QueryCtx, c: Doc<"conversations">, since: string): Promise<string> {
  const rows = await ctx.db
    .query("conversationMessages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", c._id).gte("at", since))
    .order("desc")
    .take(60);
  return rows
    .filter((m) => m.direction === "in" && m.kind !== "location" && m.kind !== "system" && !isPlaceholder(m.text))
    .slice(0, DRAFT_MESSAGES)
    .reverse()
    .map((m) => m.text)
    .join("\n")
    .slice(-DRAFT_TEXT);
}

/** Для фонового разбора: что разбирать — или null, если заявка уже не нужна или придёт более позднее сообщение. */
export const _autoLeadJob = internalQuery({
  args: { conversationId: v.id("conversations"), messageId: v.id("conversationMessages") },
  handler: async (ctx, a): Promise<{ text: string } | null> => {
    const c = await ctx.db.get(a.conversationId);
    if (!c || !c.contactPhone || !isClientPhone(c.contactPhone)) return null;
    // Дебаунс: разбор запускает только последнее содержательное сообщение очереди.
    const recent = await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", c._id))
      .order("desc")
      .take(30);
    // Геопозиция и служебные отметки (реакция, «не поддерживается») — не текст обращения: очередь не перезапускают.
    const latest = recent.find((m) => m.direction === "in" && m.kind !== "system" && m.kind !== "location" && isMeaningful(m.text));
    if (latest && latest._id !== a.messageId) return null;
    const now = Date.now();
    if ((await openWork(ctx, c, now)).busy) return null;
    const prev = c.leadId ? await ctx.db.get(c.leadId) : null;
    const dayAgo = new Date(now - 86400_000).toISOString();
    const since = prev && prev.createdAt > dayAgo ? prev.createdAt : dayAgo;
    const text = await clientText(ctx, c, since);
    return text ? { text } : null;
  },
});

const draftValidator = v.object({
  serviceId: v.optional(v.string()),
  city: v.optional(v.string()),
  address: v.optional(v.string()),
  urgency: v.optional(v.union(v.literal("normal"), v.literal("high"), v.literal("urgent"))),
  clientName: v.optional(v.string()),
  description: v.optional(v.string()),
});

const errText = (e: unknown) => (e instanceof ConvexError && typeof e.data === "string" ? e.data : e instanceof Error ? e.name : "ошибка");

/** Разбор переписки AI (если подключён) → заявка. Без AI заявка всё равно создаётся с текстом клиента. */
export const _autoLead = internalAction({
  args: { conversationId: v.id("conversations"), messageId: v.id("conversationMessages") },
  handler: async (ctx, a): Promise<void> => {
    const job = await ctx.runQuery(internal.inbox._autoLeadJob, a);
    if (!job) return;
    let parsed: { ai?: AiSummary; draft?: AiDraft } = {};
    if (canExtract()) {
      try {
        const hint: CatalogHint = await ctx.runQuery(internal.catalog._hint, {});
        parsed = toSummary(await extract(job.text, hint, "message"), (id) => hint.services.find((s) => s.id === id)?.label ?? id);
        await ctx.runMutation(internal.health._mark, { key: "ai", ok: true, note: "Разбор переписки" });
      } catch (e) {
        console.warn(`inbox: AI не разобрал диалог ${a.conversationId}: ${errText(e)}`);
        await ctx.runMutation(internal.health._mark, { key: "ai", ok: false, note: `Разбор переписки: ${errText(e)}` });
      }
    }
    await ctx.runMutation(internal.inbox._autoLeadCreate, { ...a, text: job.text, ai: parsed.ai, draft: parsed.draft });
  },
});

export const _autoLeadCreate = internalMutation({
  args: { conversationId: v.id("conversations"), messageId: v.id("conversationMessages"), text: v.string(), ai: v.optional(aiSummary), draft: v.optional(draftValidator) },
  handler: async (ctx, a): Promise<Id<"leads"> | null> => {
    const c = await ctx.db.get(a.conversationId);
    // Пока шёл разбор, заявку мог создать оператор или другой разбор — проверяем ещё раз в транзакции.
    if (!c || !c.contactPhone || !isClientPhone(c.contactPhone) || (await openWork(ctx, c, Date.now())).busy) return null;
    const d = a.draft ?? {};
    const res = await intakeLead(ctx, {
      source: c.channel,
      phone: c.contactPhone,
      name: d.clientName ?? c.contactName,
      fallbackName: `Клиент ${CHANNEL_FROM[c.channel]}`,
      serviceId: d.serviceId,
      city: d.city,
      address: d.address,
      urgency: d.urgency,
      description: d.description || a.text,
      comment: d.description ? `Сообщение клиента: ${a.text.slice(0, 1500)}` : undefined,
      ai: a.ai,
      message: { title: `Сообщение ${CHANNEL_IN[c.channel]}`, text: a.text },
      actor: CHANNEL_ACTOR[c.channel],
      via: CHANNEL_FROM[c.channel],
      auditMeta: { conversationId: c._id, ai: !!a.ai },
    });
    if (!res) return null;
    await ctx.db.patch(c._id, { leadId: res.leadId, clientId: res.clientId });
    return res.leadId;
  },
});

// ── Для команды ──────────────────────────────────────────────────────────────

const isChannel = (f: Infer<typeof inboxFilter>): f is Channel => f === "telegram" || f === "whatsapp" || f === "olx" || f === "site";

/** Список диалогов, свежие сверху. «Закрытые» — архив, остальные фильтры — по открытым. */
export const list = query({
  args: { filter: inboxFilter, paginationOpts: paginationOptsValidator },
  handler: async (ctx, { filter, paginationOpts }) => {
    const me = await requireRole(ctx, STAFF);
    let q = ctx.db
      .query("conversations")
      .withIndex("by_status_last", (x) => x.eq("status", filter === "closed" ? "closed" : "open"))
      .order("desc");
    if (filter === "unread") q = q.filter((x) => x.gt(x.field("unread"), 0));
    else if (filter === "mine") q = q.filter((x) => x.eq(x.field("assigneeId"), me._id));
    else if (isChannel(filter)) q = q.filter((x) => x.eq(x.field("channel"), filter));
    const page = await q.paginate(paginationOpts);
    return { ...page, page: page.page.map(toConversation) };
  },
});

/** Сколько диалогов ждут ответа — бейдж «Сообщения» в меню. Не сотрудникам — null. */
export const unreadCount = query({
  args: {},
  handler: async (ctx): Promise<number | null> => {
    const me = await currentUser(ctx);
    if (!me || !STAFF.includes(me.role)) return null;
    // Непрочитанный диалог всегда открыт: новое сообщение открывает закрытый.
    const since = new Date(Date.now() - 60 * 86400_000).toISOString();
    const rows = await ctx.db
      .query("conversations")
      .withIndex("by_status_last", (q) => q.eq("status", "open").gte("lastMessageAt", since))
      .filter((q) => q.gt(q.field("unread"), 0))
      .take(100);
    return rows.length;
  },
});

/**
 * Диалог с последними сообщениями. id — строкой: ссылка /inbox?c=… могла устареть или быть набрана руками.
 * t — метка обновления подписанных ссылок на фото и голосовые (src/data/files.ts).
 */
export const get = query({
  args: { id: v.string(), limit: v.optional(v.number()), t: v.optional(v.number()) },
  handler: async (ctx, { id: raw, limit }): Promise<ConversationDetail | null> => {
    await requireRole(ctx, STAFF);
    const id = ctx.db.normalizeId("conversations", raw);
    const c = id ? await ctx.db.get(id) : null;
    if (!id || !c) return null;
    const n = limit !== undefined && Number.isFinite(limit) ? Math.min(500, Math.max(20, Math.round(limit))) : 100;
    const rows = await ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", id))
      .order("desc")
      .take(n + 1);
    const [lead, client] = await Promise.all([c.leadId ? ctx.db.get(c.leadId) : null, c.clientId ? ctx.db.get(c.clientId) : null]);
    const meta = c.meta && typeof c.meta === "object" ? (c.meta as Record<string, unknown>) : {};
    const signer = await fileSigner(ctx);
    return {
      conversation: toConversation(c),
      messages: rows
        .slice(0, n)
        .reverse()
        .map((m) => toMessage(m, signer)),
      hasMore: rows.length > n,
      replyBlock: (await replyBlock(ctx, c, Date.now())) ?? undefined,
      lead: lead ? { id: lead._id, number: lead.number, status: lead.status, orderId: lead.orderId } : undefined,
      client: client ? { id: client._id, name: client.name, phone: client.phone, city: client.city } : undefined,
      telegramUsername: c.channel === "telegram" && typeof meta.username === "string" ? meta.username : undefined,
    };
  },
});

/** Диалог по заявке — кнопка «Переписка» в карточке заявки. Руководителю направления — null (переписка ему не видна). */
export const forLead = query({
  args: { leadId: v.id("leads") },
  handler: async (ctx, { leadId }): Promise<{ id: string; channel: Channel } | null> => {
    const me = await currentUser(ctx);
    if (!me || !STAFF.includes(me.role)) return null;
    const c = await ctx.db
      .query("conversations")
      .withIndex("by_lead", (q) => q.eq("leadId", leadId))
      .first();
    return c ? { id: c._id, channel: c.channel } : null;
  },
});

async function mustGet(ctx: QueryCtx, id: Id<"conversations">): Promise<Doc<"conversations">> {
  const c = await ctx.db.get(id);
  if (!c) throw new ConvexError("Диалог не найден");
  return c;
}

/** Кто собеседник — для журнала: имя без телефона. */
const who = (c: Doc<"conversations">) => c.contactName || `клиент ${CHANNEL_FROM[c.channel]}`;

export const markRead = mutation({
  args: { id: v.id("conversations") },
  handler: async (ctx, { id }): Promise<void> => {
    await requireRole(ctx, STAFF);
    const c = await mustGet(ctx, id);
    if (!c.unread) return;
    await ctx.db.patch(id, { unread: 0 });
    // И в самом канале, если он это умеет (OLX: «прочитано» в треде) — фоном.
    await markChannelRead(ctx, c);
  },
});

/** Ответ клиенту. Сохраняется сразу («отправляется»), в канал уходит фоном — статус обновится сам. */
export const reply = mutation({
  args: { conversationId: v.id("conversations"), text: v.string() },
  handler: async (ctx, { conversationId, text }): Promise<{ messageId: Id<"conversationMessages"> }> => {
    const me = await requireRole(ctx, STAFF);
    const body = text.replace(/\u0000/g, "").trim();
    if (!body) throw new ConvexError("Напишите сообщение");
    const c = await mustGet(ctx, conversationId);
    const max = replyMaxText(c.channel, MAX_TEXT);
    if (body.length > max) throw new ConvexError(`Слишком длинное сообщение — не больше ${max} символов`);
    const block = await replyBlock(ctx, c, Date.now());
    if (block) throw new ConvexError(block);
    const at = nowIso();
    const messageId = await ctx.db.insert("conversationMessages", { conversationId, direction: "out", kind: "text", text: body, at, authorId: me._id, status: "sending" });
    await ctx.db.patch(conversationId, { lastMessageAt: at, lastText: preview(body), lastDirection: "out", unread: 0, status: "open" });
    await ctx.scheduler.runAfter(0, internal.inbox._deliver, { messageId });
    await audit(ctx, me, "conversation.reply", `Ответ клиенту ${CHANNEL_IN[c.channel]}: ${who(c)}`, { entityId: conversationId, meta: { channel: c.channel, length: body.length } });
    return { messageId };
  },
});

/** Повторить неотправленный ответ. */
export const resend = mutation({
  args: { messageId: v.id("conversationMessages") },
  handler: async (ctx, { messageId }): Promise<void> => {
    const me = await requireRole(ctx, STAFF);
    const m = await ctx.db.get(messageId);
    if (!m || m.direction !== "out" || m.kind === "system" || m.status !== "failed") throw new ConvexError("Это сообщение нельзя отправить повторно");
    const c = await mustGet(ctx, m.conversationId);
    const block = await replyBlock(ctx, c, Date.now());
    if (block) throw new ConvexError(block);
    await ctx.db.patch(messageId, { status: "sending", error: undefined });
    await ctx.scheduler.runAfter(0, internal.inbox._deliver, { messageId });
    await audit(ctx, me, "conversation.reply", `Повторная отправка ответа ${CHANNEL_IN[c.channel]}: ${who(c)}`, { entityId: c._id, meta: { channel: c.channel, length: m.text.length, retry: true } });
  },
});

export const close = mutation({
  args: { id: v.id("conversations") },
  handler: async (ctx, { id }): Promise<void> => {
    const me = await requireRole(ctx, STAFF);
    const c = await mustGet(ctx, id);
    if (c.status === "closed") return;
    await ctx.db.patch(id, { status: "closed", unread: 0 });
    await audit(ctx, me, "conversation.close", `Диалог ${CHANNEL_IN[c.channel]} закрыт: ${who(c)}`, { entityId: id });
  },
});

export const reopen = mutation({
  args: { id: v.id("conversations") },
  handler: async (ctx, { id }): Promise<void> => {
    const me = await requireRole(ctx, STAFF);
    const c = await mustGet(ctx, id);
    if (c.status === "open") return;
    await ctx.db.patch(id, { status: "open" });
    await audit(ctx, me, "conversation.reopen", `Диалог ${CHANNEL_IN[c.channel]} открыт снова: ${who(c)}`, { entityId: id });
  },
});

/** Назначить ответственного (владельца или оператора); без userId — снять назначение. */
export const assign = mutation({
  args: { id: v.id("conversations"), userId: v.optional(v.id("users")) },
  handler: async (ctx, { id, userId }): Promise<void> => {
    const me = await requireRole(ctx, STAFF);
    const c = await mustGet(ctx, id);
    let name = "";
    if (userId) {
      const u = await ctx.db.get(userId);
      if (!u || u.active === false || (u.role !== "owner" && u.role !== "operator")) throw new ConvexError("Назначить можно владельца или оператора");
      name = u.name ?? "";
    }
    if (c.assigneeId === userId) return;
    await ctx.db.patch(id, { assigneeId: userId });
    await audit(ctx, me, "conversation.assign", userId ? `Диалог ${CHANNEL_IN[c.channel]} (${who(c)}) назначен: ${name}` : `С диалога ${CHANNEL_IN[c.channel]} (${who(c)}) снято назначение`, {
      entityId: id,
      meta: { assigneeId: userId ?? null },
    });
  },
});

export const linkClient = mutation({
  args: { id: v.id("conversations"), clientId: v.id("clients") },
  handler: async (ctx, { id, clientId }): Promise<void> => {
    const me = await requireRole(ctx, STAFF);
    const c = await mustGet(ctx, id);
    const client = await ctx.db.get(clientId);
    if (!client) throw new ConvexError("Клиент не найден");
    await ctx.db.patch(id, { clientId, contactPhone: c.contactPhone ?? client.phone, contactName: c.contactName ?? client.name });
    await audit(ctx, me, "conversation.linkClient", `Диалог ${CHANNEL_IN[c.channel]} связан с клиентом ${client.name}`, { entityId: id, meta: { clientId } });
  },
});

/** Заявку создали из чата — связываем: дальше в чате видно «Заявка №…», а клиент — в карточке. */
export const linkLead = mutation({
  args: { id: v.id("conversations"), leadId: v.id("leads") },
  handler: async (ctx, { id, leadId }): Promise<void> => {
    const me = await requireRole(ctx, STAFF);
    const c = await mustGet(ctx, id);
    const lead = await ctx.db.get(leadId);
    if (!lead) throw new ConvexError("Заявка не найдена");
    await ctx.db.patch(id, { leadId, clientId: lead.clientId, contactPhone: c.contactPhone ?? lead.clientPhone });
    await audit(ctx, me, "conversation.linkLead", `Диалог ${CHANNEL_IN[c.channel]} связан с заявкой №${lead.number}`, { entityId: id, meta: { leadId } });
  },
});

// ── Отправка в канал ─────────────────────────────────────────────────────────

export const _outboxItem = internalQuery({
  args: { messageId: v.id("conversationMessages") },
  handler: async (ctx, { messageId }) => {
    const m = await ctx.db.get(messageId);
    if (!m || m.direction !== "out" || m.status !== "sending") return null;
    const c = await ctx.db.get(m.conversationId);
    if (!c) return null;
    return { text: m.text, target: { channel: c.channel, externalId: c.externalId, contactPhone: c.contactPhone, replyUntil: c.replyUntil } };
  },
});

export const _deliver = internalAction({
  args: {
    messageId: v.id("conversationMessages"),
    /** Кнопки под автоматическим сообщением клиенту (оценка звёздами) — их умеет только Telegram. */
    buttons: v.optional(v.array(v.array(v.object({ text: v.string(), data: v.optional(v.string()), url: v.optional(v.string()) })))),
  },
  handler: async (ctx, { messageId, buttons }): Promise<void> => {
    const job = await ctx.runQuery(internal.inbox._outboxItem, { messageId });
    if (!job) return;
    try {
      const res = await sendToChannel(ctx, job.target, job.text, buttons);
      await ctx.runMutation(internal.inbox._delivered, { messageId, ok: true, externalId: res.externalId });
    } catch (e) {
      const known = e instanceof ChannelError;
      // Текст сообщения и номер клиента в лог не пишем.
      console.warn(`inbox: ответ ${messageId} не доставлен (${job.target.channel}): ${known ? e.data : errText(e)}`);
      await ctx.runMutation(internal.inbox._delivered, {
        messageId,
        ok: false,
        error: known ? e.data : "Не удалось отправить сообщение",
        systemic: known ? e.systemic : true,
        closeWindow: known && e.closeWindow ? true : undefined,
      });
    }
  },
});

export const _delivered = internalMutation({
  args: {
    messageId: v.id("conversationMessages"),
    ok: v.boolean(),
    externalId: v.optional(v.string()),
    error: v.optional(v.string()),
    systemic: v.optional(v.boolean()),
    closeWindow: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<void> => {
    const m = await ctx.db.get(a.messageId);
    if (!m) return;
    const c = await ctx.db.get(m.conversationId);
    if (a.ok) {
      const key = a.externalId && c ? externalKey(c.channel, a.externalId) : undefined;
      if (key) {
        // Опрос канала (OLX) успел записать этот же ответ отдельной строкой — остаётся ответ оператора, копия уходит.
        const echo = await ctx.db
          .query("conversationMessages")
          .withIndex("by_external", (q) => q.eq("externalId", key))
          .first();
        if (echo && echo._id !== m._id && echo.direction === "out" && !echo.authorId) await ctx.db.delete(echo._id);
      }
      await ctx.db.patch(m._id, { status: "sent", error: undefined, ...(key ? { externalId: key } : {}) });
      if (c && c.channel !== "site") await markOk(ctx, c.channel, "Ответ клиенту доставлен");
      return;
    }
    // Канал уже подтвердил это сообщение (опрос OLX нашёл его в треде) — «не отправлено» было бы неправдой.
    if (m.externalId && m.status === "sent") return;
    await ctx.db.patch(m._id, { status: "failed", error: (a.error ?? "Не удалось отправить сообщение").slice(0, 300) });
    if (c && a.closeWindow) await closeReplyWindow(ctx, c._id);
    if (c && c.channel !== "site" && a.systemic) await markError(ctx, c.channel, a.error ?? "Ответ клиенту не отправлен");
  },
});

// ── Заявка из чата ───────────────────────────────────────────────────────────

export const _draftSource = internalQuery({
  args: { id: v.id("conversations") },
  handler: async (ctx, { id }): Promise<{ channel: Channel; phone?: string; name?: string; text: string } | null> => {
    const c = await ctx.db.get(id);
    if (!c) return null;
    const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
    // Текст после прошлой заявки по этому диалогу, но не старше недели.
    const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
    const since = lead && lead.createdAt > weekAgo ? lead.createdAt : weekAgo;
    const client = c.clientId ? await ctx.db.get(c.clientId) : null;
    return {
      channel: c.channel,
      phone: c.contactPhone && isClientPhone(c.contactPhone) ? c.contactPhone : client?.phone,
      name: client?.name ?? c.contactName,
      text: await clientText(ctx, c, since),
    };
  },
});

/** Черновик заявки из переписки для формы: AI раскладывает текст клиента по полям (если подключён). */
export const draftFromConversation = action({
  args: { id: v.id("conversations") },
  handler: async (ctx, { id }): Promise<ConversationDraft> => {
    const role = await ctx.runQuery(internal.users._viewerRole, {});
    if (role !== "owner" && role !== "operator") throw new ConvexError("Нет доступа");
    const src = await ctx.runQuery(internal.inbox._draftSource, { id });
    if (!src) throw new ConvexError("Диалог не найден");
    const base: ConversationDraft = { channel: src.channel, phone: src.phone, name: src.name, text: src.text, draft: { description: src.text || undefined } };
    if (!src.text || !canExtract()) return base;
    try {
      const hint: CatalogHint = await ctx.runQuery(internal.catalog._hint, {});
      const { ai, draft } = toSummary(await extract(src.text, hint, "message"), (sid) => hint.services.find((s) => s.id === sid)?.label ?? sid);
      return { ...base, name: base.name ?? draft.clientName, ai, draft };
    } catch (e) {
      // Без AI форма всё равно заполнится текстом клиента.
      console.warn(`inbox: черновик заявки без AI (${id}): ${errText(e)}`);
      return base;
    }
  },
});
