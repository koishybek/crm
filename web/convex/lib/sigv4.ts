// Подпись запросов AWS Signature Version 4 (ТЗ п.20.10, п.26.5): ею пользуются все S3-совместимые хранилища —
// Cloudflare R2, PS Cloud, AWS S3, MinIO. Написано по документации AWS «Signature Version 4 signing process»
// на crypto.subtle, без зависимостей. Проверено на официальных тест-векторах (convex/offsite.test.ts).

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Регион: у R2 — «auto», у AWS — «eu-central-1» и т.п. */
  region: string;
  /** Сервис: «s3». */
  service: string;
}

export interface SigV4Request {
  method: string;
  url: URL;
  /** Заголовки, которые подписываем (host и x-amz-date добавляются сами). */
  headers: Record<string, string>;
  /** Hex SHA-256 тела (для S3 — то же значение, что в x-amz-content-sha256). */
  payloadHash: string;
}

const utf8 = new TextEncoder();

const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Hex SHA-256 строки или байтов. */
export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? utf8.encode(data) : data));
}

async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, message: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, utf8.encode(message));
}

/**
 * URI-кодирование по правилам SigV4: всё, кроме A-Z a-z 0-9 - _ . ~, — в %XX (заглавными).
 * encodeURIComponent оставляет ещё ! ' ( ) * — их добиваем вручную.
 */
export const uriEncode = (s: string): string => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Путь: каждый сегмент кодируется, «/» остаются. У S3 путь не нормализуется (двойные «/» и «.» — часть ключа). */
const canonicalPath = (url: URL): string =>
  url.pathname
    .split("/")
    .map((seg) => uriEncode(decodeURIComponent(seg)))
    .join("/") || "/";

/** Параметры запроса: закодированы и отсортированы по имени, затем по значению. */
function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(([k, v]) => [uriEncode(k), uriEncode(v)] as const);
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/** «20130524T000000Z» — время запроса в формате ISO 8601 basic. */
export const amzDate = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Ключ подписи: HMAC по цепочке дата → регион → сервис → «aws4_request». */
export async function signingKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate = await hmac(utf8.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export interface SignedParts {
  canonicalRequest: string;
  stringToSign: string;
  signature: string;
  /** Заголовки для fetch: исходные + host, x-amz-date и authorization. */
  headers: Record<string, string>;
}

/** Подписать запрос. now — время подписи (у сервера допуск ±15 минут). */
export async function signV4(req: SigV4Request, cred: SigV4Credentials, now: Date): Promise<SignedParts> {
  const stamp = amzDate(now);
  const date = stamp.slice(0, 8);
  const all: Record<string, string> = { ...req.headers, host: req.url.host, "x-amz-date": stamp };
  const names = Object.keys(all)
    .map((n) => n.toLowerCase())
    .sort();
  const value = (n: string) => {
    const key = Object.keys(all).find((k) => k.toLowerCase() === n)!;
    return all[key]!.trim().replace(/\s+/g, " ");
  };
  const canonicalHeaders = names.map((n) => `${n}:${value(n)}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [req.method.toUpperCase(), canonicalPath(req.url), canonicalQuery(req.url), canonicalHeaders, signedHeaders, req.payloadHash].join("\n");
  const scope = `${date}/${cred.region}/${cred.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join("\n");
  const signature = toHex(await hmac(await signingKey(cred.secretAccessKey, date, cred.region, cred.service), stringToSign));
  const authorization = `AWS4-HMAC-SHA256 Credential=${cred.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  // host fetch выставит сам (и не даст переопределить) — в заголовки запроса его не кладём.
  const { host: _host, ...rest } = all;
  void _host;
  return { canonicalRequest, stringToSign, signature, headers: { ...rest, authorization } };
}
