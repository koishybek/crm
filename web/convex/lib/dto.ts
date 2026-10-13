// Наружу — только явные DTO в форме типов фронта (src/data/types.ts), никогда сырые документы.
// Ссылки на файлы — подписанные и короткоживущие (lib/files.ts → fileSigner).
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { payout } from "../../src/data/logic";
import type { FileSigner } from "./files";
import { checkPublicUrl } from "./safeFetch";
import type {
  Attachment,
  Call,
  Client,
  ClientNote,
  Executor,
  HistoryEvent,
  Interaction,
  Lead,
  Message,
  Notification,
  Order,
  User,
  WorkerOrder,
} from "../../src/data/types";

export const toUser = (u: Doc<"users">): User => ({
  id: u._id,
  tenantId: u.tenantId ?? "",
  name: u.name ?? "",
  role: u.role ?? "operator",
  email: u.email ?? "",
  phone: u.phone ?? "",
  executorId: u.executorId,
  active: u.active !== false,
  telegram: !!u.telegramChatId,
  categories: u.categories,
  mustChangePassword: u.mustChangePassword === true ? true : undefined,
});

export const toExecutor = (e: Doc<"executors">): Executor => ({
  id: e._id,
  tenantId: e.tenantId,
  name: e.name,
  phone: e.phone,
  city: e.city,
  categories: e.categories,
  skills: e.skills,
  available: e.available,
  rating: e.rating,
  reviews: e.reviews,
  cooperation: e.cooperation,
  joinedAt: e.joinedAt,
});

export const toClient = (c: Doc<"clients">): Client => ({
  id: c._id,
  tenantId: c.tenantId,
  name: c.name,
  kind: c.kind,
  // У обезличенного клиента в базе — заглушка ради уникального индекса; наружу телефона нет.
  phone: c.anonymizedAt ? "" : c.phone,
  email: c.email,
  city: c.city,
  address: c.address,
  source: c.source,
  preferredChannel: c.preferredChannel,
  tags: c.tags,
  notes: c.notes,
  createdAt: c.createdAt,
  ordersCount: c.ordersCount,
  activeCount: c.activeCount,
  lastOrderAt: c.lastOrderAt,
  anonymizedAt: c.anonymizedAt,
});

export const toLead = (l: Doc<"leads">): Lead => ({
  id: l._id,
  tenantId: l.tenantId,
  number: l.number,
  clientId: l.clientId,
  clientName: l.clientName,
  clientPhone: l.clientPhone,
  source: l.source,
  serviceId: l.serviceId,
  city: l.city,
  description: l.description,
  urgency: l.urgency,
  status: l.status,
  operatorId: l.operatorId,
  createdAt: l.createdAt,
  orderId: l.orderId,
  comment: l.comment,
  rejectReason: l.rejectReason,
  ai: l.ai,
  callId: l.callId,
});

type StoredFile = Doc<"orders">["files"][number];

/** Вложение со ссылкой. Документам — имя для скачивания; shown — видно ли его мастеру. */
const toAttachment = (f: StoredFile, signer: FileSigner, shown: boolean = f.forExecutor === true): Attachment => ({
  id: f.id,
  name: f.name,
  kind: f.kind,
  src: signer.url(f.storageId, f.kind === "file" ? f.name : undefined),
  forExecutor: shown,
});

/** Файлы заказа, которые видит мастер (аудит M-6): отмеченные «Показать мастеру» — в том числе всё из переписки с ним. */
export const executorFiles = (files: readonly StoredFile[]): StoredFile[] => files.filter((f) => f.forExecutor === true && f.storageId !== undefined);

/**
 * Переписка мастера по заказу — только канал «С мастером» (аудит M-6, E15): внутренние заметки и переписка по клиенту
 * ему не видны. Сообщения другого мастера (заказ мог перейти от него) тоже не показываем — это его разговор с командой.
 */
export async function executorThread(ctx: QueryCtx, orderId: Id<"orders">, me: Id<"users">): Promise<Doc<"messages">[]> {
  const rows = (
    await ctx.db
      .query("messages")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .collect()
  ).filter((m) => m.channel === "executor");
  const roles = new Map<string, string | undefined>();
  for (const m of rows) {
    if (m.author.type !== "user" || m.author.id === me || roles.has(m.author.id)) continue;
    const id = ctx.db.normalizeId("users", m.author.id);
    roles.set(m.author.id, id ? (await ctx.db.get(id))?.role : undefined);
  }
  return rows.filter((m) => m.author.type !== "user" || m.author.id === me || roles.get(m.author.id) !== "executor");
}

const PHONE = /(?:\+?7|8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}/g;
/** Хвосты AI-описания до исправления разбора: «Бюджет клиента: … .» и «Адрес: … .» (перед «Когда:», бюджетом или в конце). */
const AI_BUDGET = /\s*Бюджет клиента:[^.\n]*\.?/g;
const AI_ADDRESS = /\s*Адрес: .*?\.(?=\s+(?:Когда|Бюджет клиента):|\s*$)/g;

/**
 * Описание заказа глазами мастера (аудит H-3): бюджета клиента и адреса из AI-разбора нет никогда, телефоны в тексте —
 * только когда мастеру открыты контакты клиента. Сотрудники видят описание как есть.
 */
export function describeForExecutor(text: string, contacts: boolean): string {
  const clean = text.replace(AI_BUDGET, "").replace(AI_ADDRESS, "").trim();
  return contacts ? clean : clean.replace(PHONE, "[номер скрыт]");
}

