// Куда уходят внешние копии (ТЗ п.20.10, п.26.5): S3-совместимое хранилище (lib/s3.ts — R2, PS Cloud, AWS S3),
// если задана хоть одна BACKUP_S3_*; иначе Cloudflare Worker с Workers KV (lib/backupWorker.ts), если задана
// хоть одна BACKUP_WORKER_*; иначе — «не подключено». offsite.ts работает с хранилищем только через этот интерфейс.
import { env } from "../env";
import { S3_ENV, s3Config, s3Delete, s3List, s3Missing, s3Put, S3Error } from "./s3";
import { WORKER_ENV, WORKER_MAX_BYTES, workerConfig, workerDelete, WorkerError, workerList, workerMissing, workerPut } from "./backupWorker";

export type OffsiteProvider = "s3" | "worker";

export interface OffsiteObject {
  key: string;
  size: number;
}

export interface OffsiteStore {
  provider: OffsiteProvider;
  /** Потолок размера одного объекта (у Workers KV — 25 МиБ); null — без потолка. */
  maxBytes: number | null;
  /** Для карточки: адрес хранилища, бакет и регион (у S3). Секретов нет. */
  where: { host: string; bucket?: string; region?: string };
  put(key: string, body: Blob, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  list(prefix: string): Promise<OffsiteObject[]>;
}

const touched = (keys: readonly string[]): boolean => keys.some((k) => !!env(k));

export const offsiteProvider = (): OffsiteProvider | null => (touched(S3_ENV) ? "s3" : touched(WORKER_ENV) ? "worker" : null);

/** Каких переменных не хватает — только имена. Ничего не выбрано — подсказываем Worker (R2 на аккаунте не включён). */
export function offsiteMissing(): string[] {
  const p = offsiteProvider();
  return p === "s3" ? s3Missing() : p === "worker" ? workerMissing() : [...WORKER_ENV];
}

/** null — внешнее хранилище не подключено. */
export function offsiteStore(): OffsiteStore | null {
  const p = offsiteProvider();
  if (p === "s3") {
    const cfg = s3Config();
    return cfg
      ? {
          provider: "s3",
          maxBytes: null,
          where: { host: cfg.endpoint.host, bucket: cfg.bucket, region: cfg.cred.region },
          put: (key, body, type) => s3Put(cfg, key, body, type),
          remove: (key) => s3Delete(cfg, key),
          list: (prefix) => s3List(cfg, prefix),
        }
      : null;
  }
  if (p === "worker") {
    const cfg = workerConfig();
    return cfg
      ? {
          provider: "worker",
          maxBytes: WORKER_MAX_BYTES,
          where: { host: cfg.base.host },
          put: (key, body, type) => workerPut(cfg, key, body, type),
          remove: (key) => workerDelete(cfg, key),
          list: (prefix) => workerList(cfg, prefix),
        }
      : null;
  }
  return null;
}

/** Текст ошибки хранилища для мониторинга и журнала: свой — как есть, чужой — обрезанный. */
export const storeErrorText = (e: unknown): string =>
  e instanceof S3Error || e instanceof WorkerError ? e.message : e instanceof Error ? e.message.slice(0, 200) : "неизвестная ошибка";
