// Звонки (ТЗ п.7–8, «Телефония»): события АТС через вебхук или запись, загруженная вручную.
// Входящий → ищем клиента по номеру → карточка всплывает у операторов; запись → AI → черновик заявки.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { OWNER, requireRole, STAFF } from "./lib/access";
import { almatyStamp, audit, maskPhone } from "./lib/audit";
import { nextNumber, notify, nowIso, staffIds, TENANT } from "./lib/domain";
import { toCall } from "./lib/dto";
import { normalizeLogin } from "./lib/login";
import { insertClient } from "./clients";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { aiSummary } from "./schema";
import { CITIES } from "../src/data/catalog";
import { phone as fmtPhone, shortName } from "../src/lib/format";

/** Номер клиента в звонке: у входящего — кто звонит, у исходящего — кому. */
const clientNumber = (c: Pick<Doc<"calls">, "direction" | "from" | "to">) => (c.direction === "in" ? c.from : c.to);
const validPhone = (p: string) => /^7\d{10}$/.test(p);
const normPhone = (raw?: string) => (raw ? normalizeLogin(raw.replace(/[^\d+]/g, "")) : "");

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, STAFF);
    const rows = await ctx.db.query("calls").withIndex("by_started").order("desc").take(300);
    return Promise.all(rows.map((c) => toCall(ctx, c, false)));
  },
});

export const get = query({
  args: { id: v.id("calls") },
  handler: async (ctx, { id }) => {
    await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    if (!c) return null;
    const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
    return { call: await toCall(ctx, c, true), lead: lead ? { id: lead._id, number: lead.number, orderId: lead.orderId ?? null } : null };
  },
});

/** Идущие сейчас звонки — для всплывающей карточки у операторов. */
export const live = query({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    await requireRole(ctx, STAFF);
    const since = new Date(now - 30 * 60_000).toISOString();
    const rows = [
      ...(await ctx.db.query("calls").withIndex("by_status", (q) => q.eq("status", "ringing").gte("startedAt", since)).collect()),
      ...(await ctx.db.query("calls").withIndex("by_status", (q) => q.eq("status", "answered").gte("startedAt", since)).collect()),
    ];
    return Promise.all(
      rows.map(async (c) => {
        const client = c.clientId ? await ctx.db.get(c.clientId) : null;
        const last = client ? await ctx.db.query("orders").withIndex("by_client", (q) => q.eq("clientId", client._id)).order("desc").first() : null;
        return {
          call: await toCall(ctx, c, false),
          client: client ? { id: client._id, name: client.name, city: client.city, ordersCount: client.ordersCount, activeCount: client.activeCount, tags: client.tags } : null,
          lastOrder: last ? { id: last._id, number: last.number, serviceId: last.serviceId, status: last.status } : null,
        };
      }),
    );
  },
});

/**
 * Оператор загрузил запись разговора (если АТС ещё не подключена).
 * autoLead=false — запись загружена из формы новой заявки: AI только заполняет форму, заявку сохраняет оператор.
 */
export const upload = mutation({
  args: { storageId: v.id("_storage"), phone: v.optional(v.string()), autoLead: v.optional(v.boolean()) },
  handler: async (ctx, { storageId, phone, autoLead }): Promise<Id<"calls">> => {
    const me = await requireRole(ctx, STAFF);
    const p = normPhone(phone);
    const client = validPhone(p) ? await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", p)).first() : null;
    const id = await ctx.db.insert("calls", {
      tenantId: TENANT,
      direction: "in",
      from: p,
      to: "",
      clientId: client?._id,
      clientName: client?.name,
      operatorId: me._id,
      status: "completed",
      startedAt: nowIso(),
      recordingId: storageId,
      aiStatus: "pending",
    });
    await ctx.scheduler.runAfter(0, internal.ai.processCall, { callId: id, autoLead });
    // Номер в журнале — только последними цифрами: журнал не должен становиться копией базы клиентов.
    const who = client ? ` — ${shortName(client.name)}` : validPhone(p) ? ` — номер ${maskPhone(p)}` : "";
    await audit(ctx, me, "call.uploaded", `Загружена запись разговора${who}: ${autoLead === false ? "AI заполнит форму заявки" : "AI разберёт её и создаст заявку"}`, {
      entityId: id,
      meta: { clientId: client?._id, autoLead: autoLead !== false },
    });
    return id;
  },
});

export const reprocess = mutation({
  args: { id: v.id("calls") },
  handler: async (ctx, { id }): Promise<void> => {
    await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Звонок не найден");
    if (!c.recordingId && !c.recordingUrl) throw new ConvexError("У звонка нет записи");
    await ctx.db.patch(id, { aiStatus: "pending", aiError: undefined });
    await ctx.scheduler.runAfter(0, internal.ai.processCall, { callId: id });
  },
});

