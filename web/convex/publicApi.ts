// Публичный REST API (ТЗ п.20 «REST API», п.26 «API-first»): сайт компании, партнёры и рекламные сервисы
// создают заявки и узнают их статус. Ключ — Authorization: Bearer hms_…, 120 запросов в минуту на ключ, права ключа (scopes) — src/data/apiScopes.ts,
// ошибки — JSON { error }. Описание для разработчиков — GET /api/v1/openapi.json (lib/openapi.ts).
//   POST /api/v1/leads            leads:write   { name, phone, serviceId?, city?, description, source?, externalId?, utm?, campaign? } → 201 { number, id }
//   GET  /api/v1/leads/{number}   leads:read    → { number, status, createdAt, orderNumber?, orderStatus? } — только заявки этого ключа
//   GET  /api/v1/orders/{number}  orders:read   → статус и даты заказа — без клиента, адреса и денег
//   GET  /api/v1/services         services:read → справочник направлений и услуг; цены — только если владелец включил
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, type ActionCtx } from "./lib/functions";
import { API_PRICES_SETTING, INVALID_KEY, KEY_PATTERN } from "./apiKeys";
import { sha256Hex } from "./lib/crypto";
import { nowIso } from "./lib/domain";
import { markOk } from "./lib/health";
import { json, readJson, str } from "./lib/httpUtil";
import { intakeLead } from "./lib/intake";
import { kzPhone } from "./lib/phone";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { source, utm } from "./schema";
import { openApiDoc } from "./lib/openapi";
import type { ApiScope } from "../src/data/apiScopes";
import { campaignOf, cleanUtmValue, utmFromRecord, type Utm } from "../src/data/utm";
import { LEAD_STATUS, ORDER_STATUS, SOURCE_IDS } from "../src/data/catalog";
import type { LeadStatus, OrderStatus, SourceId } from "../src/data/types";
import { actionFor } from "./lib/tenantDb";

const MAX_BODY = 16 * 1024;

export interface ApiLead {
  name: string;
  phone: string;
  serviceId?: string;
  city?: string;
  description: string;
  source: SourceId;
  externalId?: string;
  utm?: Utm;
  campaign?: string;
}

/** Проверка тела запроса (без базы). Ключ идемпотентности — externalId в теле или заголовок Idempotency-Key. */
export function parseApiLead(body: Record<string, unknown>, idempotencyKey: string | null): { ok: true; data: ApiLead } | { ok: false; error: string } {
  const name = str(body, "name", 80, "name");
  if (!name.ok) return name;
  const phoneRaw = str(body, "phone", 32, "phone");
  if (!phoneRaw.ok) return phoneRaw;
  const serviceId = str(body, "serviceId", 80, "serviceId");
  if (!serviceId.ok) return serviceId;
  const city = str(body, "city", 60, "city");
  if (!city.ok) return city;
  const description = str(body, "description", 2000, "description");
  if (!description.ok) return description;
  const src = str(body, "source", 20, "source");
  if (!src.ok) return src;
  const ext = str(body, "externalId", 100, "externalId");
  if (!ext.ok) return ext;
  if (!name.value) return { ok: false, error: "name: обязательное поле" };
  const phone = phoneRaw.value ? kzPhone(phoneRaw.value) : null;
  if (!phone) return { ok: false, error: "phone: нужен казахстанский номер, например +77011234567" };
  if (!description.value) return { ok: false, error: "description: обязательное поле" };
  const sourceId = (src.value ?? "site") as SourceId;
  if (!SOURCE_IDS.includes(sourceId)) return { ok: false, error: `source: одно из ${SOURCE_IDS.join(", ")}` };
  if (body.campaign !== undefined && body.campaign !== null && typeof body.campaign !== "string") return { ok: false, error: "campaign: ожидалась строка" };
  if (body.utm !== undefined && body.utm !== null && (typeof body.utm !== "object" || Array.isArray(body.utm))) return { ok: false, error: "utm: ожидался объект { source, medium, campaign, content, term }" };
  const marks = utmFromRecord(body);
  const campaign = campaignOf(marks, cleanUtmValue(body.campaign));
  const header = idempotencyKey?.trim();
  if (header && header.length > 100) return { ok: false, error: "Idempotency-Key: не длиннее 100 символов" };
  return { ok: true, data: { name: name.value, phone, serviceId: serviceId.value, city: city.value, description: description.value, source: sourceId, externalId: ext.value ?? (header || undefined), ...(marks ? { utm: marks } : {}), ...(campaign ? { campaign } : {}) } };
}

const apiError = (status: number, error: string, headers: Record<string, string> = {}) => json(status, { error }, headers);

