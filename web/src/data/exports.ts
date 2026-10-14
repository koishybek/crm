// Выгрузки владельца в CSV (ТЗ п.26.9 «Экспорт CSV/Excel»): что выгружаем, за какой период и как называется файл.
// Общие для сервера (convex/exports.ts собирает файл постранично, без лимита браузера) и экрана (кнопка «Выгрузка»).

export const EXPORT_KINDS = ["leads", "orders", "calls", "executors", "payments", "payouts", "audit"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export const EXPORT_KIND: Record<ExportKind, { label: string; file: string; period: string }> = {
  leads: { label: "Заявки", file: "zayavki", period: "по дате создания" },
  orders: { label: "Заказы", file: "zakazy", period: "по дате создания" },
  calls: { label: "Звонки", file: "zvonki", period: "по началу звонка" },
  executors: { label: "Исполнители", file: "ispolniteli", period: "все исполнители; заказы и выплаты — за период" },
  payments: { label: "Оплаты и возвраты", file: "oplaty", period: "по дате оплаты или возврата" },
  payouts: { label: "Выплаты мастерам", file: "vyplaty", period: "по дате выплаты" },
  audit: { label: "Журнал действий", file: "zhurnal", period: "по времени действия" },
};

/** Строк в одном файле — не больше: дальше это уже резервная копия, а не таблица для Excel. Выгружайте по частям. */
export const EXPORT_MAX_ROWS = 20_000;
/** Готовый файл хранится сутки и отдаётся только по подписанной ссылке, затем его удаляет уборка. */
export const EXPORT_TTL_MS = 24 * 3600_000;

/** Алматы живёт по UTC+5 круглый год: дни и месяцы периода — по нему. */
const ALMATY_MS = 5 * 3600_000;
const DAY_MS = 86400_000;
const almaty = (t: number) => new Date(t + ALMATY_MS);
/** Полночь по Алматы для дня по Алматы (год, месяц 0–11, число). */
const midnight = (y: number, m: number, d: number) => Date.UTC(y, m, d) - ALMATY_MS;

/** «2026-10-14» — день по Алматы. */
export const almatyDay = (t: number): string => almaty(t).toISOString().slice(0, 10);

export type PeriodPreset = "month" | "prevMonth" | "30d" | "90d" | "year" | "custom";
export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: "month", label: "Этот месяц" },
  { id: "prevMonth", label: "Прошлый месяц" },
  { id: "30d", label: "Последние 30 дней" },
  { id: "90d", label: "Последние 90 дней" },
  { id: "year", label: "С начала года" },
  { id: "custom", label: "Выбрать даты" },
];

export interface ExportRange {
  from: string;
  to: string;
}

/**
 * Границы периода в ISO UTC. Дни — по Алматы: «с» — с полуночи, «по» — до конца дня. custom — даты из полей
 * «с»/«по» (YYYY-MM-DD); пустые или перепутанные — null.
 */
export function exportRange(preset: PeriodPreset, now: number, custom?: { from: string; to: string }): ExportRange | null {
  const d = almaty(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const today = midnight(y, m, d.getUTCDate());
  const end = new Date(now).toISOString();
  switch (preset) {
    case "month":
      return { from: new Date(midnight(y, m, 1)).toISOString(), to: end };
    case "prevMonth":
      return { from: new Date(midnight(y, m - 1, 1)).toISOString(), to: new Date(midnight(y, m, 1) - 1).toISOString() };
    case "30d":
      return { from: new Date(today - 29 * DAY_MS).toISOString(), to: end };
    case "90d":
      return { from: new Date(today - 89 * DAY_MS).toISOString(), to: end };
    case "year":
      return { from: new Date(midnight(y, 0, 1)).toISOString(), to: end };
    case "custom": {
      const day = /^(\d{4})-(\d{2})-(\d{2})$/;
      const a = day.exec(custom?.from ?? "");
      const b = day.exec(custom?.to ?? "");
      if (!a || !b) return null;
      const from = midnight(Number(a[1]), Number(a[2]) - 1, Number(a[3]));
      const to = midnight(Number(b[1]), Number(b[2]) - 1, Number(b[3])) + DAY_MS - 1;
      if (Number.isNaN(from) || Number.isNaN(to) || from > to) return null;
      return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
    }
  }
}

/** Имя файла: «zakazy-2026-10-01_2026-10-14.csv» (дни по Алматы). */
export const exportFileName = (kind: ExportKind, r: ExportRange): string => `${EXPORT_KIND[kind].file}-${almatyDay(Date.parse(r.from))}_${almatyDay(Date.parse(r.to))}.csv`;
