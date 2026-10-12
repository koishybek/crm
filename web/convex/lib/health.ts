// Состояние подсистем для владельца (ТЗ п.20 «мониторинг»): когда подсистема последний раз отработала и последняя ошибка.
// Из мутаций — markOk/markError напрямую; из actions — через internal.health._mark.
import type { MutationCtx } from "../_generated/server";
import { nowIso } from "./domain";

export type HealthKey = "ai" | "telegram" | "whatsapp" | "olx" | "pbx" | "email" | "site" | "api" | "backup" | "reminders";

async function row(ctx: MutationCtx, key: HealthKey) {
  return ctx.db
    .query("systemStatus")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

export async function markOk(ctx: MutationCtx, key: HealthKey, note?: string): Promise<void> {
  const r = await row(ctx, key);
  const patch = { okAt: nowIso(), okNote: note?.slice(0, 200) };
  if (r) await ctx.db.patch(r._id, patch);
  else await ctx.db.insert("systemStatus", { key, ...patch });
}

export async function markError(ctx: MutationCtx, key: HealthKey, error: string): Promise<void> {
  const r = await row(ctx, key);
  const patch = { errorAt: nowIso(), error: error.slice(0, 300) };
  if (r) await ctx.db.patch(r._id, patch);
  else await ctx.db.insert("systemStatus", { key, ...patch });
}
