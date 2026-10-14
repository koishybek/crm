// Состояние подсистем для владельца (ТЗ п.20 «мониторинг»): когда подсистема последний раз отработала и последняя ошибка.
// Из мутаций — markOk/markError напрямую; из actions — через internal.health._mark.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { alertDown, alertRecovered } from "./alerts";
import { nowIso } from "./domain";

export type HealthKey = "ai" | "telegram" | "whatsapp" | "olx" | "pbx" | "email" | "site" | "api" | "backup" | "reminders" | "escalations" | "offsite";

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
  const id = await write(ctx, r, key, { okAt: nowIso(), okNote });
  // Владельцу уже сообщили о сбое — одно сообщение «восстановилось» (convex/alerts.ts).
  if (r?.alertState === "down") await alertRecovered(ctx, key, id);
}

/** ownerNotified — вызывающий уже сам написал владельцу об этом сбое (OLX отключился): оповещение не дублируем. */
export async function markError(ctx: MutationCtx, key: HealthKey, error: string, opts: { ownerNotified?: boolean } = {}): Promise<void> {
  const r = await row(ctx, key);
  const text = error.slice(0, 300);
  if (r && repeated(r.errorAt, r.okAt, r.error === text)) return;
  const id = await write(ctx, r, key, { errorAt: nowIso(), error: text });
  // Первая ошибка после успеха — оповещение владельцу (не чаще раза в час на подсистему); о текущем сбое уже сообщили — тишина.
  if (r?.alertState === "down") return;
  if (opts.ownerNotified) await ctx.db.patch(id, { alertAt: nowIso(), alertState: "down" });
  else await alertDown(ctx, key, id, r?.alertAt, `Сбой: ${text}`);
}

async function write(ctx: MutationCtx, r: Doc<"systemStatus"> | null, key: HealthKey, patch: Partial<Doc<"systemStatus">>): Promise<Id<"systemStatus">> {
  if (r) {
    await ctx.db.patch(r._id, patch);
    return r._id;
  }
  return ctx.db.insert("systemStatus", { key, ...patch });
}
