// Звонки (ТЗ п.7–8, «Телефония»): события АТС через вебхук или запись, загруженная вручную.
// Входящий → ищем клиента по номеру → карточка всплывает у операторов; запись → AI → черновик заявки.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { OWNER, requirePerm, requireRole } from "./lib/access";
import { almatyStamp, audit, maskPhone } from "./lib/audit";
import { nextNumber, notify, nowIso, staffIds } from "./lib/domain";
import { queueStats } from "./lib/stats";
import { toCall } from "./lib/dto";
import { markError, markOk } from "./lib/health";
import { normalizeLogin } from "./lib/login";
import { isClientPhone, pbxPhone } from "./lib/phone";
import { districtOrNone } from "./lib/districts";
import { dropFile, fileSigner, takeUpload } from "./lib/files";
import { hitLimit } from "./lib/rateLimit";
import { emitEvent } from "./lib/webhookEvents";
import { insertClient } from "./clients";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { dialHandler } from "./pbx";
import type { DialResult } from "../src/data/pbx";
import { aiDraft, aiSummary } from "./schema";
import { normalizeCity } from "../src/data/cities";
import { phone as fmtPhone, shortName } from "../src/lib/format";
import { boundTenant, tenantOf, tenantOfDoc, unscopedDb } from "./lib/tenantDb";
import { hasModule, requireModule } from "./lib/tenant";
import { safeEqual } from "./lib/crypto";
import { lineSources, sourceOf } from "./lib/lineSources";

/** Номер клиента в звонке: у входящего — кто звонит, у исходящего — кому. */
const clientNumber = (c: Pick<Doc<"calls">, "direction" | "from" | "to">) => (c.direction === "in" ? c.from : c.to);
/** Номер клиента, которого можно искать в базе: казахстанский или иностранный (ТЗ п.7.1, E26). */
const validPhone = isClientPhone;
const normPhone = (raw?: string) => (raw ? pbxPhone(raw) : "");

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requirePerm(ctx, "calls.view");
    const rows = await ctx.db.query("calls").withIndex("by_started").order("desc").take(300);
    return rows.map((c) => toCall(c, null));
  },
});

/** Карточка звонка с записью и расшифровкой. t — метка обновления подписанной ссылки на запись (src/data/files.ts). */
export const get = query({
  args: { id: v.id("calls"), t: v.optional(v.number()) },
  handler: async (ctx, { id }) => {
    await requirePerm(ctx, "calls.view");
    const c = await ctx.db.get(id);
    if (!c) return null;
    const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
    return { call: toCall(c, await fileSigner(ctx)), lead: lead ? { id: lead._id, number: lead.number, orderId: lead.orderId ?? null } : null };
  },
});