/** Заказ для сотрудника. Файлы без ссылок — ссылки отдаёт только карточка заказа. */
export const toOrder = (o: Doc<"orders">): Order => ({
  id: o._id,
  tenantId: o.tenantId,
  number: o.number,
  clientId: o.clientId,
  clientName: o.clientName,
  clientPhone: o.clientPhone,
  leadId: o.leadId,
  source: o.source,
  serviceId: o.serviceId,
  category: o.category,
  description: o.description,
  city: o.city,
  address: o.address,
  deadline: o.deadline,
  priority: o.priority,
  status: o.status,
  clientPrice: o.clientPrice,
  payoutMode: o.payoutMode,
  payoutValue: o.payoutValue,
  payments: o.payments,
  refunds: o.refunds,
  payoutPaid: o.payoutPaid,
  payoutPaidAt: o.payoutPaidAt,
  payoutId: o.payoutId,
  acceptedPayout: o.acceptedPayout,
  executorId: o.executorId,
  assignedAt: o.assignedAt,
  createdAt: o.createdAt,
  createdBy: o.createdBy,
  doneAt: o.doneAt,
  paidAt: o.paidAt,
  closedAt: o.closedAt,
  cancelReason: o.cancelReason,
  requiredSkills: o.requiredSkills,
  files: o.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind, forExecutor: f.forExecutor === true })),
});

export const toOrderWithFiles = (o: Doc<"orders">, signer: FileSigner): Order => ({ ...toOrder(o), files: o.files.map((f) => toAttachment(f, signer)) });

/**
 * Заказ глазами исполнителя: без цены клиента, маржи и платежей. Адрес и контакты — только пока заказ у него в работе
 * (contactsOpen в src/data/logic.ts). Файлы — только видимые мастеру и только если передан signer.
 */
export function toWorkerOrder(o: Doc<"orders">, opts: { contacts: boolean; signer?: FileSigner }): WorkerOrder {
  return {
    id: o._id,
    number: o.number,
    serviceId: o.serviceId,
    category: o.category,
    description: describeForExecutor(o.description, opts.contacts),
    city: o.city,
    deadline: o.deadline,
    priority: o.priority,
    status: o.status,
    createdAt: o.createdAt,
    assignedAt: o.assignedAt,
    doneAt: o.doneAt,
    cancelReason: o.cancelReason,
    payout: payout(o),
    payoutPaid: o.payoutPaid,
    address: opts.contacts ? o.address : undefined,
    clientName: opts.contacts ? o.clientName : undefined,
    clientPhone: opts.contacts ? o.clientPhone : undefined,
    requiredSkills: o.requiredSkills,
    files: opts.signer ? executorFiles(o.files).map((f) => toAttachment(f, opts.signer!, true)) : [],
  };
}

/**
 * Сообщение заказа со ссылками на файлы. shown — id файлов заказа, видимых мастеру: отметка у вложения в карточке
 * сотрудника (вложения переписки с мастером видны ему всегда).
 */
export function toMessage(m: Doc<"messages">, signer: FileSigner, shown?: ReadonlySet<string>): Message {
  const files = m.files.map((f) => toAttachment(f, signer, m.channel === "executor" || (shown ? shown.has(f.id) : f.forExecutor === true)));
  return { id: m._id, orderId: m.orderId, author: m.author, channel: m.channel, text: m.text, files, at: m.at };
}

export const toHistory = (h: Doc<"history">): HistoryEvent => ({ id: h._id, orderId: h.orderId, kind: h.kind, text: h.text, actor: h.actor, at: h.at, from: h.from, to: h.to });

export const toInteraction = (i: Doc<"interactions">): Interaction => ({
  id: i._id,
  clientId: i.clientId,
  kind: i.kind,
  channel: i.channel,
  title: i.title,
  text: i.text,
  at: i.at,
  leadId: i.leadId,
});

export const toNote = (n: Doc<"clientNotes">): ClientNote => ({ id: n._id, clientId: n.clientId, authorId: n.authorId, text: n.text, at: n.at });

/** Звонок. Ссылку на запись и расшифровку отдаём только в карточке (media — подписывает ссылку) — список лёгкий. */
export function toCall(c: Doc<"calls">, media: FileSigner | null): Call {
  return {
    id: c._id,
    direction: c.direction,
    from: c.from,
    to: c.to,
    clientId: c.clientId,
    clientName: c.clientName,
    leadId: c.leadId,
    operatorId: c.operatorId,
    status: c.status,
    startedAt: c.startedAt,
    endedAt: c.endedAt,
    duration: c.duration,
    hasRecording: !!(c.recordingId || c.recordingUrl),
    // Внешнюю ссылку АТС отдаём в браузер, только если это публичный https-адрес (аудит M-3).
    recordingSrc: media ? (c.recordingId ? media.url(c.recordingId) : c.recordingUrl && checkPublicUrl(c.recordingUrl).ok ? c.recordingUrl : undefined) : undefined,
    transcript: media ? c.transcript : undefined,
    ai: c.ai,
    draft: c.draft,
    aiStatus: c.aiStatus,
    aiError: c.aiError,
  };
}

export const toNotification = (n: Doc<"notifications">): Notification => ({ id: n._id, userId: n.userId, text: n.text, link: n.link, at: n.at, read: n.read, tone: n.tone });
