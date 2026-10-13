// Сроки реакции и эскалации (ТЗ п.15 «эскалация руководителю», п.18 «критические события»): пороги, их границы
// и рабочее время операторов — общие для сервера (convex/escalations.ts) и карточки владельца в «Настройках».
import { ALMATY_OFFSET_MS, DAY_MS } from "./workerTime";

export interface SlaSettings {
  /** Заказ в ленте без исполнителя столько минут — руководителю направления. */
  feedMin: number;
  /** …столько — владельцу. */
  feedOwnerMin: number;
  /** Мастер назначен, но не подтвердил — руководителю направления (без автораспределения заказ возвращается в ленту). */
  unconfirmedMin: number;
  /** Заказ просрочен дольше — владельцу (второй уровень после уведомления о просрочке). */
  overdueOwnerMin: number;
  /** Заявка из канала без первого действия оператора — операторам. Считается рабочее время. */
  leadMin: number;
  /** Пропущенный звонок без перезвона — операторам. Считается рабочее время. */
  callbackMin: number;
  /** Рабочие часы операторов по Алматы: с dayStart:00 до dayEnd:00. */
  dayStart: number;
  dayEnd: number;
}

export type SlaKey = keyof SlaSettings;

export const SLA_DEFAULTS: SlaSettings = { feedMin: 30, feedOwnerMin: 120, unconfirmedMin: 30, overdueOwnerMin: 1440, leadMin: 15, callbackMin: 30, dayStart: 9, dayEnd: 21 };

/** Границы: меньше — сплошной шум, больше — эскалация теряет смысл. */
export const SLA_LIMITS: Record<SlaKey, { min: number; max: number }> = {
  feedMin: { min: 5, max: 1440 },
  feedOwnerMin: { min: 10, max: 4320 },
  unconfirmedMin: { min: 5, max: 1440 },
  overdueOwnerMin: { min: 60, max: 10080 },
  leadMin: { min: 5, max: 480 },
  callbackMin: { min: 5, max: 480 },
  dayStart: { min: 0, max: 23 },
  dayEnd: { min: 1, max: 24 },
};

export const SLA_KEYS = Object.keys(SLA_DEFAULTS) as SlaKey[];

export const SLA_LABEL: Record<SlaKey, string> = {
  feedMin: "Заказ в ленте без исполнителя — руководителю",
  feedOwnerMin: "Заказ в ленте без исполнителя — владельцу",
  unconfirmedMin: "Мастер не подтвердил назначение",
  overdueOwnerMin: "Просрочка — владельцу",
  leadMin: "Заявка без ответа оператора",
  callbackMin: "Пропущенный звонок без перезвона",
  dayStart: "Начало рабочего дня операторов",
  dayEnd: "Конец рабочего дня операторов",
};

/** Что не так с настройками — текст для человека; null — всё верно. */
export function slaProblem(s: SlaSettings): string | null {
  for (const k of SLA_KEYS) {
    const { min, max } = SLA_LIMITS[k];
    if (!Number.isInteger(s[k]) || s[k] < min || s[k] > max) return `${SLA_LABEL[k]}: целое число от ${min} до ${max}`;
  }
  if (s.feedOwnerMin <= s.feedMin) return "Владельцу — позже, чем руководителю: иначе руководитель узнаёт последним";
  if (s.dayEnd <= s.dayStart) return "Конец рабочего дня — позже начала";
  return null;
}

/** Сохранённое значение (JSON) → настройки: неверные и пропущенные поля — по умолчанию. */
export function parseSla(json: string | undefined): SlaSettings {
  let raw: unknown = null;
  try {
    raw = json ? JSON.parse(json) : null;
  } catch {
    raw = null;
  }
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: SlaSettings = { ...SLA_DEFAULTS };
  for (const k of SLA_KEYS) {
    const v = src[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= SLA_LIMITS[k].min && v <= SLA_LIMITS[k].max) out[k] = v;
  }
  return slaProblem(out) ? { ...SLA_DEFAULTS } : out;
}

/**
 * Сколько рабочего времени операторов (с startHour до endHour по Алматы) прошло между from и to, мс.
 * Заявка, пришедшая в 20:50, к 21:00 ждёт 10 минут, а следующие 5 «натикают» в 9:05 утра.
 */
export function workingMs(from: number, to: number, startHour: number, endHour: number): number {
  if (!(to > from)) return 0;
  let total = 0;
  // Полночь по Алматы суток, в которые попадает from (в UTC-мс).
  let day = Math.floor((from + ALMATY_OFFSET_MS) / DAY_MS) * DAY_MS - ALMATY_OFFSET_MS;
  for (; day < to; day += DAY_MS) {
    const open = Math.max(from, day + startHour * 3600_000);
    const close = Math.min(to, day + endHour * 3600_000);
    if (close > open) total += close - open;
  }
  return total;
}
