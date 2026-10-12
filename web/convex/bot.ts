// Заявки от клиентов через Telegram-бота (ТЗ п.6, источник «Telegram»).
// Клиент пишет (текстом или голосом) → делится номером одной кнопкой → заявка с AI-разбором в CRM.
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, internalQuery } from "./_generated/server";
import { nextNumber, notify, nowIso, staffIds, TENANT } from "./lib/domain";
import { normalizeLogin } from "./lib/login";
import { insertClient } from "./clients";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { aiSummary } from "./schema";
import { CITIES } from "../src/data/catalog";

const OPEN_LEAD_DAYS = 3;
const MAX_DRAFT = 3000;

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

/** Новое сообщение по уже открытой заявке — оператору в историю клиента и уведомлением. */
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
    const cat = await loadCatalog(ctx);
    const category = cat.services.find((s) => s.id === l.serviceId)?.category;
    await notify(ctx, await staffIds(ctx, category), `${l.clientName} написал(а) в Telegram по заявке №${l.number}: «${text.slice(0, 80)}»`, { link: `/leads?open=${leadId}` });
  },
});

/** Клиент поделился номером — создаём (или находим) клиента и заявку. */
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
  handler: async (ctx, a): Promise<{ number: number; repeat: boolean } | null> => {
    const phone = normalizeLogin(a.phone);
    if (!/^7\d{10}$/.test(phone)) return null;
    const row = await ctx.db.query("botChats").withIndex("by_chat", (q) => q.eq("chatId", a.chatId)).first();
    const draft = row?.draft?.trim() ?? "";
    const cat = await loadCatalog(ctx);
    const active = cat.services.filter((s) => s.active !== false);
    const svc = active.find((s) => s.id === a.serviceId) ?? active.find((s) => s.id === "other") ?? active[0]!;
    const city = a.city ?? env("COMPANY_CITY") ?? CITIES[0];
    let client = await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", phone)).first();
    const repeat = !!client;
    if (!client) {
      const id = await insertClient(ctx, { name: a.name?.trim() || `Клиент из Telegram`, phone, city, address: a.address, source: "telegram", preferredChannel: "telegram" });
      client = (await ctx.db.get(id))!;
    }
    const owner = await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).first();
    if (!owner) return null;
    const at = nowIso();
    const number = await nextNumber(ctx);
    const description = (a.description || draft || "Клиент оставил заявку в Telegram").slice(0, 2000);
    const leadId = await ctx.db.insert("leads", {
      tenantId: TENANT,
      number,
      clientId: client._id,
      clientName: client.name,
      clientPhone: client.phone,
      source: "telegram",
      serviceId: svc.id,
      city,
      description,
      urgency: a.urgency ?? "normal",
      status: "new",
      operatorId: owner._id,
      createdAt: at,
      ai: a.ai,
      comment: draft && a.description && draft !== a.description ? `Сообщение клиента: ${draft.slice(0, 1500)}` : undefined,
    });
    await ctx.db.insert("interactions", { clientId: client._id, kind: "message", channel: "telegram", title: "Сообщение в Telegram", text: draft.slice(0, 1000) || "Заявка через бота", at });
    await ctx.db.insert("interactions", { clientId: client._id, kind: "lead", channel: "telegram", title: "Новая заявка", text: svc.label, at, leadId });
    await ctx.db.patch(client._id, { lastActivityAt: at });
    if (row) await ctx.db.patch(row._id, { state: "idle", draft: undefined, leadId, updatedAt: at });
    else await ctx.db.insert("botChats", { chatId: a.chatId, state: "idle", leadId, updatedAt: at });
    await notify(ctx, await staffIds(ctx, svc.category), `Новая заявка №${number} из Telegram: ${svc.id === "other" ? "услугу уточнить" : svc.label} (${client.name})`, { link: `/leads?open=${leadId}`, tone: "info" });
    return { number, repeat };
  },
});
