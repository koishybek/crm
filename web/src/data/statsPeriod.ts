// Периоды «Аналитики» и «Главной» (ТЗ 17, 23.4): пресеты и свой период — дни по Алматы, обе границы включительно.
// Итоги за период сервер берёт из предрасчёта (convex/stats.ts), прошлый период — той же длины, сразу перед выбранным.
import { DAY_RE, MAX_PERIOD_DAYS, daysBetween, monthBounds, monthOfDay, shiftDay, shiftMonth, todayDay } from "./dailyStats";
import type { PeriodId } from "./metrics";

export interface DayRange {
  from: string;
  to: string;
}

export type PresetId = PeriodId | "month" | "prevMonth" | "365d" | "custom";

export const PRESETS: { id: PresetId; label: string; prev: string }[] = [
  { id: "today", label: "Сегодня", prev: "к вчерашнему дню" },
  { id: "7d", label: "Последние 7 дней", prev: "к прошлой неделе" },
  { id: "30d", label: "Последние 30 дней", prev: "к прошлым 30 дням" },
  { id: "90d", label: "Последние 90 дней", prev: "к прошлым 90 дням" },
  { id: "month", label: "Этот месяц", prev: "к тем же дням до него" },
  { id: "prevMonth", label: "Прошлый месяц", prev: "к месяцу до него" },
  { id: "365d", label: "Последние 12 месяцев", prev: "к прошлым 12 месяцам" },
  { id: "custom", label: "Свой период…", prev: "к прошлому периоду" },
];

const LAST_DAYS: Record<PeriodId, number> = { today: 1, "7d": 7, "30d": 30, "90d": 90 };

/** Последние n дней по сегодняшний (по Алматы). */
export const lastDays = (days: number, now = Date.now()): DayRange => ({ from: shiftDay(todayDay(now), -(days - 1)), to: todayDay(now) });

/** Период пресета на сегодня; «свой период» — custom как есть. */
export function presetRange(id: PresetId, custom: DayRange, now = Date.now()): DayRange {
  const today = todayDay(now);
  if (id === "custom") return custom;
  if (id === "month") return { from: `${monthOfDay(today)}-01`, to: today };
  if (id === "prevMonth") {
    const m = monthBounds(shiftMonth(monthOfDay(today), -1));
    return { from: m.first, to: m.last };
  }
  if (id === "365d") return lastDays(365, now);
  return lastDays(LAST_DAYS[id], now);
}

/** Что не так со своим периодом — текст для формы; null — всё в порядке. */
export function rangeProblem(r: DayRange): string | null {
  if (!DAY_RE.test(r.from) || !DAY_RE.test(r.to)) return "Укажите обе даты";
  if (r.from > r.to) return "Начало периода позже его конца";
  if (daysBetween(r.from, r.to) > MAX_PERIOD_DAYS) return `Период — не длиннее ${MAX_PERIOD_DAYS} дней`;
  return null;
}

/** «1–14 окт. 2026» — подпись периода. */
export function rangeLabel(r: DayRange): string {
  const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(`${d}T12:00:00Z`).toLocaleDateString("ru-RU", { timeZone: "UTC", ...opts });
  if (r.from === r.to) return fmt(r.from, { day: "numeric", month: "long", year: "numeric" });
  const sameYear = r.from.slice(0, 4) === r.to.slice(0, 4);
  return `${fmt(r.from, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" })} — ${fmt(r.to, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** Подпись точки ряда: день — «14 окт», месяц — «окт 2026». */
export function periodLabel(p: string): string {
  const d = new Date(`${p.length === 7 ? `${p}-01` : p}T12:00:00Z`);
  return p.length === 7 ? d.toLocaleDateString("ru-RU", { timeZone: "UTC", month: "short", year: "numeric" }) : d.toLocaleDateString("ru-RU", { timeZone: "UTC", day: "numeric", month: "short" });
}
