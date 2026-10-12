// Лимит «не больше N событий за окно» на ключ (телефон, токен, канал) — антиспам публичных форм и API.
// Окно фиксированное: для защиты от перебора и флуда этого достаточно, а мутации Convex сериализуемы —
// два одновременных запроса не проскочат лимит вместе.
import type { MutationCtx } from "../_generated/server";

/** true — событие разрешено (и учтено), false — лимит исчерпан. */
export async function hitLimit(ctx: MutationCtx, key: string, max: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await ctx.db
    .query("rateLimits")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
  if (!row) {
    await ctx.db.insert("rateLimits", { key, windowStart: now, count: 1 });
    return true;
  }
  if (now - row.windowStart >= windowMs) {
    await ctx.db.patch(row._id, { windowStart: now, count: 1 });
    return true;
  }
  if (row.count >= max) return false;
  await ctx.db.patch(row._id, { count: row.count + 1 });
  return true;
}
