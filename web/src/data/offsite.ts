// Внешнее хранилище резервных копий (ТЗ п.20.10, п.26.5): ответ сервера для карточки «Резервные копии» и инструкция.
import type { HealthMark } from "./systemHealth";

export interface OffsiteStatus {
  /** Все переменные BACKUP_S3_* заданы. */
  configured: boolean;
  /** Каких переменных не хватает (имена, без значений). */
  missing: string[];
  host?: string;
  bucket?: string;
  region?: string;
  /** Сколько копий храним там. */
  keep: number;
  /** Копировать и сами файлы (записи, фото) — настройка владельца. */
  copyFiles: boolean;
  health?: HealthMark;
}

/** Как подключить — по шагам, для карточки (на примере Cloudflare R2; PS Cloud и AWS S3 — так же). */
export const OFFSITE_STEPS: readonly string[] = [
  "Создайте бакет в S3-совместимом хранилище: Cloudflare R2, PS Cloud Object Storage или AWS S3.",
  "Выпустите ключ доступа с правами чтения и записи только на этот бакет.",
  "В Convex задайте переменные: BACKUP_S3_ENDPOINT (адрес хранилища, например https://<account>.r2.cloudflarestorage.com), BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY и при необходимости BACKUP_S3_REGION (у R2 — auto).",
  "Нажмите «Сделать копию» — через минуту здесь появится отметка о выгрузке.",
];
