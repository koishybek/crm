// Время в кабинете мастера — всегда по Алматы (UTC+5) с фиксированным смещением.
// С 1 марта 2024 в Казахстане единый пояс UTC+5, но телефоны со старой базой поясов (до tzdata 2024a)
// считают Asia/Almaty как UTC+6, а getHours() берёт пояс телефона. Поэтому здесь нет ни Intl, ни getHours().
// Модуль общий для интерфейса и сервера (convex/executorApp.ts).

export const ALMATY_OFFSET_MS = 5 * 3600_000;
export const DAY_MS = 86400_000;
const HOUR_MS = 3600_000;
const MINUTE_MS = 60_000;

/** Момент времени: ISO-строка (как в базе) или UTC-миллисекунды. */
export type Moment = string | number;

const toMs = (t: Moment): number => (typeof t === "number" ? t : Date.parse(t));
const pad = (n: number) => String(n).padStart(2, "0");

const MONTH_SHORT = ["янв.", "фев.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const MONTH_AXIS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTH_NOMINATIVE = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const MONTH_PREPOSITIONAL = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре", "октябре", "ноябре", "декабре"];
const MONTH_GENITIVE = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

export interface AlmatyParts {
  year: number;
  /** 0 — январь … 11 — декабрь. */
  month: number;
  day: number;
  hours: number;
  minutes: number;
  /** 0 — понедельник … 6 — воскресенье. */
  weekday: number;
}

/** Календарные поля момента по Алматы. */
export function almatyParts(t: Moment): AlmatyParts {
  const d = new Date(toMs(t) + ALMATY_OFFSET_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), hours: d.getUTCHours(), minutes: d.getUTCMinutes(), weekday: (d.getUTCDay() + 6) % 7 };
}

/** Полночь по Алматы тех суток, куда попадает момент, — в UTC-мс. */
export function almatyDayStart(t: Moment): number {
  const p = almatyParts(t);
  return Date.UTC(p.year, p.month, p.day) - ALMATY_OFFSET_MS;
}

/** «2026-10-12» — день по Алматы: для чипов «Сегодня» и «Завтра». */
export function almatyDayKey(t: Moment): string {
  const p = almatyParts(t);
  return `${p.year}-${pad(p.month + 1)}-${pad(p.day)}`;
}

/** «2026-10» — месяц по Алматы: группировки «Завершённых» и «Дохода». */
export function monthKeyAlmaty(t: Moment): string {
  const p = almatyParts(t);
  return `${p.year}-${pad(p.month + 1)}`;
}

/** Месяц со сдвигом: shiftMonth("2026-01", -1) → "2025-12". */
export function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split("-").map(Number);
  const idx = (y ?? 1970) * 12 + ((m ?? 1) - 1) + delta;
  return `${Math.floor(idx / 12)}-${pad((((idx % 12) + 12) % 12) + 1)}`;
}

const monthIndex = (key: string) => Math.min(11, Math.max(0, Number(key.split("-")[1] ?? 1) - 1));

/** «Октябрь 2026» — заголовок группы. */
export function monthTitle(key: string): string {
  return `${MONTH_NOMINATIVE[monthIndex(key)]} ${key.split("-")[0]}`;
}

/** «октябре» — для «Заработано в октябре». */
export function monthPrepositional(key: string): string {
  return MONTH_PREPOSITIONAL[monthIndex(key)]!;
}

/** «марта 2025» — для «Мастер с марта 2025». */
export function monthYearGenitive(t: Moment): string {
  const p = almatyParts(t);
  return `${MONTH_GENITIVE[p.month]} ${p.year}`;
}

/** Понедельник 00:00 по Алматы той недели, куда попадает момент, — в UTC-мс. */
export function weekStartAlmaty(t: Moment): number {
  return almatyDayStart(t) - almatyParts(t).weekday * DAY_MS;
}

/** Разница в календарных днях по Алматы: 0 — сегодня, 1 — завтра, −1 — вчера. */
export function dayDiffAlmaty(t: Moment, now: Moment): number {
  return Math.round((almatyDayStart(t) - almatyDayStart(now)) / DAY_MS);
}

/** «14:05» по Алматы. */
export function timeAlmaty(t: Moment): string {
  const p = almatyParts(t);
  return `${pad(p.hours)}:${pad(p.minutes)}`;
}

/** «12 окт.»; другой год — «12 окт. 2025». */
export function dateAlmaty(t: Moment, now: Moment = Date.now()): string {
  const p = almatyParts(t);
  const sameYear = p.year === almatyParts(now).year;
  return `${p.day} ${MONTH_SHORT[p.month]}${sameYear ? "" : ` ${p.year}`}`;
}

/** «6 окт» — подпись под столбиком графика. */
export function dayMonthShort(t: Moment): string {
  const p = almatyParts(t);
  return `${p.day} ${MONTH_AXIS[p.month]}`;
}

/** «6–12 октября» — неделя для подписи столбика графика (экранный диктор). */
export function weekRangeLabel(start: Moment): string {
  const a = almatyParts(start);
  const b = almatyParts(toMs(start) + 6 * DAY_MS);
  return a.month === b.month ? `${a.day}–${b.day} ${MONTH_GENITIVE[b.month]}` : `${a.day} ${MONTH_GENITIVE[a.month]} – ${b.day} ${MONTH_GENITIVE[b.month]}`;
}

function dayWord(t: Moment, now: Moment): string {
  const diff = dayDiffAlmaty(t, now);
  if (diff === 0) return "Сегодня";
  if (diff === 1) return "Завтра";
  if (diff === -1) return "Вчера";
  return dateAlmaty(t, now);
}

/** Срок заказа: «Сегодня, до 14:00», «Завтра, до 10:00», «Вчера, до 18:00», «15 окт., до 12:00». */
export function dueLabel(deadline: Moment, now: Moment = Date.now()): string {
  return `${dayWord(deadline, now)}, до ${timeAlmaty(deadline)}`;
}

/** Момент события: «Сегодня, 14:05», «Вчера, 18:20», «12 окт., 09:30». */
export function whenLabel(t: Moment, now: Moment = Date.now()): string {
  return `${dayWord(t, now)}, ${timeAlmaty(t)}`;
}

/** Длительность: «45 мин», «2 ч», «2 ч 15 мин», «3 дн.». Меньше минуты — «1 мин». */
export function durationLabel(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / MINUTE_MS));
  if (minutes < 60) return `${minutes} мин`;
  if (minutes < 24 * 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m ? `${h} ч ${m} мин` : `${h} ч`;
  }
  return `${Math.round(minutes / (24 * 60))} дн.`;
}

/** Сколько до срока: «через 2 ч 15 мин»; срок прошёл — «просрочен на 40 мин», в ленте — «срок прошёл». */
export function relLabel(deadline: Moment, now: Moment = Date.now(), mode: "mine" | "feed" = "mine"): string {
  const diff = toMs(deadline) - toMs(now);
  if (diff >= 0) return `через ${durationLabel(diff)}`;
  return mode === "feed" ? "срок прошёл" : `просрочен на ${durationLabel(diff)}`;
}

/** Срок ещё не прошёл, но до него меньше 3 часов. */
export function isDueSoon(deadline: Moment, now: Moment = Date.now()): boolean {
  const diff = toMs(deadline) - toMs(now);
  return diff >= 0 && diff < 3 * HOUR_MS;
}

/** Срок уже прошёл. */
export function isPast(deadline: Moment, now: Moment = Date.now()): boolean {
  return toMs(deadline) < toMs(now);
}
