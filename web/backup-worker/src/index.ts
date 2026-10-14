// Внешнее хранилище резервных копий Home Max Service без R2: Cloudflare Worker поверх Workers KV.
// Его зовёт только сервер (convex/lib/backupWorker.ts) с заголовком Authorization: Bearer <BACKUP_SECRET>.
//   PUT    /o/<ключ>        — положить объект (до 25 МиБ — потолок значения KV), метаданные { size, at }
//   GET    /o/<ключ>        — забрать объект (для восстановления вручную)
//   DELETE /o/<ключ>        — удалить (нет объекта — тоже 204)
//   GET    /list?prefix=…   — ключи с размерами, страницами по 1000 (&cursor=…)
// Ключи — только наши: [t/<компания>/](backups|files)/<имя>, безопасные символы; у каждой компании своя папка.
// Секрет сравнивается за постоянное время; без секрета (или короче 32 символов) Worker не отвечает никому.

/** То, что нужно от пространства Workers KV (подмножество KVNamespace). */
export interface KvLike {
  getWithMetadata<M>(key: string, type: "stream"): Promise<{ value: ReadableStream | null; metadata: M | null }>;
  put(key: string, value: ArrayBuffer, options: { metadata: ObjectMeta }): Promise<void>;
  delete(key: string): Promise<void>;
  list<M>(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string; metadata?: M }[]; list_complete: boolean; cursor?: string }>;
}

export interface Env {
  BACKUPS: KvLike;
  BACKUP_SECRET?: string;
}

export interface ObjectMeta {
  size: number;
  at: string;
}

/** Потолок значения Workers KV — 25 МиБ. */
export const MAX_BYTES = 25 * 1024 * 1024;
const MIN_SECRET = 32;
const TENANT = "t\\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\\/";
const KEY_RE = new RegExp(`^(?:${TENANT})?(?:backups|files)\\/[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`);
/** Префикс списка — начало нашего ключа: папка компании (если есть) и раздел, имя — частично. */
const PREFIX_RE = new RegExp(`^(?:${TENANT})?(?:backups|files)\\/[A-Za-z0-9._-]{0,200}$`);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
const error = (code: string, status: number): Response => json({ error: code }, status);

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

/** Сравнение за постоянное время: сравниваем хэши одинаковой длины, без раннего выхода. */
export async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function authorized(req: Request, env: Env): Promise<boolean> {
  const m = /^Bearer (\S+)$/.exec(req.headers.get("Authorization") ?? "");
  return !!m && (await sameSecret(m[1]!, env.BACKUP_SECRET!));
}

/** Ключ из пути /o/<ключ>: декодированный и проверенный; null — недопустимый. */
function keyOf(path: string): string | null {
  let key: string;
  try {
    key = decodeURIComponent(path.slice("/o/".length));
  } catch {
    return null;
  }
  return KEY_RE.test(key) && !key.split("/").some((p) => p === "." || p === "..") ? key : null;
}

async function putObject(req: Request, env: Env, key: string): Promise<Response> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > MAX_BYTES) return error("too_large", 413);
  const body = await req.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return error("too_large", 413);
  const meta: ObjectMeta = { size: body.byteLength, at: new Date().toISOString() };
  await env.BACKUPS.put(key, body, { metadata: meta });
  return json({ ok: true, size: meta.size }, 201);
}

async function getObject(env: Env, key: string): Promise<Response> {
  const { value, metadata } = await env.BACKUPS.getWithMetadata<ObjectMeta>(key, "stream");
  if (!value) return error("not_found", 404);
  const headers: Record<string, string> = { "Content-Type": "application/octet-stream", "Cache-Control": "no-store" };
  if (metadata && typeof metadata.size === "number") headers["Content-Length"] = String(metadata.size);
  return new Response(value, { status: 200, headers });
}

async function list(url: URL, env: Env): Promise<Response> {
  const prefix = url.searchParams.get("prefix") ?? "";
  const cursor = url.searchParams.get("cursor") ?? undefined;
  if (!PREFIX_RE.test(prefix)) return error("bad_prefix", 400);
  if (cursor !== undefined && (cursor.length > 1024 || !/^[A-Za-z0-9._~+/=-]+$/.test(cursor))) return error("bad_cursor", 400);
  const page = await env.BACKUPS.list<ObjectMeta>({ prefix, cursor, limit: 1000 });
  return json({
    objects: page.keys.map((k) => ({ key: k.name, size: typeof k.metadata?.size === "number" ? k.metadata.size : 0, at: k.metadata?.at ?? null })),
    cursor: page.list_complete ? null : (page.cursor ?? null),
  });
}

/** Весь Worker — чистая функция от запроса и окружения: её проверяют тесты с поддельным KV. */
export async function handle(req: Request, env: Env): Promise<Response> {
  if (!env.BACKUP_SECRET || env.BACKUP_SECRET.length < MIN_SECRET) return error("not_configured", 500);
  if (!(await authorized(req, env))) return error("unauthorized", 401);
  const url = new URL(req.url);
  if (url.pathname === "/list") return req.method === "GET" ? list(url, env) : error("method_not_allowed", 405);
  if (!url.pathname.startsWith("/o/")) return error("not_found", 404);
  const key = keyOf(url.pathname);
  if (!key) return error("bad_key", 400);
  switch (req.method) {
    case "PUT":
      return putObject(req, env, key);
    case "GET":
      return getObject(env, key);
    case "DELETE":
      await env.BACKUPS.delete(key);
      return new Response(null, { status: 204 });
    default:
      return error("method_not_allowed", 405);
  }
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env),
};
