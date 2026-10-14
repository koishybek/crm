// Внешнее хранилище резервных копий (ТЗ п.20.10, п.26.5): любой S3-совместимый сервис — Cloudflare R2, PS Cloud,
// AWS S3. Три операции REST API S3 (PutObject, ListObjectsV2, DeleteObject) с подписью SigV4 (lib/sigv4.ts).
// Адресация path-style (https://endpoint/bucket/key) — её понимают все эти хранилища.
import { env } from "../env";
import { sha256Hex, signV4, type SigV4Credentials } from "./sigv4";

export const S3_ENV = ["BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"] as const;

export interface S3Config {
  endpoint: URL;
  bucket: string;
  cred: SigV4Credentials;
}

/** Имя бакета по правилам S3: 3–63 символа, строчные латинские, цифры, «-» и «.». */
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** Адрес хранилища: только https, без пути, параметров и логина в адресе. null — задан с ошибкой. */
export function parseEndpoint(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.replace(/\/+$/, ""));
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) return null;
    return u;
  } catch {
    return null;
  }
}

/** Каких переменных не хватает (или заданы с ошибкой) — только имена, без значений. */
export function s3Missing(): string[] {
  const missing: string[] = S3_ENV.filter((k) => !env(k));
  if (env("BACKUP_S3_ENDPOINT") && !parseEndpoint(env("BACKUP_S3_ENDPOINT"))) missing.push("BACKUP_S3_ENDPOINT (нужен https://адрес без пути)");
  if (env("BACKUP_S3_BUCKET") && !BUCKET.test(env("BACKUP_S3_BUCKET")!)) missing.push("BACKUP_S3_BUCKET (имя бакета с ошибкой)");
  return missing;
}

/** null — внешнее хранилище не подключено. */
export function s3Config(): S3Config | null {
  if (s3Missing().length) return null;
  return {
    endpoint: parseEndpoint(env("BACKUP_S3_ENDPOINT"))!,
    bucket: env("BACKUP_S3_BUCKET")!,
    cred: { accessKeyId: env("BACKUP_S3_ACCESS_KEY_ID")!, secretAccessKey: env("BACKUP_S3_SECRET_ACCESS_KEY")!, region: env("BACKUP_S3_REGION") ?? "auto", service: "s3" },
  };
}

/** Ошибка хранилища с понятным владельцу текстом (код S3 и HTTP-статус, без ключей и тел запросов). */
export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 120_000;

function objectUrl(cfg: S3Config, key: string, query?: Record<string, string>): URL {
  const path = key
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
  const u = new URL(`${cfg.endpoint.origin}/${cfg.bucket}${key ? `/${path}` : ""}`);
  for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
  return u;
}

const xmlText = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? xmlText(m[1]!) : undefined;
};

/** Текст ошибки S3: «HTTP 403 AccessDenied». Message из ответа не берём — в нём бывает имя ключа доступа. */
async function failure(res: Response, what: string): Promise<S3Error> {
  let code = "";
  try {
    code = tag(await res.text(), "Code")?.slice(0, 60) ?? "";
  } catch {
    /* тело не прочиталось — хватит статуса */
  }
  const hint = res.status === 403 ? " — проверьте ключи доступа и права на бакет" : res.status === 404 ? " — бакет не найден" : "";
  return new S3Error(`${what}: HTTP ${res.status}${code ? ` ${code}` : ""}${hint}`, res.status);
}

/**
 * Тело загрузки не хэшируем (UNSIGNED-PAYLOAD — допускается S3 и R2 по https): файл уходит потоком, не копируясь
 * в память действия ради подписи — записи и видео бывают по 100 МБ.
 */
async function send(cfg: S3Config, method: "GET" | "PUT" | "DELETE", url: URL, body?: Blob, contentType?: string): Promise<Response> {
  const payloadHash = body ? "UNSIGNED-PAYLOAD" : await sha256Hex("");
  const headers: Record<string, string> = { "x-amz-content-sha256": payloadHash, ...(contentType ? { "content-type": contentType } : {}) };
  const signed = await signV4({ method, url, headers, payloadHash }, cfg.cred, new Date());
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { method, headers: signed.headers, body, signal: ctrl.signal });
  } catch (e) {
    throw new S3Error(`Хранилище не отвечает: ${e instanceof Error && e.name === "AbortError" ? "таймаут" : "ошибка сети"}`, 0);
  } finally {
    clearTimeout(timer);
  }
}

export async function s3Put(cfg: S3Config, key: string, body: Blob, contentType: string): Promise<void> {
  const res = await send(cfg, "PUT", objectUrl(cfg, key), body, contentType);
  if (!res.ok) throw await failure(res, "Файл не загрузился во внешнее хранилище");
}

export async function s3Delete(cfg: S3Config, key: string): Promise<void> {
  const res = await send(cfg, "DELETE", objectUrl(cfg, key));
  // 404 — объекта уже нет: цель достигнута.
  if (!res.ok && res.status !== 404) throw await failure(res, "Файл не удалился из внешнего хранилища");
}

export interface S3Object {
  key: string;
  size: number;
}

/** Все объекты с префиксом (ListObjectsV2, страницы по 1000). */
export async function s3List(cfg: S3Config, prefix: string): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | undefined;
  for (let page = 0; page < 100; page++) {
    const res = await send(cfg, "GET", objectUrl(cfg, "", { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) }));
    if (!res.ok) throw await failure(res, "Не удалось получить список копий во внешнем хранилище");
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = tag(m[1]!, "Key");
      if (key !== undefined) out.push({ key, size: Number(tag(m[1]!, "Size") ?? 0) });
    }
    token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
    if (!token) break;
  }
  return out;
}