/**
 * Заявка создана из звонка вручную — связываем. Связь одна на звонок и одна на заявку:
 * чужую не перезаписываем, иначе звонок «переехал» бы к другой заявке без следа.
 */
export const linkLead = mutation({
  args: { id: v.id("calls"), leadId: v.id("leads") },
  handler: async (ctx, { id, leadId }) => {
    const me = await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Звонок не найден");
    const lead = await ctx.db.get(leadId);
    if (!lead) throw new ConvexError("Заявка не найдена");
    if (c.leadId === leadId && lead.callId === id) return;
    if (c.leadId && c.leadId !== leadId) throw new ConvexError("Звонок уже привязан к другой заявке");
    if (lead.callId && lead.callId !== id) throw new ConvexError("К заявке уже привязан другой звонок");
    await ctx.db.patch(id, { leadId, ...(c.clientId ? {} : { clientId: lead.clientId, clientName: lead.clientName }) });
    await ctx.db.patch(leadId, { callId: id });
    await audit(ctx, me, "call.linked", `Звонок ${almatyStamp(c.startedAt)} привязан к заявке №${lead.number}`, { entityId: id, meta: { leadId } });
  },
});

// ── Внутреннее ───────────────────────────────────────────────────────────────

export const _get = internalQuery({
  args: { id: v.id("calls") },
  handler: async (ctx, { id }): Promise<Doc<"calls"> | null> => ctx.db.get(id),
});

async function ownerId(ctx: QueryCtx): Promise<Id<"users"> | null> {
  return (await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).first())?._id ?? null;
}

/** Заявка из звонка по черновику AI. Без валидного номера или услуги — не создаём (оператор доделает руками). */
async function leadFromCall(ctx: MutationCtx, c: Doc<"calls">): Promise<Id<"leads"> | null> {
  const p = clientNumber(c);
  const serviceId = c.draft?.serviceId;
  if (!validPhone(p) || !serviceId || c.leadId) return null;
  const cat = await loadCatalog(ctx);
  const svc = cat.services.find((s) => s.id === serviceId);
  if (!svc) return null;
  const city = c.draft?.city && CITIES.some((x) => x === c.draft!.city) ? c.draft.city : (c.draft?.city ?? env("COMPANY_CITY") ?? "Алматы");
  let client = await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", p)).first();
  const newClient = !client;
  if (!client) {
    const id = await insertClient(ctx, { name: c.draft?.clientName ?? `Клиент ${fmtPhone(p)}`, phone: p, city, address: c.draft?.address, source: "phone" });
    client = (await ctx.db.get(id))!;
  }
  const operatorId = c.operatorId ?? (await ownerId(ctx));
  if (!operatorId) return null;
  const at = nowIso();
  const number = await nextNumber(ctx);
  const leadId = await ctx.db.insert("leads", {
    tenantId: TENANT,
    number,
    clientId: client._id,
    clientName: client.name,
    clientPhone: client.phone,
    source: "phone",
    serviceId,
    city,
    description: c.draft?.description ?? c.ai?.summary ?? "Звонок клиента",
    urgency: c.draft?.urgency ?? "normal",
    status: "new",
    operatorId,
    createdAt: at,
    ai: c.ai,
    callId: c._id,
  });
  await ctx.db.insert("interactions", { clientId: client._id, kind: "call", channel: "phone", title: "Звонок · разобран AI", text: c.ai?.summary ?? "", at: c.startedAt });
  await ctx.db.insert("interactions", { clientId: client._id, kind: "lead", channel: "phone", title: "Новая заявка", text: svc.label, at, leadId });
  await ctx.db.patch(client._id, { lastActivityAt: at });
  await ctx.db.patch(c._id, { leadId, clientId: client._id, clientName: client.name });
  // Заявку завёл не человек — автор записи «AI» (ТЗ п.27): оператор видит, что её надо проверить.
  await audit(ctx, "AI", "lead.created", `Заявка №${number}: ${svc.label} — ${shortName(client.name)}${newClient ? " (новый клиент)" : ""}, звонок разобран AI`, {
    entityId: leadId,
    meta: { source: "phone", serviceId, city, urgency: c.draft?.urgency ?? "normal", clientId: client._id, newClient, callId: c._id, ai: true },
  });
  await notify(ctx, await staffIds(ctx, svc.category), `Звонок разобран AI → заявка №${number}: ${svc.label} (${client.name})`, { link: `/leads?open=${leadId}`, tone: "info" });
  return leadId;
}

