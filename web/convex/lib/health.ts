// Состояние подсистем для владельца (ТЗ п.20 «мониторинг»): когда подсистема последний раз отработала и последняя ошибка.
// Из мутаций — markOk/markError напрямую; из actions — через internal.health._mark.
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { nowIso } from "./domain";

export type HealthKey = "ai" | "telegram" | "whatsapp" | "olx" | "pbx" | "email" | "site" | "api" | "backup" | "reminders" | "escalations";

/**
 * Одна и та же отметка подряд чаще раза в минуту строку не переписывает: поток событий АТС или флуд вебхука
 * с неверным ключом иначе писал бы в одну строку на каждый запрос и мешал остальным транзакциям.
 */
const REPEAT_MS = 60_000;

async function row(ctx: MutationCtx, key: HealthKey) {
  return ctx.db
    .query("systemStatus")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

/** Та же отметка уже последняя и свежая — повтор ничего не меняет. */
function repeated(at: string | undefined, other: string | undefined, sameText: boolean): boolean {
  return !!at && sameText && (!other || other <= at) && Date.now() - Date.parse(at) < REPEAT_MS;
}

export async function markOk(ctx: MutationCtx, key: HealthKey, note?: string): Promise<void> {
  const r = await row(ctx, key);
  const okNote = note?.slice(0, 200);
  if (r && repeated(r.okAt, r.errorAt, r.okNote === okNote)) return;
  await write(ctx, r, key, { okAt: nowIso(), okNote });
}

export async function markError(ctx: MutationCtx, key: HealthKey, error: string): Promise<void> {
  const r = await row(ctx, key);
  const text = error.slice(0, 300);
  if (r && repeated(r.errorAt, r.okAt, r.error === text)) return;
  await write(ctx, r, key, { errorAt: nowIso(), error: text });
}

async function write(ctx: MutationCtx, r: Doc<"systemStatus"> | null, key: HealthKey, patch: Partial<Doc<"systemStatus">>): Promise<void> {
  if (r) await ctx.db.patch(r._id, patch);
  else await ctx.db.insert("systemStatus", { key, ...patch });
}
