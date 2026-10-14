// Подписка компании (ТЗ §24): оплату тарифа платформа принимает сама (Kaspi, перевод, наличные) и вносит её на
// экране «Платформа»; срок «оплачено до», напоминания и приостановка после льготных дней. Одни правила для сервера
// (convex/billing.ts) и интерфейса. Даты — дни по Алматы «YYYY-MM-DD»; «оплачено до» включает этот день.
import type { CsvValue } from "../lib/csv";
import { PLAN_INFO, PLANS, type Plan } from "./plans";

export const PAY_METHODS = ["kaspi", "transfer", "cash", "card", "other"] as const;
export type PayMethod = (typeof PAY_METHODS)[number];
export const PAY_METHOD_LABEL: Record<PayMethod, string> = {
  kaspi: "Kaspi",
  transfer: "Перевод на счёт",
  cash: "Наличные",
  card: "Карта",
  other: "Другое",
};

/** Льготные дни после окончания оплаты по умолчанию (меняет администратор платформы). */
export const DEFAULT_GRACE_DAYS = 5;
export const MAX_GRACE_DAYS = 60;
/** За сколько дней до конца напоминаем — по одному разу. */
export const REMIND_DAYS = [7, 1] as const;
export type RemindDay = (typeof REMIND_DAYS)[number];
/** «Заканчивается» — осталось столько дней или меньше. */
export const ENDING_DAYS = 7;
/** Оплату можно отменить сутки (ошиблись суммой или компанией). */
export const UNDO_WINDOW_MS = 24 * 3600_000;
export const MAX_MONTHS = 36;
/** Дальше этого срока «оплачено до» не ставим — скорее всего, опечатка в годе. */
export const MAX_PERIOD_DAYS = 3 * 366;
export const MAX_AMOUNT = 100_000_000;
export const MAX_NOTE = 300;
export const MAX_HOW_TO_PAY = 1000;

export const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ALMATY_MS = 5 * 3600_000;
const DAY_MS = 86_400_000;

/** Сегодня по Алматы. */
export const todayAlmaty = (now = Date.now()): string => new Date(now + ALMATY_MS).toISOString().slice(0, 10);

/** Настоящая дата (не 31 февраля). */
export const isDay = (s: string): boolean => DAY_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Через n месяцев; 31-е в коротком месяце — его последний день. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/** Сколько дней от a до b (b − a). */
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/**
 * Период новой оплаты. Подписка действует (оплачено до сегодня или дальше) — продлеваем со следующего дня после
 * «оплачено до»; закончилась или её не было — с сегодняшнего дня. Конец — через N месяцев (минус день) или явная дата.
 */
export function paymentPeriod(paidUntil: string | null | undefined, today: string, by: { months: number } | { until: string }): { from: string; to: string } {
  const from = paidUntil && paidUntil >= today ? addDays(paidUntil, 1) : today;
  const to = "months" in by ? addDays(addMonths(from, by.months), -1) : by.until;
  return { from, to };
}

/** Проблема с периодом — текстом для администратора; null — всё в порядке. */
export function periodProblem(p: { from: string; to: string }, today: string): string | null {
  if (!isDay(p.to)) return "Укажите дату «оплачено до»";
  if (p.to < p.from) return `Конец периода раньше его начала (${p.from})`;
  if (daysBetween(today, p.to) > MAX_PERIOD_DAYS) return "Слишком далёкая дата — не больше трёх лет вперёд";
  return null;
}

export type SubscriptionState = "unlimited" | "paid" | "ending" | "expired";
export interface SubscriptionStatus {
  state: SubscriptionState;
  /** Дней от сегодня до «оплачено до»: 0 — сегодня последний оплаченный день; отрицательное — столько дней просрочено. */
  daysLeft: number | null;
}

/** Нет «оплачено до» — бессрочно (демо-компания, компании до SaaS). */
export function subscriptionStatus(paidUntil: string | null | undefined, today: string): SubscriptionStatus {
  if (!paidUntil) return { state: "unlimited", daysLeft: null };
  const daysLeft = daysBetween(today, paidUntil);
  return { state: daysLeft < 0 ? "expired" : daysLeft <= ENDING_DAYS ? "ending" : "paid", daysLeft };
}

/**
 * Какое напоминание пора отправить: за 7 дней (осталось ≤ 7) и за 1 день (осталось ≤ 1) — каждое один раз на этот
 * срок. Пропущенный день крона не теряет напоминание; после окончания срока не напоминаем — дальше приостановка.
 */
export function reminderDue(paidUntil: string | null | undefined, today: string, sent: readonly number[]): RemindDay | null {
  if (!paidUntil) return null;
  const left = daysBetween(today, paidUntil);
  if (left < 0) return null;
  if (left <= 1) return sent.includes(1) ? null : 1;
  if (left <= 7) return sent.includes(7) ? null : 7;
  return null;
}

