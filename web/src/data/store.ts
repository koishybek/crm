// Действия интерфейса → функции Convex. Каждое возвращает Result, текст ошибки — для тоста.
import { create } from "zustand";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ConvexError } from "convex/values";
import { convex, run, type Result } from "./convex";
import { confirmUpload, mimeOf, uploadLimitError } from "./files";
import { digits } from "../lib/format";
import type { AiSummary, Attachment, CategoryId, Client, Executor, LeadStatus, MessageChannel, Order, OrderStatus, PaymentMethod, SourceId, Urgency } from "./types";

export type { Result };

// ── Тосты ────────────────────────────────────────────────────────────────────
export interface Toast {
  id: string;
  text: string;
  tone: "ok" | "bad" | "info";
}
let toastSeq = 0;
export const useToasts = create<{ items: Toast[]; push: (text: string, tone?: Toast["tone"]) => void; drop: (id: string) => void }>()((set) => ({
  items: [],
  push: (text, tone = "ok") => {
    const id = `t${++toastSeq}`;
    set((s) => ({ items: [...s.items, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ items: s.items.filter((t) => t.id !== id) })), 4200);
  },
  drop: (id) => set((s) => ({ items: s.items.filter((t) => t.id !== id) })),
}));
export const toast = (text: string, tone?: Toast["tone"]) => useToasts.getState().push(text, tone);

/** Показать ошибку тостом и вернуть признак успеха — для коротких обработчиков. */
export function report<T>(r: Result<T>, okText?: string): r is { ok: true; value: T } {
  if (!r.ok) toast(r.error, "bad");
  else if (okText) toast(okText);
  return r.ok;
}

const oid = (id: string) => id as Id<"orders">;
const cid = (id: string) => id as Id<"clients">;
const lid = (id: string) => id as Id<"leads">;
const eid = (id: string) => id as Id<"executors">;

// ── Клиенты ──────────────────────────────────────────────────────────────────
export interface ClientInput {
  name: string;
  phone: string;
  kind?: Client["kind"];
  email?: string;
  city: string;
  address?: string;
  source: SourceId;
  preferredChannel?: SourceId;
  notes?: string;
  tags?: string[];
}
export const createClient = ({ tags: _t, ...a }: ClientInput) => (void _t, run(convex.mutation(api.clients.create, a)));
export const updateClient = (id: string, a: ClientInput) => run(convex.mutation(api.clients.update, { id: cid(id), ...a }));
export const setClientTags = (id: string, tags: string[]) => run(convex.mutation(api.clients.setTags, { id: cid(id), tags }));
export const addClientNote = (clientId: string, text: string) => run(convex.mutation(api.clients.addNote, { clientId: cid(clientId), text }));

// ── Заявки ───────────────────────────────────────────────────────────────────
export interface LeadInput {
  clientId?: string;
  clientName: string;
  phone: string;
  source: SourceId;
  serviceId: string;
  city: string;
  description: string;
  urgency: Urgency;
  comment?: string;
  /** AI-разбор, который оператор видел в форме. */
  ai?: AiSummary;
  callId?: string;
}
export const createLead = (a: LeadInput) =>
  run(convex.mutation(api.leads.create, { ...a, clientId: a.clientId ? cid(a.clientId) : undefined, callId: a.callId ? (a.callId as Id<"calls">) : undefined }));
export const updateLead = (id: string, patch: { serviceId?: string; city?: string; description?: string; urgency?: Urgency; comment?: string }) =>
  run(convex.mutation(api.leads.update, { id: lid(id), ...patch }));
export const setLeadStatus = (id: string, status: Exclude<LeadStatus, "converted">, reason?: string) => run(convex.mutation(api.leads.setStatus, { id: lid(id), status, reason }));
export const convertLead = (id: string) => run(convex.mutation(api.leads.convert, { id: lid(id) }));

// ── Заказы ───────────────────────────────────────────────────────────────────
export const updateOrderInfo = (id: string, a: Pick<Order, "serviceId" | "description" | "city" | "address" | "deadline" | "priority"> & { requiredSkills?: string[] }) =>
  run(convex.mutation(api.orders.updateInfo, { id: oid(id), ...a }));
export const updateFinance = (id: string, f: { clientPrice: number; payoutMode: Order["payoutMode"]; payoutValue: number; payoutPaid: boolean }) =>
  run(convex.mutation(api.orders.updateFinance, { id: oid(id), ...f }));
export const addPayment = (id: string, amount: number, method: PaymentMethod) => run(convex.mutation(api.orders.addPayment, { id: oid(id), amount, method }));
export const changeStatus = (id: string, to: OrderStatus, reason?: string) => run(convex.mutation(api.orders.changeStatus, { id: oid(id), to, reason }));
export const assignExecutor = (id: string, executorId: string) => run(convex.mutation(api.orders.assign, { id: oid(id), executorId: eid(executorId) }));