/** Ключ из заголовка → проверка по хэшу и лимит. Ответ-ошибка, если не пускаем. */
async function authorize(ctx: ActionCtx, request: Request, scope: ApiScope): Promise<{ ok: true; keyId: Id<"apiKeys">; prefix: string; ctx: ActionCtx } | { ok: false; response: Response }> {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(request.headers.get("authorization") ?? "");
  if (!m) return { ok: false, response: apiError(401, "Нужен заголовок Authorization: Bearer <ключ API>", { "WWW-Authenticate": "Bearer" }) };
  const key = m[1]!;
  if (!KEY_PATTERN.test(key)) return { ok: false, response: apiError(401, INVALID_KEY, { "WWW-Authenticate": "Bearer" }) };
  const r = await ctx.runMutation(internal.apiKeys._authorize, { hash: sha256Hex(key), scope });
  if (!r.ok) return { ok: false, response: apiError(r.status, r.error, r.status === 429 ? { "Retry-After": "60" } : r.status === 401 ? { "WWW-Authenticate": "Bearer" } : {}) };
  // Дальше всё — в компании ключа.
  return { ok: true, keyId: r.keyId, prefix: r.prefix, ctx: actionFor(ctx, r.tenantId) };
}

const failure = async (ctx: ActionCtx, where: string, e: unknown) => {
  // Тело запроса и ключ в лог не пишем — только тип ошибки.
  console.error(`api: ${where}: ${e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.name : "ошибка"}`);
  await ctx.runMutation(internal.health._mark, { key: "api", ok: false, note: `Ошибка API: ${where}` });
  return apiError(500, "Внутренняя ошибка — повторите запрос позже");
};

export const createLeadHttp = httpAction(async (ctx, request) => {
  const auth = await authorize(ctx, request, "leads:write");
  if (!auth.ok) return auth.response;
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return apiError(body.status, body.error);
  const parsed = parseApiLead(body.value, request.headers.get("idempotency-key"));
  if (!parsed.ok) return apiError(400, parsed.error);
  try {
    const r = await auth.ctx.runMutation(internal.publicApi._createLead, { keyId: auth.keyId, prefix: auth.prefix, ...parsed.data });
    if (!r.ok) return apiError(r.status, r.error);
    return json(r.replayed ? 200 : 201, { number: r.number, id: r.id });
  } catch (e) {
    return failure(auth.ctx, "создание заявки", e);
  }
});

export const getLeadHttp = httpAction(async (ctx, request) => {
  const auth = await authorize(ctx, request, "leads:read");
  if (!auth.ok) return auth.response;
  const m = /^\/api\/v1\/leads\/(\d{1,9})\/?$/.exec(new URL(request.url).pathname);
  if (!m) return apiError(400, "Номер заявки — число: /api/v1/leads/1024");
  try {
    const r = await auth.ctx.runQuery(internal.publicApi._leadStatus, { keyId: auth.keyId, number: Number(m[1]) });
    return r ? json(200, r) : apiError(404, "Заявка не найдена");
  } catch (e) {
    return failure(auth.ctx, "статус заявки", e);
  }
});

export type CreateResult = { ok: true; replayed: boolean; number: number; id: Id<"leads"> } | { ok: false; status: 400 | 503; error: string };

export const _createLead = internalMutation({
  args: {
    keyId: v.id("apiKeys"),
    prefix: v.string(),
    name: v.string(),
    phone: v.string(),
    serviceId: v.optional(v.string()),
    city: v.optional(v.string()),
    description: v.string(),
    source,
    externalId: v.optional(v.string()),
    utm: v.optional(utm),
    campaign: v.optional(v.string()),
  },
  handler: async (ctx, a): Promise<CreateResult> => {
    // Повтор запроса с тем же ключом идемпотентности — та же заявка, без дубля.
    if (a.externalId) {
      const prev = await ctx.db
        .query("apiLeads")
        .withIndex("by_key_external", (q) => q.eq("keyId", a.keyId).eq("externalId", a.externalId))
        .unique();
      const lead = prev ? await ctx.db.get(prev.leadId) : null;
      if (lead) return { ok: true, replayed: true, number: lead.number, id: lead._id };
    }
    if (a.serviceId) {
      const svc = (await loadCatalog(ctx)).services.find((s) => s.id === a.serviceId);
      if (!svc || svc.active === false) return { ok: false, status: 400, error: "serviceId: такой услуги нет в справочнике" };
    }
    const res = await intakeLead(ctx, {
      source: a.source,
      origin: "api",
      phone: a.phone,
      name: a.name,
      fallbackName: "Клиент (API)",
      serviceId: a.serviceId,
      city: a.city,
      description: a.description,
      utm: a.utm,
      campaign: a.campaign,
      message: { title: "Заявка через API", text: a.description },
      actor: "API",
      via: "через API",
      auditMeta: { keyPrefix: a.prefix, ...(a.externalId ? { externalId: a.externalId } : {}) },
    });
    if (!res) return { ok: false, status: 503, error: "Приём заявок временно недоступен" };
    await ctx.db.insert("apiLeads", { keyId: a.keyId, leadId: res.leadId, number: res.number, externalId: a.externalId, at: nowIso() });
    await markOk(ctx, "api", `Заявка №${res.number} через API`);
    return { ok: true, replayed: false, number: res.number, id: res.leadId };
  },
});

