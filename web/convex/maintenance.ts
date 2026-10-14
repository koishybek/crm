// Уборка служебных таблиц (аудит H-4, L-3, I-2): отжившие счётчики лимитов и принятые обновления Telegram.
// Раз в час пачками: таблицы не растут бесконечно, а одна транзакция не упирается в лимиты чтения.
import { internal } from "./_generated/api";
import { internalMutation } from "./lib/functions";
import { perTenant } from "./lib/tenant";

/** Самое длинное окно лимита — сутки (заявки из Telegram): строка старше двух суток точно отжила. */
const RATE_LIMIT_TTL_MS = 2 * 86400_000;
/** Telegram повторяет доставку часами, не сутками: двух суток защиты от повторов хватает с запасом. */
const TG_UPDATES_TTL_MS = 2 * 86400_000;
const BATCH = 500;

export const cleanup = internalMutation({
  args: {},
  handler: async (cronCtx): Promise<{ rateLimits: number; telegramUpdates: number }> => perTenant(cronCtx, internal.maintenance.cleanup, { rateLimits: 0, telegramUpdates: 0 }, async (ctx) => {
    const now = Date.now();
    const limits = await ctx.db
      .query("rateLimits")
      .withIndex("by_window", (q) => q.lt("windowStart", now - RATE_LIMIT_TTL_MS))
      .take(BATCH);
    for (const r of limits) await ctx.db.delete(r._id);
    const updates = await ctx.db
      .query("telegramUpdates")
      .withIndex("by_creation_time", (q) => q.lt("_creationTime", now - TG_UPDATES_TTL_MS))
      .take(BATCH);
    for (const u of updates) await ctx.db.delete(u._id);
    // Пачка полная — старого больше, чем убрали: продолжим сразу, не дожидаясь следующего часа.
    if (limits.length === BATCH || updates.length === BATCH) await ctx.scheduler.runAfter(0, internal.maintenance.cleanup, {});
    return { rateLimits: limits.length, telegramUpdates: updates.length };
  }),
});
