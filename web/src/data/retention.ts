// Срок хранения записей звонков и расшифровок (ТЗ п.26.4): настройка владельца, по умолчанию — год, 0 — бессрочно.
// Удаляет крон convex/retention.ts.

export const RETENTION_DEFAULT_DAYS = 365;
/** Не больше 10 лет: дальше — «бессрочно» (0). */
export const RETENTION_MAX_DAYS = 3650;

export interface RetentionSettings {
  /** Записи звонков (аудиофайлы), дней; 0 — бессрочно. */
  recordingsDays: number;
  /** Расшифровки звонков, дней; 0 — бессрочно. */
  transcriptsDays: number;
}

/** Ошибка ввода или null: целое число от 0 до 3650. */
export function retentionProblem(days: number): string | null {
  return Number.isInteger(days) && days >= 0 && days <= RETENTION_MAX_DAYS ? null : `Срок — целое число дней от 0 (бессрочно) до ${RETENTION_MAX_DAYS}`;
}

/** «365 дней», «бессрочно». */
export const retentionLabel = (days: number): string => (days === 0 ? "бессрочно" : `${days} ${days % 10 === 1 && days % 100 !== 11 ? "день" : [2, 3, 4].includes(days % 10) && ![12, 13, 14].includes(days % 100) ? "дня" : "дней"}`);
