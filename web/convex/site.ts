// Заявки с сайта (ТЗ п.6 «Сайт»): страница /zayavka (можно встроить iframe) и формы на сайте компании шлют POST /public/lead.
// Защита от спама: поле-ловушка, минимальное время заполнения, общий лимит и лимит на номер, проверка казахстанского номера,
// ограничения длины. Повторная отправка той же заявки в течение 10 минут возвращает тот же номер — без дубля.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { httpAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { markOk } from "./lib/health";
import { json, readJson, str, type HeaderMap } from "./lib/httpUtil";
import { intakeLead } from "./lib/intake";
import { kzPhone } from "./lib/phone";
import { hitLimit } from "./lib/rateLimit";
import { ingestMessage, linkConversation } from "./inbox";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { cityKey } from "../src/data/cities";
import { utmFromRecord, utmText, type Utm } from "../src/data/utm";
import { utm as utmValidator } from "./schema";

const MAX_BODY = 10 * 1024;
/** Человек заполняет форму дольше 3 секунд. */
const MIN_FILL_MS = 3000;
/** Часы телефона могут спешить: до 10 минут «из будущего» — не повод отказать. */
const CLOCK_SKEW_MS = 10 * 60_000;
const SAME_LEAD_MS = 10 * 60_000;
const GLOBAL_PER_MIN = 60;
const PHONE_PER_HOUR = 3;
const MAX_ORIGINS = 10;
const ORIGINS_KEY = "siteOrigins";

export interface SiteLead {
  name: string;
  phone: string;
  serviceId?: string;
  city?: string;
  description: string;
  /** Рекламные метки страницы (utm_* из адреса формы или страницы, где она встроена). */
  utm?: Utm;
}

export type ParseResult = { ok: true; data: SiteLead } | { ok: false; error: string };

/** Проверка полей формы (без базы): ловушка, время заполнения, согласие, номер, длины. */
export function parseSiteLead(body: Record<string, unknown>, now: number): ParseResult {
  // Ловушка: поле скрыто от людей, его заполняют только боты.
  if (typeof body.website === "string" ? body.website.trim() !== "" : body.website !== undefined && body.website !== null) {
    return { ok: false, error: "Не удалось отправить заявку" };
  }
  const startedAt = body.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return { ok: false, error: "Обновите страницу и отправьте заявку ещё раз" };
  const elapsed = now - startedAt;
  if (elapsed < -CLOCK_SKEW_MS) return { ok: false, error: "Проверьте дату и время на устройстве и отправьте заявку ещё раз" };
  if (elapsed >= 0 && elapsed < MIN_FILL_MS) return { ok: false, error: "Слишком быстро — проверьте данные и отправьте ещё раз" };
  if (body.consent !== true) return { ok: false, error: "Нужно согласие на обработку персональных данных" };

  const name = str(body, "name", 80, "Имя");
  if (!name.ok) return name;
  const phoneRaw = str(body, "phone", 32, "Телефон");
  if (!phoneRaw.ok) return phoneRaw;
  const serviceId = str(body, "serviceId", 80, "Услуга");
  if (!serviceId.ok) return serviceId;
  const city = str(body, "city", 60, "Город");
  if (!city.ok) return city;
  const description = str(body, "description", 2000, "Описание");
  if (!description.ok) return description;
  if (!name.value || name.value.length < 2) return { ok: false, error: "Укажите имя" };
  const phone = phoneRaw.value ? kzPhone(phoneRaw.value) : null;
  if (!phone) return { ok: false, error: "Укажите казахстанский номер: +7 7XX XXX XX XX" };

  const utm = utmFromRecord(body);
  return { ok: true, data: { name: name.value, phone, serviceId: serviceId.value, city: city.value, description: description.value ?? "", ...(utm ? { utm } : {}) } };
}

// ── Какие сайты могут слать заявки (CORS) ────────────────────────────────────

