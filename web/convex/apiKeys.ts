// Ключи публичного API (ТЗ п.20 «REST API», п.26 «API-first»): сайт компании, партнёры и рекламные сервисы создают заявки по ключу.
// Храним только SHA-256 ключа и первые 8 символов (чтобы узнать ключ в списке). Сам ключ владелец видит один раз — при создании.
import { ConvexError, v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { internalMutation, mutation, query } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { randomToken, safeEqual, sha256Hex } from "./lib/crypto";
import { nowIso } from "./lib/domain";
import { hitLimit } from "./lib/rateLimit";
import { env } from "./env";
import type { ApiKeyInfo } from "../src/data/types";

/** «hms_» + 32 случайных байта в base64url. */
export const KEY_PATTERN = /^hms_[A-Za-z0-9_-]{43}$/;
export const REQUESTS_PER_MIN = 120;
const MAX_ACTIVE = 20;
/** lastUsedAt обновляем не чаще раза в минуту — без лишних записей на каждый запрос. */
const TOUCH_EVERY_MS = 60_000;

export const list = query({
  args: {},
  handler: async (ctx): Promise<{ keys: ApiKeyInfo[]; baseUrl: string | null }> => {
    await requireRole(ctx, OWNER);
    const rows = await ctx.db.query("apiKeys").order("desc").take(200);
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
      })),
      baseUrl: env("CONVEX_SITE_URL")?.replace(/\/+$/, "") ?? null,
    };
  },
});

/** Новый ключ. Возвращается один раз — дальше в базе только хэш. */
export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<{ id: Id<"apiKeys">; key: string; prefix: string }> => {
    const me = await requireRole(ctx, OWNER);
    const title = name.trim().slice(0, 60);
    if (!title) throw new ConvexError("Назовите ключ — например, «Сайт» или «Рекламный кабинет»");
    const active = (await ctx.db.query("apiKeys").collect()).filter((k) => !k.revokedAt).length;
    if (active >= MAX_ACTIVE) throw new ConvexError(`Активных ключей уже ${MAX_ACTIVE} — отзовите ненужные`);
    const key = `hms_${randomToken(32)}`;
    const prefix = key.slice(0, 8);
    const id = await ctx.db.insert("apiKeys", { name: title, prefix, hash: sha256Hex(key), createdAt: nowIso(), createdBy: me._id });
    await audit(ctx, me, "integration.apiKey", `Создан ключ API «${title}» (${prefix}…)`, { entityId: id, meta: { prefix } });
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

export type AuthResult = { ok: true; keyId: Id<"apiKeys">; prefix: string } | { ok: false; status: 401 | 429; error: string };

export const INVALID_KEY = "Неверный или отозванный ключ API";

/**
 * Проверка ключа по его SHA-256 (сам ключ в функцию не передаём — он не должен попадать никуда, кроме хэша)
 * + лимит запросов на ключ. Вызывается из HTTP-обработчиков API.
 */
export const _authorize = internalMutation({
  args: { hash: v.string() },
  handler: async (ctx, { hash }): Promise<AuthResult> => {
    const row = await ctx.db
      .query("apiKeys")
      .withIndex("by_hash", (q) => q.eq("hash", hash))
      .unique();
    if (!row || !safeEqual(row.hash, hash) || row.revokedAt) return { ok: false, status: 401, error: INVALID_KEY };
    if (!(await hitLimit(ctx, `api:${row._id}`, REQUESTS_PER_MIN, 60_000))) return { ok: false, status: 429, error: `Слишком много запросов — не больше ${REQUESTS_PER_MIN} в минуту` };
    if (!row.lastUsedAt || Date.now() - Date.parse(row.lastUsedAt) > TOUCH_EVERY_MS) await ctx.db.patch(row._id, { lastUsedAt: nowIso() });
    return { ok: true, keyId: row._id, prefix: row.prefix };
  },
});
