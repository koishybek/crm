// Внешнее хранилище резервных копий (ТЗ п.20.10, п.26.5): ответ сервера для карточки «Резервные копии» и инструкция.
import type { HealthMark } from "./systemHealth";

export interface OffsiteStatus {
  /** Хранилище выбрано и все его переменные заданы. */
  configured: boolean;
  /** S3-совместимое (BACKUP_S3_*) или Cloudflare Worker с Workers KV (BACKUP_WORKER_*). */
  provider: "s3" | "worker" | null;
  /** Каких переменных не хватает (имена, без значений). */
  missing: string[];
  host?: string;
  bucket?: string;
  region?: string;
  /** Потолок размера файла (Workers KV — 25 МБ): файлы крупнее не копируются. */
  maxFileMb?: number;
  /** Сколько копий храним там. */
  keep: number;
  /** Копировать и сами файлы (записи, фото) — настройка владельца. */
  copyFiles: boolean;
  health?: HealthMark;
}

/** Как подключить — по шагам, для карточки: Cloudflare Worker с Workers KV (R2 не нужен), подробности — README. */
export const OFFSITE_STEPS: readonly string[] = [
  "Выложите Worker хранилища из папки backup-worker: wrangler kv namespace create BACKUPS, id пространства — в wrangler.jsonc, wrangler secret put BACKUP_SECRET (случайная строка от 32 символов), wrangler deploy.",
  "В Convex задайте переменные: BACKUP_WORKER_URL (адрес Worker, например https://homemax-backup.<аккаунт>.workers.dev) и BACKUP_WORKER_SECRET — тот же секрет.",
  "Нажмите «Сделать копию» — через минуту здесь появится отметка о выгрузке.",
];

/** Вместо Worker — S3-совместимое хранилище (у него приоритет, если заданы его переменные). */
export const OFFSITE_S3_NOTE =
  "Или S3-совместимое хранилище (Cloudflare R2, PS Cloud, AWS S3): BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY и при необходимости BACKUP_S3_REGION — без потолка 25 МБ на файл.";