/** «homemax.kz», «https://www.homemax.kz/» → «https://www.homemax.kz»; не адрес — null. */
export function normalizeOrigin(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https") return null;
  try {
    const u = new URL(scheme ? s : `https://${s}`);
    const host = u.hostname;
    // Публичный сайт — домен с точкой; без точки — только localhost для разработки.
    if (!host.includes(".") && host !== "localhost") return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function siteOrigins(ctx: QueryCtx): Promise<string[]> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", ORIGINS_KEY))
    .unique();
  if (!row) return [];
  try {
    const list: unknown = JSON.parse(row.value);
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const appOrigin = () => normalizeOrigin(env("APP_URL") ?? "");

export const _origins = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ app: string | null; sites: string[] }> => ({ app: appOrigin(), sites: await siteOrigins(ctx) }),
});

/** Браузер шлёт Origin: принимаем своё приложение (/zayavka), сайты из настроек и localhost; пока ничего не настроено — всех. */
export function originAllowed(origin: string | null, cfg: { app: string | null; sites: string[] }): boolean {
  if (!origin) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  if (!cfg.app && cfg.sites.length === 0) return true;
  return origin === cfg.app || cfg.sites.includes(origin);
}

const cors = (origin: string | null): HeaderMap => (origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {});

/** Preflight браузера перед POST с JSON. */
export const leadOptions = httpAction(async (ctx, request) => {
  const origin = request.headers.get("origin");
  if (!originAllowed(origin, await ctx.runQuery(internal.site._origins, {}))) return new Response(null, { status: 403 });
  return new Response(null, {
    status: 204,
    headers: { ...cors(origin), "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" },
  });
});

export const leadPost = httpAction(async (ctx, request) => {
  const origin = request.headers.get("origin");
  if (!originAllowed(origin, await ctx.runQuery(internal.site._origins, {}))) return json(403, { error: "Этот сайт не подключён к приёму заявок" });
  const headers = cors(origin);
  const body = await readJson(request, MAX_BODY);
  if (!body.ok) return json(body.status, { error: body.error }, headers);
  const parsed = parseSiteLead(body.value, Date.now());
  if (!parsed.ok) return json(400, { error: parsed.error }, headers);
  try {
    const r = await ctx.runMutation(internal.site._submit, parsed.data);
    if (!r.ok) return json(r.status, { error: r.error }, r.status === 429 ? { ...headers, "Retry-After": "60" } : headers);
    return json(r.duplicate ? 200 : 201, { ok: true, number: r.number }, headers);
  } catch (e) {
    // Данные клиента в лог не пишем — только тип ошибки.
    console.error(`site: заявка не принята: ${e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.name : "ошибка"}`);
    await ctx.runMutation(internal.health._mark, { key: "site", ok: false, note: "Ошибка приёма заявки с сайта" });
    return json(500, { error: "Не получилось отправить заявку — позвоните нам, пожалуйста" }, headers);
  }
});

// ── Приём заявки ─────────────────────────────────────────────────────────────

export type SubmitResult = { ok: true; number: number; duplicate: boolean } | { ok: false; status: 429 | 503; error: string };

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim().toLowerCase() === b.replace(/\s+/g, " ").trim().toLowerCase();

/** Та же заявка с того же номера за 10 минут (двойной клик, повторная отправка) → её номер. */
async function sameRecentLead(ctx: MutationCtx, a: SiteLead, serviceId: string, now: number): Promise<number | null> {
  const client = await ctx.db
    .query("clients")
    .withIndex("by_phone", (q) => q.eq("phone", a.phone))
    .first();
  if (!client) return null;
  const since = new Date(now - SAME_LEAD_MS).toISOString();
  const recent = await ctx.db
    .query("leads")
    .withIndex("by_client", (q) => q.eq("clientId", client._id).gte("createdAt", since))
    .collect();
  const same = recent.find((l) => l.source === "site" && l.serviceId === serviceId && sameText(l.description, a.description || "Заявка с сайта") && (!a.city || cityKey(l.city) === cityKey(a.city)));
  return same?.number ?? null;
}

