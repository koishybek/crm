// Наружу — только явные DTO в форме типов фронта (src/data/types.ts), никогда сырые документы.
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { payout } from "../../src/data/logic";
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

async function withUrls(ctx: QueryCtx, files: Doc<"orders">["files"]): Promise<Attachment[]> {
  return Promise.all(
    files.map(async (f) => ({ id: f.id, name: f.name, kind: f.kind, src: f.storageId ? ((await ctx.storage.getUrl(f.storageId)) ?? undefined) : undefined })),
  );
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
  payoutPaid: o.payoutPaid,
  executorId: o.executorId,
  assignedAt: o.assignedAt,
  createdAt: o.createdAt,
  createdBy: o.createdBy,
  doneAt: o.doneAt,
  paidAt: o.paidAt,
  closedAt: o.closedAt,
  cancelReason: o.cancelReason,
  requiredSkills: o.requiredSkills,
  files: o.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
});

export const toOrderWithFiles = async (ctx: QueryCtx, o: Doc<"orders">): Promise<Order> => ({ ...toOrder(o), files: await withUrls(ctx, o.files) });

/**
 * Заказ глазами исполнителя: без цены клиента, маржи и платежей. Адрес и контакты —
 * только после подтверждения (до этого исполнитель видит город).
 */
export async function toWorkerOrder(ctx: QueryCtx, o: Doc<"orders">, opts: { contacts: boolean; files: boolean }): Promise<WorkerOrder> {
  return {
    id: o._id,
    number: o.number,
    serviceId: o.serviceId,
    category: o.category,
    description: o.description,
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
    files: opts.files ? await withUrls(ctx, o.files) : [],
  };
}

export async function toMessage(ctx: QueryCtx, m: Doc<"messages">): Promise<Message> {
  return { id: m._id, orderId: m.orderId, author: m.author, channel: m.channel, text: m.text, files: await withUrls(ctx, m.files), at: m.at };
}

export const toHistory = (h: Doc<"history">): HistoryEvent => ({ id: h._id, orderId: h.orderId, kind: h.kind, text: h.text, actor: h.actor, at: h.at });

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

/** Звонок. Ссылку на запись отдаём только в карточке (withMedia) — список лёгкий. */
export async function toCall(ctx: QueryCtx, c: Doc<"calls">, withMedia: boolean): Promise<Call> {
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
    recordingSrc: withMedia ? (c.recordingId ? ((await ctx.storage.getUrl(c.recordingId)) ?? undefined) : c.recordingUrl && checkPublicUrl(c.recordingUrl).ok ? c.recordingUrl : undefined) : undefined,
    transcript: withMedia ? c.transcript : undefined,
    ai: c.ai,
    draft: c.draft,
    aiStatus: c.aiStatus,
    aiError: c.aiError,
  };
}

export const toNotification = (n: Doc<"notifications">): Notification => ({ id: n._id, userId: n.userId, text: n.text, link: n.link, at: n.at, read: n.read, tone: n.tone });