export interface LeadStatusDto {
  number: number;
  status: LeadStatus;
  statusLabel: string;
  createdAt: string;
  orderNumber?: number;
  orderStatus?: OrderStatus;
  orderStatusLabel?: string;
}

/** Статус заявки без персональных данных — только для заявок, созданных этим ключом. */
export const _leadStatus = internalQuery({
  args: { keyId: v.id("apiKeys"), number: v.number() },
  handler: async (ctx, { keyId, number }): Promise<LeadStatusDto | null> => {
    const own = await ctx.db
      .query("apiLeads")
      .withIndex("by_key_number", (q) => q.eq("keyId", keyId).eq("number", number))
      .first();
    const lead = own ? await ctx.db.get(own.leadId) : null;
    if (!lead) return null;
    const order = lead.orderId ? await ctx.db.get(lead.orderId) : null;
    return {
      number: lead.number,
      status: lead.status,
      statusLabel: LEAD_STATUS[lead.status].label,
      createdAt: lead.createdAt,
      ...(order ? { orderNumber: order.number, orderStatus: order.status, orderStatusLabel: ORDER_STATUS[order.status].label } : {}),
    };
  },
});

// ── Заказы, справочник, описание API ─────────────────────────────────────────

export interface OrderStatusDto {
  number: number;
  status: OrderStatus;
  statusLabel: string;
  serviceId: string;
  service: string;
  category: string;
  city: string;
  createdAt: string;
  deadline: string;
  doneAt?: string;
  paidAt?: string;
  closedAt?: string;
}

/** Статус заказа по номеру — без клиента, адреса, описания, цены и выплаты (ТЗ п.26.7). */
export const _orderStatus = internalQuery({
  args: { number: v.number() },
  handler: async (ctx, { number }): Promise<OrderStatusDto | null> => {
    const o = await ctx.db
      .query("orders")
      .withIndex("by_number", (q) => q.eq("number", number))
      .first();
    if (!o) return null;
    const cat = await loadCatalog(ctx);
    return {
      number: o.number,
      status: o.status,
      statusLabel: ORDER_STATUS[o.status].label,
      serviceId: o.serviceId,
      service: cat.label(o.serviceId),
      category: o.category,
      city: o.city,
      createdAt: o.createdAt,
      deadline: o.deadline,
      ...(o.doneAt ? { doneAt: o.doneAt } : {}),
      ...(o.paidAt ? { paidAt: o.paidAt } : {}),
      ...(o.closedAt ? { closedAt: o.closedAt } : {}),
    };
  },
});

export interface ServicesDto {
  categories: { id: string; label: string }[];
  services: { id: string; label: string; category: string; priceMin?: number; priceMax?: number }[];
}

export const _services = internalQuery({
  args: {},
  handler: async (ctx): Promise<ServicesDto> => {
    const [c, prices] = await Promise.all([
      loadCatalog(ctx),
      ctx.db
        .query("settings")
        .withIndex("by_key", (q) => q.eq("key", API_PRICES_SETTING))
        .unique(),
    ]);
    const withPrices = prices?.value === "on";
    const categories = c.categories.filter((x) => x.active !== false);
    const open = new Set(categories.map((x) => x.id));
    return {
      categories: categories.map((x) => ({ id: x.id, label: x.label })),
      services: c.services
        .filter((s) => s.active !== false && open.has(s.category))
        .map((s) => ({ id: s.id, label: s.label, category: s.category, ...(withPrices ? { priceMin: s.price[0], priceMax: s.price[1] } : {}) })),
    };
  },
});

export const getOrderHttp = httpAction(async (ctx, request) => {
  const auth = await authorize(ctx, request, "orders:read");
  if (!auth.ok) return auth.response;
  const m = /^\/api\/v1\/orders\/(\d{1,9})\/?$/.exec(new URL(request.url).pathname);
  if (!m) return apiError(400, "Номер заказа — число: /api/v1/orders/1024");
  try {
    const r = await auth.ctx.runQuery(internal.publicApi._orderStatus, { number: Number(m[1]) });
    return r ? json(200, r) : apiError(404, "Заказ не найден");
  } catch (e) {
    return failure(auth.ctx, "статус заказа", e);
  }
});

export const servicesHttp = httpAction(async (ctx, request) => {
  const auth = await authorize(ctx, request, "services:read");
  if (!auth.ok) return auth.response;
  try {
    return json(200, await auth.ctx.runQuery(internal.publicApi._services, {}));
  } catch (e) {
    return failure(auth.ctx, "справочник услуг", e);
  }
});

/** Описание API в формате OpenAPI 3.1 — без ключа: в нём нет данных, только схема. */
export const openApiHttp = httpAction(async (_ctx, request) => {
  const base = (env("CONVEX_SITE_URL") ?? new URL(request.url).origin).replace(/\/+$/, "");
  return json(200, openApiDoc(base), { "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=3600" });
});