export const _submit = internalMutation({
  args: { name: v.string(), phone: v.string(), serviceId: v.optional(v.string()), city: v.optional(v.string()), description: v.string(), utm: v.optional(utmValidator) },
  handler: async (ctx, a): Promise<SubmitResult> => {
    const now = Date.now();
    if (!(await hitLimit(ctx, "site:all", GLOBAL_PER_MIN, 60_000))) return { ok: false, status: 429, error: "Сейчас слишком много заявок — попробуйте через минуту" };
    const cat = await loadCatalog(ctx);
    const svc = cat.services.find((s) => s.id === a.serviceId && s.active !== false);
    const serviceId = svc?.id ?? (cat.services.some((s) => s.id === "other") ? "other" : (cat.services[0]?.id ?? "other"));
    const dup = await sameRecentLead(ctx, a, serviceId, now);
    if (dup !== null) return { ok: true, number: dup, duplicate: true };
    if (!(await hitLimit(ctx, `site:phone:${a.phone}`, PHONE_PER_HOUR, 3600_000))) return { ok: false, status: 429, error: "С этого номера уже есть заявки — мы скоро перезвоним" };

    const description = a.description || "Заявка с сайта";
    const res = await intakeLead(ctx, {
      source: "site",
      origin: "site",
      phone: a.phone,
      name: a.name,
      fallbackName: "Клиент с сайта",
      serviceId: svc?.id,
      city: a.city,
      description,
      comment: a.utm ? `Метки рекламы: ${utmText(a.utm)}` : undefined,
      utm: a.utm,
      message: { title: "Заявка с сайта", text: description },
      actor: "Сайт",
      via: "с сайта",
    });
    if (!res) return { ok: false, status: 503, error: "Приём заявок временно недоступен — позвоните нам, пожалуйста" };

    // Заявка видна и в «Сообщениях»: оператор открывает её из общего списка, отвечает звонком.
    const text = [`Заявка №${res.number} с сайта`, `Услуга: ${cat.label(res.serviceId)}`, a.city ? `Город: ${a.city}` : "", a.description].filter(Boolean).join("\n");
    await ingestMessage(ctx, { channel: "site", externalId: a.phone, contactName: a.name, contactPhone: a.phone, text, kind: "text", externalMessageId: `lead-${res.number}`, notify: false, autoLead: false });
    await linkConversation(ctx, "site", a.phone, { leadId: res.leadId, clientId: res.clientId });
    await markOk(ctx, "site", `Заявка №${res.number}`);
    return { ok: true, number: res.number, duplicate: false };
  },
});

// ── Настройки для владельца ──────────────────────────────────────────────────

export const settings = query({
  args: {},
  handler: async (ctx): Promise<{ origins: string[]; appUrl: string | null; endpoint: string | null }> => {
    await requireRole(ctx, OWNER);
    const site = env("CONVEX_SITE_URL")?.replace(/\/+$/, "");
    return { origins: await siteOrigins(ctx), appUrl: appOrigin(), endpoint: site ? `${site}/public/lead` : null };
  },
});

/** Сайты компании, с которых форма может отправлять заявки напрямую (CORS). */
export const setOrigins = mutation({
  args: { origins: v.array(v.string()) },
  handler: async (ctx, { origins }): Promise<string[]> => {
    const me = await requireRole(ctx, OWNER);
    if (origins.length > MAX_ORIGINS) throw new ConvexError(`Не больше ${MAX_ORIGINS} сайтов`);
    const list: string[] = [];
    for (const raw of origins) {
      if (!raw.trim()) continue;
      const o = normalizeOrigin(raw.slice(0, 200));
      if (!o) throw new ConvexError(`Не похоже на адрес сайта: «${raw.trim().slice(0, 60)}»`);
      if (!list.includes(o)) list.push(o);
    }
    const value = JSON.stringify(list);
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", ORIGINS_KEY))
      .unique();
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key: ORIGINS_KEY, value });
    await audit(ctx, me, "settings.siteOrigins", list.length ? `Сайты для приёма заявок: ${list.join(", ")}` : "Список сайтов для приёма заявок очищен", { meta: { count: list.length } });
    return list;
  },
});