/** Пора приостановить: прошли «оплачено до» и льготные дни. Без «оплачено до» — никогда. */
export const suspendDue = (paidUntil: string | null | undefined, today: string, graceDays: number): boolean => !!paidUntil && daysBetween(paidUntil, today) > graceDays;

/** «3 дня», «1 день», «5 дней». */
export function daysText(n: number): string {
  const a = Math.abs(n);
  const word = a % 10 === 1 && a % 100 !== 11 ? "день" : [2, 3, 4].includes(a % 10) && ![12, 13, 14].includes(a % 100) ? "дня" : "дней";
  return `${a} ${word}`;
}

/** «14.10.2026» из «2026-10-14». */
export const dayText = (day: string): string => (isDay(day) ? `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}` : day);

/** Подпись срока для списков: «оплачено до 14.10.2026», «заканчивается через 3 дня», «просрочено 2 дня». */
export function statusText(s: SubscriptionStatus, paidUntil: string | null | undefined): string {
  if (s.state === "unlimited" || !paidUntil) return "бессрочно";
  if (s.state === "expired") return `просрочено ${daysText(-(s.daysLeft ?? 0))}`;
  if (s.state === "ending") return s.daysLeft === 0 ? "последний день" : `заканчивается через ${daysText(s.daysLeft ?? 0)}`;
  return `оплачено до ${dayText(paidUntil)}`;
}

// ── Настройки платформы ──────────────────────────────────────────────────────

export interface PlatformSettings {
  graceDays: number;
  /** Как оплатить — свободный текст (номер Kaspi, реквизиты, телефон): на экране «Доступ отключён» и в напоминаниях. */
  howToPay: string;
  /** Цена тарифа в месяц, ₸ — для подсказки суммы при приёме оплаты; 0 — не задана. */
  prices: Record<Plan, number>;
}

export const DEFAULT_PLATFORM_SETTINGS: PlatformSettings = { graceDays: DEFAULT_GRACE_DAYS, howToPay: "", prices: { free: 0, standard: 0, pro: 0 } };

/** Проблема с настройками; null — можно сохранять. */
export function settingsProblem(s: PlatformSettings): string | null {
  if (!Number.isInteger(s.graceDays) || s.graceDays < 0 || s.graceDays > MAX_GRACE_DAYS) return `Льготные дни — целое число от 0 до ${MAX_GRACE_DAYS}`;
  if (s.howToPay.length > MAX_HOW_TO_PAY) return `«Как оплатить» — не длиннее ${MAX_HOW_TO_PAY} символов`;
  for (const p of PLANS) {
    const v = s.prices[p];
    if (!Number.isFinite(v) || v < 0 || v > MAX_AMOUNT) return `Цена тарифа «${PLAN_INFO[p].label}» — от 0 до ${MAX_AMOUNT} ₸`;
  }
  return null;
}

// ── Оплаты ───────────────────────────────────────────────────────────────────

export interface SubscriptionPaymentRow {
  id: string;
  tenant: string;
  tenantName: string;
  amount: number;
  currency: "KZT";
  method: PayMethod;
  months: number | null;
  periodFrom: string;
  periodTo: string;
  paidAt: string;
  note: string;
  byName: string;
  plan: Plan;
  undoneAt: string | null;
  /** Можно отменить: последняя действующая оплата компании и прошло меньше суток. */
  canUndo: boolean;
}

/** Выгрузка оплат в CSV (ячейки обезвреживает toCsv — src/lib/csv.ts). */
export function paymentsCsv(rows: readonly SubscriptionPaymentRow[], dateTime: (iso: string) => string): CsvValue[][] {
  return [
    ["Дата оплаты", "Компания", "Адрес компании", "Тариф", "Сумма, ₸", "Способ", "Месяцев", "Период с", "Период по", "Комментарий", "Принял", "Отменена"],
    ...rows.map((r) => [
      dateTime(r.paidAt),
      r.tenantName,
      r.tenant,
      PLAN_INFO[r.plan].label,
      r.amount,
      PAY_METHOD_LABEL[r.method],
      r.months ?? "",
      dayText(r.periodFrom),
      dayText(r.periodTo),
      r.note,
      r.byName,
      r.undoneAt ? dateTime(r.undoneAt) : "",
    ]),
  ];
}

/** Подписка своей компании — владельцу (карточка «Компания», плашка на «Главной»). */
export interface MySubscription {
  plan: Plan;
  paidUntil: string | null;
  status: SubscriptionStatus;
  howToPay: string;
}

/** Экран «Доступ отключён»: работа компании приостановлена — за неоплату или администратором. */
export interface BlockedInfo {
  company: string;
  unpaid: boolean;
  paidUntil: string | null;
  howToPay: string;
}
