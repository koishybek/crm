// Ключи публичного API (ТЗ п.20 «REST API», п.26 «API-first»): сайт компании, партнёры и рекламные сервисы создают заявки по ключу.
// Храним только SHA-256 ключа и первые 8 символов (чтобы узнать ключ в списке). Сам ключ владелец видит один раз — при создании.
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./lib/functions";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { randomToken, safeEqual, sha256Hex } from "./lib/crypto";
import { nowIso } from "./lib/domain";
import { hitLimit } from "./lib/rateLimit";
import { env } from "./env";
import type { ApiKeyInfo } from "../src/data/types";
import { API_SCOPE_LABEL, isApiScope, LEGACY_SCOPES, scopesOf, type ApiScope } from "../src/data/apiScopes";
import { hasModule } from "./lib/tenant";
import { bindTenant, tenantOfDoc, unscopedDb } from "./lib/tenantDb";
import { lockText } from "../src/data/plans";

/** «hms_» + 32 случайных байта в base64url. */
export const KEY_PATTERN = /^hms_[A-Za-z0-9_-]{43}$/;
export const REQUESTS_PER_MIN = 120;
const MAX_ACTIVE = 20;
/** lastUsedAt обновляем не чаще раза в минуту — без лишних записей на каждый запрос. */
const TOUCH_EVERY_MS = 60_000;

/** Настройка владельца «Цены в API»: "on" — /api/v1/services отдаёт вилку цен; по умолчанию — без цен. */
export const API_PRICES_SETTING = "apiServicePrices";

export const list = query({
  args: {},
  handler: async (ctx): Promise<{ keys: ApiKeyInfo[]; baseUrl: string | null; servicePrices: boolean }> => {
    await requireRole(ctx, OWNER);
    const rows = await ctx.db.query("apiKeys").order("desc").take(200);
    const prices = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", API_PRICES_SETTING))
      .unique();
    const names = new Map<string, string>();
    for (const r of rows) {
      if (!names.has(r.createdBy)) names.set(r.createdBy, (await ctx.db.get(r.createdBy))?.name ?? "");
    }
    return {
      keys: rows.map((r) => ({
        id: r._id,
        name: r.name,
        prefix: r.prefix,
        createdAt: r.createdAt,
        createdBy: names.get(r.createdBy) || undefined,
        lastUsedAt: r.lastUsedAt,
        revokedAt: r.revokedAt,
        scopes: scopesOf(r.scopes),
      })),
      baseUrl: env("CONVEX_SITE_URL")?.replace(/\/+$/, "") ?? null,
      servicePrices: prices?.value === "on",
    };
  },
});

/** Права нового ключа: только известные, без повторов; не передали — как у прежних ключей (заявки). */
function cleanScopes(scopes: readonly string[] | undefined): ApiScope[] {
  if (scopes === undefined) return [...LEGACY_SCOPES];
  const list = [...new Set(scopes.filter(isApiScope))];
  if (!list.length) throw new ConvexError("Отметьте хотя бы одно право ключа");
  return list;
}

/** Новый ключ. Возвращается один раз — дальше в базе только хэш. */
export const create = mutation({
  args: { name: v.string(), scopes: v.optional(v.array(v.string())) },
  handler: async (ctx, { name, scopes: wanted }): Promise<{ id: Id<"apiKeys">; key: string; prefix: string }> => {
    const me = await requireRole(ctx, OWNER);
    const title = name.trim().slice(0, 60);
    if (!title) throw new ConvexError("Назовите ключ — например, «Сайт» или «Рекламный кабинет»");
    const active = (await ctx.db.query("apiKeys").collect()).filter((k) => !k.revokedAt).length;
    if (active >= MAX_ACTIVE) throw new ConvexError(`Активных ключей уже ${MAX_ACTIVE} — отзовите ненужные`);
    const key = `hms_${randomToken(32)}`;
    const prefix = key.slice(0, 8);
    const scopes = cleanScopes(wanted);
    const id = await ctx.db.insert("apiKeys", { name: title, prefix, hash: sha256Hex(key), createdAt: nowIso(), createdBy: me._id, scopes });
    await audit(ctx, me, "integration.apiKey", `Создан ключ API «${title}» (${prefix}…): ${scopes.map((x) => API_SCOPE_LABEL[x].label.toLowerCase()).join(", ")}`, { entityId: id, meta: { prefix, scopes } });
    return { id, key, prefix };
  },
});

export const revoke = mutation({
  args: { id: v.id("apiKeys") },
  handler: async (ctx, { id }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const row = await ctx.db.get(id);
    if (!row) throw new ConvexError("Ключ не найден");
    if (row.revokedAt) return;
    await ctx.db.patch(id, { revokedAt: nowIso() });
    await audit(ctx, me, "integration.apiKeyRevoked", `Отозван ключ API «${row.name}» (${row.prefix}…)`, { entityId: id, meta: { prefix: row.prefix } });
  },
});

/** «Цены в API»: отдавать ли в справочнике услуг вилку цен. */
export const setServicePrices = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", API_PRICES_SETTING))
      .unique();
    if ((row?.value === "on") === enabled) return;
    const value = enabled ? "on" : "off";
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key: API_PRICES_SETTING, value });
    await audit(ctx, me, "settings.apiPrices", enabled ? "Справочник услуг в API отдаёт цены" : "Справочник услуг в API — без цен", { meta: { enabled } });
  },
});

export type AuthResult = { ok: true; keyId: Id<"apiKeys">; prefix: string; tenantId: string } | { ok: false; status: 401 | 403 | 429; error: string };

export const INVALID_KEY = "Неверный или отозванный ключ API";

/**
 * Проверка ключа по его SHA-256 (сам ключ в функцию не передаём — он не должен попадать никуда, кроме хэша)
 * + право ключа на запрос (scope) + лимит запросов на ключ. Вызывается из HTTP-обработчиков API.
 */
export const _authorize = internalMutation({
  args: { hash: v.string(), scope: v.string() },
  handler: async (ctx, { hash, scope }): Promise<AuthResult> => {
    // Ключ — вход без пользователя: ищем среди всех компаний, дальше запрос работает в компании ключа (ТЗ §2.5).
    const row = await unscopedDb(ctx)
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    if (!row || !safeEqual(row.hash, hash) || row.revokedAt) return { ok: false, status: 401, error: INVALID_KEY };
    const tenantId = tenantOfDoc(row);
    bindTenant(ctx, tenantId);
    if (!(await hasModule(ctx, tenantId, "api"))) return { ok: false, status: 403, error: lockText("api") };
    if (!isApiScope(scope) || !scopesOf(row.scopes).includes(scope)) return { ok: false, status: 403, error: `У ключа нет права ${scope}: ${isApiScope(scope) ? API_SCOPE_LABEL[scope].label.toLowerCase() : "неизвестное право"}` };
    if (!(await hitLimit(ctx, `api:${row._id}`, REQUESTS_PER_MIN, 60_000))) return { ok: false, status: 429, error: `Слишком много запросов — не больше ${REQUESTS_PER_MIN} в минуту` };
    if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > TOUCH_EVERY_MS) await ctx.db.patch(row._id, { lastUsedAt: nowIso() });
    return { ok: true, keyId: row._id, prefix: row.prefix, tenantId };
  },
});
