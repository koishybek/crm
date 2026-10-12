// Заявки от клиентов через Telegram-бота (ТЗ п.6, источник «Telegram»).
// Клиент пишет (текстом или голосом) → делится номером одной кнопкой (или пишет его текстом) → заявка с AI-разбором.
// Вся переписка параллельно ложится в «Сообщения» (inbox.ts), заявка связывается с диалогом.
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { notify, nowIso, staffIds } from "./lib/domain";
import { intakeLead } from "./lib/intake";
import { normalizeLogin } from "./lib/login";
import { hitLimit } from "./lib/rateLimit";
import { linkConversation } from "./inbox";
import { loadCatalog } from "./catalog";
import { aiSummary } from "./schema";

const OPEN_LEAD_DAYS = 3;
const MAX_DRAFT = 3000;
/** Антиспам (ТЗ п.26): сообщений от одного чата в минуту и новых заявок от одного чата в сутки. */
const CHAT_MESSAGES_PER_MIN = 20;
const CHAT_LEADS_PER_DAY = 3;
const LEAD_NOTIFY_EVERY_MS = 10 * 60_000;

/** Состояние диалога с клиентом + есть ли у него свежая открытая заявка. */
export const _state = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }) => {
    const row = await ctx.db.query("botChats").withIndex("by_chat", (q) => q.eq("chatId", chatId)).first();
    if (!row) return { state: "idle" as const, draft: "", openLead: null };
    let openLead: { id: Id<"leads">; number: number } | null = null;
    if (row.leadId && Date.now() - Date.parse(row.updatedAt) < OPEN_LEAD_DAYS * 86400_000) {
      const l = await ctx.db.get(row.leadId);
      if (l && l.status !== "rejected") openLead = { id: l._id, number: l.number };
    }
    return { state: row.state, draft: row.draft ?? "", openLead };
  },
});

/** Флуд из одного чата не разбираем: false — лимит сообщений исчерпан. */
export const _allow = internalMutation({
  args: { chatId: v.string() },
  handler: (ctx, { chatId }): Promise<boolean> => hitLimit(ctx, `tg:chat:${chatId}`, CHAT_MESSAGES_PER_MIN, 60_000),
});

/** Копим описание, пока клиент не поделился номером. */
export const _addDraft = internalMutation({
  args: { chatId: v.string(), text: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, { chatId, text, name }) => {
    const row = await ctx.db.query("botChats").withIndex("by_chat", (q) => q.eq("chatId", chatId)).first();
    const draft = [row?.state === "awaiting_phone" ? row.draft : "", text.trim()].filter(Boolean).join("\n").slice(-MAX_DRAFT);
    if (row) await ctx.db.patch(row._id, { state: "awaiting_phone", draft, name: name ?? row.name, updatedAt: nowIso() });
    else await ctx.db.insert("botChats", { chatId, state: "awaiting_phone", draft, name, updatedAt: nowIso() });
  },
});

/** Новое сообщение по уже открытой заявке — оператору в историю клиента и уведомлением (не чаще раза в 10 минут). */
export const _toOpenLead = internalMutation({
  args: { chatId: v.string(), leadId: v.id("leads"), text: v.string() },
  handler: async (ctx, { chatId, leadId, text }) => {
    const l = await ctx.db.get(leadId);
    if (!l) return;
    const at = nowIso();
    await ctx.db.insert("interactions", { clientId: l.clientId, kind: "message", channel: "telegram", title: "Сообщение в Telegram", text: text.slice(0, 1000), at, leadId });
    await ctx.db.patch(l.clientId, { lastActivityAt: at });
    const row = await ctx.db.query("botChats").withIndex("by_chat", (q) => q.eq("chatId", chatId)).first();
    if (row) await ctx.db.patch(row._id, { updatedAt: at });
    await linkConversation(ctx, "telegram", chatId, { leadId, clientId: l.clientId });
    if (!(await hitLimit(ctx, `tg:lead-notify:${leadId}`, 1, LEAD_NOTIFY_EVERY_MS))) return;
    const cat = await loadCatalog(ctx);
    const category = cat.services.find((s) => s.id === l.serviceId)?.category;
    await notify(ctx, await staffIds(ctx, category), `${l.clientName} написал(а) в Telegram по заявке №${l.number}: «${text.slice(0, 80)}»`, { link: `/leads?open=${leadId}` });
  },
});

export type BotLeadResult = { ok: true; number: number; existing: boolean } | { ok: false; reason: "phone" | "limit" | "setup" };

/** Клиент дал номер — создаём (или находим) клиента и заявку. Повторный номер к открытой заявке второй заявки не создаёт. */
export const _createLead = internalMutation({
  args: {
    chatId: v.string(),
    phone: v.string(),
    name: v.optional(v.string()),
    ai: v.optional(aiSummary),
    serviceId: v.optional(v.string()),
    city: v.optional(v.string()),
    address: v.optional(v.string()),
    urgency: v.optional(v.union(v.literal("normal"), v.literal("high"), v.literal("urgent"))),
    description: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<BotLeadResult> => {
    const phone = normalizeLogin(a.phone);
    if (!/^7\d{10}$/.test(phone)) return { ok: false, reason: "phone" };
    const row = await ctx.db.query("botChats").withIndex("by_chat", (q) => q.eq("chatId", a.chatId)).first();
    const draft = row?.draft?.trim() ?? "";
    const at = nowIso();

    // Номер прислали ещё раз (двойное нажатие, «на всякий случай») — заявка уже у оператора: дописываем к ней.
    const fresh = row?.leadId && Date.now() - Date.parse(row.updatedAt) < OPEN_LEAD_DAYS * 86400_000 ? await ctx.db.get(row.leadId) : null;
    if (row && fresh && fresh.status !== "rejected" && fresh.status !== "converted" && fresh.clientPhone === phone) {
      if (draft) await ctx.db.insert("interactions", { clientId: fresh.clientId, kind: "message", channel: "telegram", title: "Сообщение в Telegram", text: draft.slice(0, 1000), at, leadId: fresh._id });
      await ctx.db.patch(row._id, { state: "idle", draft: undefined, updatedAt: at });
      await linkConversation(ctx, "telegram", a.chatId, { leadId: fresh._id, clientId: fresh.clientId, phone });
      return { ok: true, number: fresh.number, existing: true };
    }
    if (!(await hitLimit(ctx, `tg:leads:${a.chatId}`, CHAT_LEADS_PER_DAY, 86400_000))) return { ok: false, reason: "limit" };

    const res = await intakeLead(ctx, {
      source: "telegram",
      phone,
      name: a.name,
      fallbackName: "Клиент из Telegram",
      serviceId: a.serviceId,
      city: a.city,
      address: a.address,
      urgency: a.urgency,
      description: a.description || draft || "Клиент оставил заявку в Telegram",
      comment: draft && a.description && draft !== a.description ? `Сообщение клиента: ${draft.slice(0, 1500)}` : undefined,
      ai: a.ai,
      message: { title: "Сообщение в Telegram", text: draft || "Заявка через бота" },
      actor: "Telegram",
      via: "из Telegram",
    });
    if (!res) return { ok: false, reason: "setup" };
    if (row) await ctx.db.patch(row._id, { state: "idle", draft: undefined, leadId: res.leadId, updatedAt: at });
    else await ctx.db.insert("botChats", { chatId: a.chatId, state: "idle", leadId: res.leadId, updatedAt: at });
    await linkConversation(ctx, "telegram", a.chatId, { leadId: res.leadId, clientId: res.clientId, phone });
    return { ok: true, number: res.number, existing: false };
  },
});