export const _saveAi = internalMutation({
  args: {
    id: v.id("calls"),
    status: v.union(v.literal("done"), v.literal("failed"), v.literal("none")),
    recordingId: v.optional(v.id("_storage")),
    transcript: v.optional(v.string()),
    ai: v.optional(aiSummary),
    draft: v.optional(
      v.object({
        serviceId: v.optional(v.string()),
        city: v.optional(v.string()),
        address: v.optional(v.string()),
        urgency: v.optional(v.union(v.literal("normal"), v.literal("high"), v.literal("urgent"))),
        clientName: v.optional(v.string()),
        description: v.optional(v.string()),
      }),
    ),
    error: v.optional(v.string()),
    autoLead: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<void> => {
    const c = await ctx.db.get(a.id);
    if (!c) return;
    await ctx.db.patch(a.id, {
      aiStatus: a.status,
      aiError: a.error,
      ...(a.recordingId ? { recordingId: a.recordingId } : {}),
      ...(a.transcript !== undefined ? { transcript: a.transcript.slice(0, 20000) } : {}),
      ...(a.ai ? { ai: a.ai } : {}),
      ...(a.draft ? { draft: a.draft } : {}),
    });
    if (a.status === "done" && a.autoLead) await leadFromCall(ctx, (await ctx.db.get(a.id))!);
  },
});

/** Событие от АТС (см. http.ts → /pbx/events). Повторы одного события безопасны. */
export const _ingest = internalMutation({
  args: {
    event: v.string(),
    externalId: v.optional(v.string()),
    direction: v.optional(v.union(v.literal("in"), v.literal("out"))),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
    operator: v.optional(v.string()),
    duration: v.optional(v.number()),
    recordingUrl: v.optional(v.string()),
    at: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<Id<"calls">> => {
    const event = a.event.toLowerCase();
    const at = a.at && !Number.isNaN(Date.parse(a.at)) ? new Date(a.at).toISOString() : nowIso();
    let c = a.externalId ? await ctx.db.query("calls").withIndex("by_external", (q) => q.eq("externalId", a.externalId)).first() : null;
    if (!c) {
      const direction = a.direction ?? "in";
      const from = normPhone(a.from);
      const to = normPhone(a.to);
      const p = direction === "in" ? from : to;
      const client = validPhone(p) ? await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", p)).first() : null;
      const id = await ctx.db.insert("calls", {
        tenantId: TENANT,
        externalId: a.externalId,
        direction,
        from,
        to,
        clientId: client?._id,
        clientName: client?.name,
        status: "ringing",
        startedAt: at,
        aiStatus: "none",
      });
      c = (await ctx.db.get(id))!;
    }
    const patch: Partial<Doc<"calls">> = {};
    if (a.operator) {
      const login = normalizeLogin(a.operator);
      const u = await ctx.db.query("users").withIndex("email", (q) => q.eq("email", login)).first();
      if (u && u.role !== "executor") patch.operatorId = u._id;
    }
    if (event === "answered") patch.status = "answered";
    if (["ended", "completed", "hangup", "end"].includes(event)) {
      patch.status = c.status === "ringing" && !a.duration ? "missed" : "completed";
      patch.endedAt = at;
    }
    if (event === "missed" || event === "noanswer" || event === "no_answer") {
      patch.status = "missed";
      patch.endedAt = at;
    }
    if (a.duration !== undefined && a.duration >= 0) patch.duration = Math.round(a.duration);
    if (a.recordingUrl && /^https?:\/\//.test(a.recordingUrl)) patch.recordingUrl = a.recordingUrl;
    await ctx.db.patch(c._id, patch);

    const became = patch.status;
    if (became === "missed" && c.status !== "missed") {
      const who = c.clientName ?? (c.direction === "in" ? fmtPhone(c.from) : fmtPhone(c.to));
      await notify(ctx, await staffIds(ctx), `Пропущенный звонок: ${who}`, { link: `/calls?open=${c._id}`, tone: "warn" });
    }
    // Запись пришла — разбираем один раз.
    if (patch.recordingUrl && !c.recordingUrl && c.aiStatus !== "pending" && c.aiStatus !== "done") {
      await ctx.db.patch(c._id, { aiStatus: "pending" });
      await ctx.scheduler.runAfter(0, internal.ai.processCall, { callId: c._id });
    }
    return c._id;
  },
});

// ── Настройки телефонии ──────────────────────────────────────────────────────

export const _pbxSecret = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "pbxSecret")).unique())?.value ?? null,
});

export const pbxSettings = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, OWNER);
    const secret = (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "pbxSecret")).unique())?.value ?? null;
    const site = env("CONVEX_SITE_URL");
    return { url: site ? `${site}/pbx/events` : null, secret };
  },
});

export const regeneratePbxSecret = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireRole(ctx, OWNER);
    const value = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
    const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "pbxSecret")).unique();
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key: "pbxSecret", value });
    // Сам ключ в журнал не пишем — только факт смены: АТС со старым ключом после неё получает отказ.
    await audit(ctx, me, "integration.pbxSecret", row ? "Телефония: выпущен новый ключ АТС — прежний больше не действует" : "Телефония: выпущен ключ АТС", { entityId: "pbx", meta: { rotated: !!row } });
    return value;
  },
});