/**
 * Файл → хранилище Convex → подтверждение на сервере (тип, размер и владелец проверяет сервер, convex/files.ts).
 * Фото до 15 МБ, видео до 100 МБ, аудио и документы до 25 МБ.
 */
export async function uploadFile(file: File): Promise<Result<Attachment & { storageId: Id<"_storage"> }>> {
  const type = mimeOf(file);
  const tooBig = uploadLimitError(file, type);
  if (tooBig) return { ok: false, error: tooBig };
  return run(
    (async () => {
      const url = await convex.mutation(api.orders.uploadUrl, {});
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": type }, body: file });
      if (!res.ok) throw new Error("upload failed");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      const confirmed = await confirmUpload(storageId);
      if (!confirmed.ok) throw new ConvexError(confirmed.error);
      return { id: `f-${storageId}`, name: file.name, kind: confirmed.value === "image" ? ("image" as const) : ("file" as const), storageId };
    })(),
  );
}
/** Сообщение в заказе. Файлы — уже загруженные и подтверждённые (uploadFile); сервер прикрепляет только свои загрузки. */
export const addMessage = (orderId: string, text: string, channel: MessageChannel, files: { name: string; storageId?: Id<"_storage"> }[] = []) =>
  run(
    convex.mutation(api.orders.addMessage, {
      orderId: oid(orderId),
      text,
      channel,
      files: files.flatMap((f) => (f.storageId ? [{ storageId: f.storageId, name: f.name }] : [])),
    }),
  );

// ── Исполнитель ──────────────────────────────────────────────────────────────
export const takeOrder = (id: string) => run(convex.mutation(api.worker.take, { id: oid(id) }));
export type ExecAction = "accept" | "decline" | "start" | "wait" | "resume" | "done";
export const executorAction = (id: string, action: ExecAction) => run(convex.mutation(api.worker.act, { id: oid(id), action }));
export const setMyAvailability = (available: boolean) => run(convex.mutation(api.worker.setAvailable, { available }));

// ── Исполнители (для сотрудников) ────────────────────────────────────────────
export type ExecutorInput = Pick<Executor, "name" | "phone" | "city" | "categories" | "skills" | "cooperation">;
export const createExecutor = (a: ExecutorInput) => run(convex.action(api.executors.create, a));
export const updateExecutor = (id: string, a: ExecutorInput) => run(convex.mutation(api.executors.update, { id: eid(id), ...a }));
export const setExecutorAvailable = (id: string, available: boolean) => run(convex.mutation(api.executors.setAvailable, { id: eid(id), available }));

// ── Команда и прочее ─────────────────────────────────────────────────────────
export const createStaff = (a: { name: string; login: string; role: "owner" | "operator" | "manager"; categories?: string[] }) => run(convex.action(api.users.createStaff, a));
export const resetPassword = (userId: string) => run(convex.action(api.users.resetPassword, { userId: userId as Id<"users"> }));
export const setUserActive = (userId: string, active: boolean) => run(convex.mutation(api.users.setActive, { userId: userId as Id<"users">, active }));
export const markAllRead = () => run(convex.mutation(api.notifications.markAllRead, {}));

// ── Звонки и AI ──────────────────────────────────────────────────────────────
const AUDIO = /\.(mp3|wav|ogg|oga|opus|m4a|aac|webm|flac|amr|wma)$/i;
/** Переписка клиента (WhatsApp, OLX, Instagram) → поля заявки. */
export const parseLeadText = (text: string) => run(convex.action(api.ai.parseText, { text }));
/**
 * Запись разговора → звонок → AI в фоне (до минуты).
 * autoLead=false — из формы заявки: AI только заполняет форму, заявку сохраняет оператор.
 */
export async function uploadCall(file: File, opts: { phone?: string; autoLead?: boolean } = {}): Promise<Result<Id<"calls">>> {
  if (!file.type.startsWith("audio/") && !AUDIO.test(file.name)) return { ok: false, error: "Нужен аудиофайл: mp3, wav, ogg или m4a" };
  const up = await uploadFile(file);
  if (!up.ok) return up;
  const phone = opts.phone && digits(opts.phone).length === 11 ? digits(opts.phone) : undefined;
  return run(convex.mutation(api.calls.upload, { storageId: up.value.storageId, phone, autoLead: opts.autoLead }));
}
export const reprocessCall = (id: string) => run(convex.mutation(api.calls.reprocess, { id: id as Id<"calls"> }));
export const regeneratePbxSecret = () => run(convex.mutation(api.calls.regeneratePbxSecret, {}));
export const telegramLink = () => run(convex.mutation(api.telegram.linkUrl, {}));
export const telegramUnlink = () => run(convex.mutation(api.telegram.unlink, {}));

export type { CategoryId };