/** Идущие сейчас звонки — для всплывающей карточки у операторов. */
export const live = query({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    await requirePerm(ctx, "calls.view");
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
          call: toCall(c, null),
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
 * Запись — только своя подтверждённая загрузка и только аудио до 25 МБ (аудит M-10: большой файл ронял разбор).
 */
export const upload = mutation({
  args: { storageId: v.id("_storage"), phone: v.optional(v.string()), autoLead: v.optional(v.boolean()) },
  handler: async (ctx, { storageId, phone, autoLead }): Promise<Id<"calls">> => {
    const me = await requirePerm(ctx, "calls.view");
    await takeUpload(ctx, me._id, storageId, ["audio"]);
    const p = normPhone(phone);
    const client = validPhone(p) ? await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", p)).first() : null;
    const id = await ctx.db.insert("calls", {
      tenantId: tenantOf(ctx),
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
    await requirePerm(ctx, "calls.view");
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Звонок не найден");
    if (!c.recordingId && !c.recordingUrl) throw new ConvexError("У звонка нет записи");
    await ctx.db.patch(id, { aiStatus: "pending", aiError: undefined });
    await ctx.scheduler.runAfter(0, internal.ai.processCall, { callId: id });
  },
});

/**
 * Заявка создана из звонка вручную — связываем (E25). Связь одна на звонок и одна на заявку: чужую не перезаписываем,
 * иначе звонок «переехал» бы к другой заявке без следа. Звонок клиента, которого система уже узнала, к заявке другого
 * клиента не привязываем.
 */
export const linkLead = mutation({
  args: { id: v.id("calls"), leadId: v.id("leads") },
  handler: async (ctx, { id, leadId }) => {
    const me = await requirePerm(ctx, "calls.view");
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Звонок не найден");
    const lead = await ctx.db.get(leadId);
    if (!lead) throw new ConvexError("Заявка не найдена");
    if (c.leadId === leadId && lead.callId === id) return;
    if (c.leadId && c.leadId !== leadId) throw new ConvexError("Звонок уже привязан к другой заявке");
    if (lead.callId && lead.callId !== id) throw new ConvexError("К заявке уже привязан другой звонок");
    if (c.clientId && c.clientId !== lead.clientId) throw new ConvexError("Это звонок другого клиента — привяжите его к заявке этого клиента");
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

/**
 * Заявка из звонка по черновику AI. Без валидного номера или услуги — не создаём (оператор доделает руками).
 * Ведёт её тот, кто принял (или загрузил) звонок: он уже говорил с клиентом. Звонок без оператора — заявка ничья,
 * пока её не возьмут в работу (E12): на владельца её не записываем.
 */
async function leadFromCall(ctx: MutationCtx, c: Doc<"calls">): Promise<Id<"leads"> | null> {
  const p = clientNumber(c);
  const serviceId = c.draft?.serviceId;
  if (!validPhone(p) || !serviceId || c.leadId) return null;
  const cat = await loadCatalog(ctx);
  const svc = cat.services.find((s) => s.id === serviceId);
  if (!svc) return null;
  const city = normalizeCity(c.draft?.city) || normalizeCity(env("COMPANY_CITY")) || "Алматы";
  // Звонок на номер из объявлений OLX (или другой линии с источником) — заявка с этим источником, не «Телефон».
  const source = sourceOf(c, await lineSources(ctx));
  let client = await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", p)).first();
  const newClient = !client;
  if (!client) {
    const id = await insertClient(ctx, { name: c.draft?.clientName ?? `Клиент ${fmtPhone(p)}`, phone: p, city, address: c.draft?.address, source });
    client = (await ctx.db.get(id))!;
  }
  const at = nowIso();
  const number = await nextNumber(ctx);
  const leadId = await ctx.db.insert("leads", {
    tenantId: tenantOf(ctx),
    number,
    clientId: client._id,
    clientName: client.name,
    clientPhone: client.phone,
    source,
    serviceId,
    city,
    description: c.draft?.description ?? c.ai?.summary ?? "Звонок клиента",
    urgency: c.draft?.urgency ?? "normal",
    status: "new",
    operatorId: c.operatorId,
    origin: "ai",
    // Оператор звонка уже говорил с клиентом — первое действие было; без оператора заявку ещё никто не видел.
    firstActionAt: c.operatorId ? at : undefined,
    createdAt: at,
    ai: c.ai,
    callId: c._id,
    // Адрес — не в описание (оно уходит мастерам в ленту, аудит H-3), а полем заявки: в заказ он перейдёт сам.
    address: c.draft?.address?.slice(0, 300),
    preferredTime: c.draft?.when?.slice(0, 120),
    budget: c.draft?.budget,
    district: await districtOrNone(ctx, city, c.draft?.district),
  });
  await ctx.db.insert("interactions", { clientId: client._id, kind: "call", channel: "phone", title: "Звонок · разобран AI", text: c.ai?.summary ?? "", at: c.startedAt });
  await ctx.db.insert("interactions", { clientId: client._id, kind: "lead", channel: "phone", title: "Новая заявка", text: svc.label, at, leadId });
  await queueStats(ctx, "lead", leadId);
  await ctx.db.patch(client._id, { lastActivityAt: at });
  await ctx.db.patch(c._id, { leadId, clientId: client._id, clientName: client.name });
  // Заявку завёл не человек — автор записи «AI» (ТЗ п.27): оператор видит, что её надо проверить.
  await audit(ctx, "AI", "lead.created", `Заявка №${number}: ${svc.label} — ${shortName(client.name)}${newClient ? " (новый клиент)" : ""}, звонок разобран AI`, {
    entityId: leadId,
    meta: { source, serviceId, city, urgency: c.draft?.urgency ?? "normal", clientId: client._id, newClient, callId: c._id, ai: true },
  });
  await notify(ctx, await staffIds(ctx, svc.category), `Звонок разобран AI → заявка №${number}: ${svc.label} (${client.name})`, { link: `/leads?open=${leadId}`, tone: "info", email: { kind: "lead_new", text: `Новая заявка №${number} по звонку: ${svc.label}` } });
  await emitEvent(ctx, "lead.created", { leadId });
  return leadId;
}

export const _saveAi = internalMutation({
  args: {
    id: v.id("calls"),
    status: v.union(v.literal("done"), v.literal("failed"), v.literal("none")),
    recordingId: v.optional(v.id("_storage")),
    transcript: v.optional(v.string()),
    ai: v.optional(aiSummary),
    draft: v.optional(aiDraft),
    error: v.optional(v.string()),
    autoLead: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<void> => {
    const c = await ctx.db.get(a.id);
    if (!c) return;
    // Пока шёл разбор, данные клиента удалили по его запросу: результат не сохраняем, скачанную запись — тоже.
    if (c.clientId && (await ctx.db.get(c.clientId))?.anonymizedAt) {
      if (a.recordingId && a.recordingId !== c.recordingId) await dropFile(ctx, a.recordingId);
      await ctx.db.patch(a.id, { recordingUrl: undefined, aiStatus: "none" });
      return;
    }
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
    // Время события — только в пределах суток от «сейчас»: иначе звонок «из 1970-го» или «из будущего» ломает списки и отчёты (аудит L-2).
    const t = a.at ? Date.parse(a.at) : NaN;
    const at = Number.isFinite(t) && Math.abs(t - Date.now()) <= 86400_000 ? new Date(t).toISOString() : nowIso();
    let c = a.externalId ? await ctx.db.query("calls").withIndex("by_external", (q) => q.eq("externalId", a.externalId)).first() : null;
    if (!c) {
      const direction = a.direction ?? "in";
      const from = normPhone(a.from);
      const to = normPhone(a.to);
      const p = direction === "in" ? from : to;
      const client = validPhone(p) ? await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", p)).first() : null;
      const id = await ctx.db.insert("calls", {
        tenantId: tenantOf(ctx),
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
      const ext = a.operator.trim();
      // Провайдеры АТС присылают внутренний номер сотрудника (pbx.ts) — ищем и по нему.
      const u =
        (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", login)).first()) ??
        (/^\d{1,8}$/.test(ext) ? await ctx.db.query("users").withIndex("by_pbx_extension", (q) => q.eq("pbxExtension", ext)).first() : null);
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
    // Ссылку сохраняем как прислали: безопасность адреса проверяет скачивание (ai.processCall), отказ виден на звонке.
    if (a.recordingUrl && a.recordingUrl.length <= 2000 && /^https?:\/\//.test(a.recordingUrl)) patch.recordingUrl = a.recordingUrl;
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
    await markOk(ctx, "pbx", "Событие АТС принято");
    return c._id;
  },
});

/**
 * «Позвонить через АТС» из карточки клиента, заявки или заказа (ТЗ п.19.1): АТС звонит сотруднику на его внутренний номер
 * и соединяет с клиентом. АТС не подключена, нет внутреннего номера или АТС отказала — ссылка tel: (звонок с телефона).
 */
export const dial = action({
  args: { phone: v.string(), orderId: v.optional(v.id("orders")), leadId: v.optional(v.id("leads")), clientId: v.optional(v.id("clients")) },
  handler: async (ctx, { phone, orderId, leadId, clientId }): Promise<DialResult> => {
    if (phone.length > 40) throw new ConvexError("Неверный номер телефона");
    const context = orderId ? "из заказа" : leadId ? "из заявки" : clientId ? "из карточки клиента" : undefined;
    return dialHandler(ctx, phone, context);
  },
});

// ── Настройки телефонии ──────────────────────────────────────────────────────

const pbxSecretOf = async (ctx: QueryCtx): Promise<string | null> => (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "pbxSecret")).unique())?.value ?? null;

/**
 * Компания события АТС по ключу (ТЗ §2.5): у каждой компании свой ключ — ищем его среди всех компаний
 * (сравнение за постоянное время). configured — ключ выпущен хоть у одной; locked — у компании нет модуля «Телефония».
 */
export const _pbxTenant = internalQuery({
  args: { given: v.string() },
  handler: async (ctx, { given }): Promise<{ configured: boolean; tenantId: string | null; locked: boolean }> => {
    const rows = await unscopedDb(ctx).query("settings").withIndex("by_key", (q) => q.eq("key", "pbxSecret")).collect();
    if (!rows.length) return { configured: false, tenantId: null, locked: false };
    const match = given ? rows.find((r) => safeEqual(given, r.value)) : undefined;
    if (!match) return { configured: true, tenantId: null, locked: false };
    const tenantId = tenantOfDoc(match);
    return { configured: true, tenantId, locked: !(await hasModule(ctx, tenantId, "telephony")) };
  },
});

/**
 * Событие АТС без ключа или с неверным ключом: красная отметка «Телефония» и запись в журнал (аудит L-2, E20).
 * В журнал — не чаще раза в 10 минут: перебор ключа не должен заливать журнал. Сам присланный ключ не пишем.
 */
export const _pbxRejected = internalMutation({
  args: { via: v.union(v.literal("header"), v.literal("query"), v.literal("none")) },
  handler: async (ctx, { via }): Promise<void> => {
    // Чужой ключ не указывает на компанию: отметить некому, пока компаний на платформе несколько.
    if (!boundTenant(ctx)) return;
    await markError(ctx, "pbx", "АТС прислала событие без ключа или с неверным ключом");
    if (!(await hitLimit(ctx, `pbx:rejected:${tenantOf(ctx)}`, 1, 10 * 60_000))) return;
    await audit(ctx, "АТС", "integration.pbxRejected", "Телефония: событие отклонено — ключ не передан или неверный", { entityId: "pbx", meta: { via } });
  },
});

/** Настройки для карточки «Телефония»: адрес и только последние 4 символа ключа — сам ключ отдаёт revealPbxSecret. */
export const pbxSettings = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, OWNER);
    const secret = await pbxSecretOf(ctx);
    const site = env("CONVEX_SITE_URL");
    return { url: site ? `${site}/pbx/events` : null, configured: !!secret, tail: secret ? secret.slice(-4) : null };
  },
});

/** Показать ключ АТС владельцу. Каждый показ — в журнале (аудит M-11): ключом можно слать события от имени АТС. */
export const revealPbxSecret = mutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const me = await requireRole(ctx, OWNER);
    const secret = await pbxSecretOf(ctx);
    if (!secret) throw new ConvexError("Ключ АТС ещё не создан");
    await audit(ctx, me, "integration.pbxSecretViewed", "Телефония: владелец открыл ключ АТС", { entityId: "pbx" });
    return secret;
  },
});

export const regeneratePbxSecret = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await requireRole(ctx, OWNER);
    await requireModule(ctx, me.tenantId, "telephony");
    const value = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
    const row = await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "pbxSecret")).unique();
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key: "pbxSecret", value });
    // Сам ключ в журнал не пишем — только факт смены: АТС со старым ключом после неё получает отказ.
    await audit(ctx, me, "integration.pbxSecret", row ? "Телефония: выпущен новый ключ АТС — прежний больше не действует" : "Телефония: выпущен ключ АТС", { entityId: "pbx", meta: { rotated: !!row } });
    return value;
  },
});
