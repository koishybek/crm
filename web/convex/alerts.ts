// Оповещения владельцу (ТЗ п.26.5), проверка по расписанию: подсистема «давно не отрабатывала» (крон напоминаний,
// эскалации, ночная копия, синхронизация OLX) или сбой, о котором не сообщили из-за часовой паузы.
// Сами сообщения и пауза — lib/alerts.ts; первая ошибка после успеха уходит сразу из markError (lib/health.ts).
import { internalMutation } from "./_generated/server";
import { alertDown, alertThrottled } from "./lib/alerts";
import { almatyStamp } from "./lib/audit";
import type { HealthKey } from "./lib/health";
import { SUBSYSTEMS, type SubsystemKey } from "../src/data/systemHealth";

const isKey = (k: string): k is HealthKey => Object.hasOwn(SUBSYSTEMS, k);

/** Ошибки интерфейса старше двух недель не нужны. */
const CLIENT_ERRORS_TTL_MS = 14 * 86400_000;

export const check = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ alerted: SubsystemKey[] }> => {
    const now = Date.now();
    const olx = await ctx.db
      .query("integrations")
      .withIndex("by_provider", (q) => q.eq("provider", "olx"))
      .first();
    // OLX молчит законно, пока его не подключили или отключили.
    const watched = (key: HealthKey): boolean => key !== "olx" || (!!olx && olx.status !== "disconnected");
    const alerted: SubsystemKey[] = [];
    for (const r of await ctx.db.query("systemStatus").collect()) {
      if (!isKey(r.key) || r.alertState === "down" || alertThrottled(r.alertAt, now)) continue;
      const ok = r.okAt ? Date.parse(r.okAt) : NaN;
      const failing = !!r.errorAt && (Number.isNaN(ok) || Date.parse(r.errorAt) >= ok);
      const stale = SUBSYSTEMS[r.key].staleMs;
      let what: string | null = null;
      if (failing) what = `Сбой: ${r.error ?? "ошибка"}`;
      else if (stale && !Number.isNaN(ok) && now - ok > stale && watched(r.key)) what = `Давно не отрабатывало: последний успешный запуск ${almatyStamp(r.okAt!)}`;
      if (what && (await alertDown(ctx, r.key, r._id, r.alertAt, what))) alerted.push(r.key);
    }
    const old = await ctx.db
      .query("clientErrors")
      .withIndex("by_last", (q) => q.lt("lastAt", new Date(now - CLIENT_ERRORS_TTL_MS).toISOString()))
      .take(200);
    for (const e of old) await ctx.db.delete(e._id);
    return { alerted };
  },
});
