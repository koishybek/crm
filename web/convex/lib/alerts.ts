// Оповещения владельцу о сбоях (ТЗ п.26.5): первая ошибка подсистемы после успеха или «давно не отрабатывала» —
// сообщение владельцам (колокольчик, Telegram, email — через общий notify), не чаще раза в час на подсистему;
// когда подсистема снова отработала — одно сообщение «восстановилось». Вызовы — из markOk/markError (lib/health.ts)
// и крона проверки (convex/alerts.ts).
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { SUBSYSTEMS } from "../../src/data/systemHealth";
import { audit } from "./audit";
import { notify, nowIso, staffRoster } from "./domain";
import type { EmailEvent } from "./mail";
import type { HealthKey } from "./health";

/** Оповещение о сбое одной подсистемы — не чаще раза в час. */
export const ALERT_EVERY_MS = 3600_000;

const label = (key: HealthKey): string => SUBSYSTEMS[key].label;

/** О сбое почты письмом не сообщаем: оно уйдёт тем же сломанным путём и добавит повторов. */
const viaEmail = (key: HealthKey): EmailEvent | undefined => (key === "email" ? undefined : { kind: "system_alert" });

/** Пауза ещё идёт: о сбое этой подсистемы сообщали меньше часа назад. */
export const alertThrottled = (alertAt: string | undefined, now: number): boolean => !!alertAt && now - Date.parse(alertAt) < ALERT_EVERY_MS;

/**
 * Сообщить о сбое. what — «Сбой: …» или «Давно не отрабатывало: …». В паузе — ничего не отправляет и состояние
 * не меняет: если сбой продолжится, крон проверки сообщит после паузы. true — сообщение ушло.
 */
export async function alertDown(ctx: MutationCtx, key: HealthKey, rowId: Id<"systemStatus">, alertAt: string | undefined, what: string): Promise<boolean> {
  if (alertThrottled(alertAt, Date.now())) return false;
  const { owners } = await staffRoster(ctx);
  const text = `⚠️ ${label(key)}. ${what}`.slice(0, 500);
  await notify(ctx, owners, text, { link: "/settings", tone: "bad", email: viaEmail(key) });
  await ctx.db.patch(rowId, { alertAt: nowIso(), alertState: "down" });
  await audit(ctx, "Система", "system.alert", `Оповещение владельцу: ${label(key)} — сбой`, { meta: { key } });
  return true;
}

/** Подсистема снова отработала после оповещения о сбое — одно сообщение. */
export async function alertRecovered(ctx: MutationCtx, key: HealthKey, rowId: Id<"systemStatus">): Promise<void> {
  const { owners } = await staffRoster(ctx);
  await notify(ctx, owners, `✅ ${label(key)}: восстановилось, снова работает`, { link: "/settings", tone: "ok", email: viaEmail(key) });
  await ctx.db.patch(rowId, { alertState: "up" });
  await audit(ctx, "Система", "system.alertRecovered", `Оповещение владельцу: ${label(key)} — восстановилось`, { meta: { key } });
}
