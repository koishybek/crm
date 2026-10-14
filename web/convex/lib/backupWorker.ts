// Внешнее хранилище копий без R2 (ТЗ п.20.10, п.26.5): маленький Cloudflare Worker поверх Workers KV
// (web/backup-worker). Три операции — PUT /o/<ключ>, GET /list?prefix=, DELETE /o/<ключ> — с заголовком
// Authorization: Bearer <секрет>. Адрес — только публичный https (как в lib/safeFetch.ts), перенаправления не
// выполняем: иначе секрет ушёл бы на другой адрес. В тексты ошибок — только HTTP-статус и код из ответа.
import { env } from "../env";
import { checkPublicUrl } from "./safeFetch";

export const WORKER_ENV = ["BACKUP_WORKER_URL", "BACKUP_WORKER_SECRET"] as const;
/** Значение в Workers KV — не больше 25 МиБ: файлы крупнее пропускаем с пометкой. */
export const WORKER_MAX_BYTES = 25 * 1024 * 1024;
/** Секрет короче — слабый: Worker такой не примет, и мы не ходим с ним. */
const MIN_SECRET = 32;
const TIMEOUT_MS = 120_000;

export interface WorkerConfig {
  base: URL;
  secret: string;
}

/** Адрес Worker: публичный https без пути, параметров и логина. null — задан с ошибкой. */
export function parseWorkerUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  const check = checkPublicUrl(raw.replace(/\/+$/, ""));
  if (!check.ok) return null;
  const u = check.url;
  return u.search || u.hash || (u.pathname && u.pathname !== "/") ? null : u;
}

/** Каких переменных не хватает (или заданы с ошибкой) — только имена, без значений. */
export function workerMissing(): string[] {
  const missing: string[] = WORKER_ENV.filter((k) => !env(k));
  if (env("BACKUP_WORKER_URL") && !parseWorkerUrl(env("BACKUP_WORKER_URL"))) missing.push("BACKUP_WORKER_URL (нужен https://адрес без пути)");
  const secret = env("BACKUP_WORKER_SECRET");
  if (secret && secret.length < MIN_SECRET) missing.push(`BACKUP_WORKER_SECRET (не короче ${MIN_SECRET} символов)`);
  return missing;
}

export function workerConfig(): WorkerConfig | null {
  if (workerMissing().length) return null;
  return { base: parseWorkerUrl(env("BACKUP_WORKER_URL"))!, secret: env("BACKUP_WORKER_SECRET")! };
}

/** Ошибка хранилища с понятным владельцу текстом (HTTP-статус и код Worker, без секрета). */
export class WorkerError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const objectPath = (key: string): string => `/o/${key.split("/").map(encodeURIComponent).join("/")}`;

async function call(cfg: WorkerConfig, method: "GET" | "PUT" | "DELETE", path: string, body?: Blob, contentType?: string): Promise<Response> {
  const url = new URL(path, cfg.base);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${cfg.secret}`, ...(contentType ? { "Content-Type": contentType } : {}) },
      body,
      redirect: "manual",
      signal: ctrl.signal,
    });
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new WorkerError("Хранилище перенаправляет запрос — проверьте BACKUP_WORKER_URL", res.status);
    return res;
  } catch (e) {
    if (e instanceof WorkerError) throw e;
    throw new WorkerError(`Хранилище не отвечает: ${e instanceof Error && e.name === "AbortError" ? "таймаут" : "ошибка сети"}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

/** «HTTP 401 unauthorized — проверьте …»: код ошибки Worker из JSON, подсказка по статусу. */
async function failure(res: Response, what: string): Promise<WorkerError> {
  let code = "";
  try {
    const body: unknown = await res.json();
    const raw = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
    code = typeof raw === "string" && /^[a-z_]{1,40}$/.test(raw) ? raw : "";
  } catch {
    /* не JSON — хватит статуса */
  }
  const hint =
    res.status === 401
      ? " — секрет не совпадает: BACKUP_WORKER_SECRET в Convex и BACKUP_SECRET в Worker должны быть одинаковыми"
      : res.status === 404
        ? " — проверьте BACKUP_WORKER_URL"
        : res.status === 413
          ? " — больше 25 МБ, Workers KV такие не хранит"
          : res.status === 500 && code === "not_configured"
            ? " — в Worker не задан BACKUP_SECRET (wrangler secret put BACKUP_SECRET)"
            : "";
  return new WorkerError(`${what}: HTTP ${res.status}${code ? ` ${code}` : ""}${hint}`, res.status);
}

export async function workerPut(cfg: WorkerConfig, key: string, body: Blob, contentType: string): Promise<void> {
  if (body.size > WORKER_MAX_BYTES) throw new WorkerError("Файл не загрузился во внешнее хранилище: больше 25 МБ, Workers KV такие не хранит", 413);
  const res = await call(cfg, "PUT", objectPath(key), body, contentType);
  if (!res.ok) throw await failure(res, "Файл не загрузился во внешнее хранилище");
}

export async function workerDelete(cfg: WorkerConfig, key: string): Promise<void> {
  const res = await call(cfg, "DELETE", objectPath(key));
  // 404 — объекта уже нет: цель достигнута.
  if (!res.ok && res.status !== 404) throw await failure(res, "Файл не удалился из внешнего хранилища");
}

export interface WorkerObject {
  key: string;
  size: number;
}

/** Все объекты с префиксом (страницы по 1000, курсор Workers KV). */
export async function workerList(cfg: WorkerConfig, prefix: string): Promise<WorkerObject[]> {
  const out: WorkerObject[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 100; page++) {
    const q = new URLSearchParams({ prefix, ...(cursor ? { cursor } : {}) });
    const res = await call(cfg, "GET", `/list?${q}`);
    if (!res.ok) throw await failure(res, "Не удалось получить список копий во внешнем хранилище");
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new WorkerError("Не удалось получить список копий во внешнем хранилище: ответ не JSON — проверьте BACKUP_WORKER_URL", res.status);
    }
    const b = (body && typeof body === "object" ? body : {}) as { objects?: unknown; cursor?: unknown };
    for (const o of Array.isArray(b.objects) ? b.objects : []) {
      const r = (o && typeof o === "object" ? o : {}) as { key?: unknown; size?: unknown };
      if (typeof r.key === "string") out.push({ key: r.key, size: typeof r.size === "number" ? r.size : 0 });
    }
    cursor = typeof b.cursor === "string" && b.cursor ? b.cursor : null;
    if (!cursor) break;
  }
  return out;
}
