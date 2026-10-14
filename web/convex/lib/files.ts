// Файлы в хранилище Convex: удаление без падения, проверка загрузок на сервере (аудит M-10, E21)
// и короткоживущие подписанные ссылки вместо вечных публичных (аудит M-10, E16).
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./functions";
import { env } from "../env";
import { hmacSha256Hex, randomToken, safeEqual } from "./crypto";
import { boundTenant, DEFAULT_TENANT, tenantOf, tenantOfDoc, unscopedDb } from "./tenantDb";

/** Удалить файл; уже удалённый — не ошибка (на один файл бывает несколько ссылок). true — файл был и удалён. */
export async function dropFile(ctx: MutationCtx, id: Id<"_storage">): Promise<boolean> {
  try {
    await ctx.storage.delete(id);
    return true;
  } catch {
    return false;
  }
}

// ── Загрузки ─────────────────────────────────────────────────────────────────

export type UploadKind = "image" | "video" | "audio" | "file";

const MB = 1024 * 1024;
/** Потолок размера по типу файла. */
export const UPLOAD_LIMIT: Record<UploadKind, number> = { image: 15 * MB, video: 100 * MB, audio: 25 * MB, file: 25 * MB };
const KIND_LABEL: Record<UploadKind, string> = { image: "Фото", video: "Видео", audio: "Аудиозапись", file: "Документ" };
export const ANY_UPLOAD: readonly UploadKind[] = ["image", "video", "audio", "file"];

/** Что принимаем: фото, видео, аудио и офисные документы. HTML, SVG, архивы и программы — нет. */
const TYPES: readonly (readonly [UploadKind, RegExp])[] = [
  ["image", /^image\/(jpeg|jpg|pjpeg|png|webp|gif|heic|heif)$/],
  ["video", /^video\/(mp4|quicktime|webm|3gpp|x-m4v)$/],
  ["audio", /^audio\/(mpeg|mp3|mpeg3|x-mpeg-3|mp4|x-m4a|m4a|aac|x-aac|aacp|ogg|opus|wav|x-wav|wave|vnd\.wave|webm|flac|x-flac|amr|3gpp|x-ms-wma)$/],
  ["file", /^(application\/(pdf|msword|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))|text\/plain)$/],
];

const baseType = (contentType: string | undefined) => (contentType ?? "").split(";")[0]!.trim().toLowerCase();

export const uploadKind = (contentType: string | undefined): UploadKind | null => {
  const t = baseType(contentType);
  return TYPES.find(([, re]) => re.test(t))?.[0] ?? null;
};

/** Метаданные файла из системной таблицы _storage. */
interface StoredMeta {
  size: number;
  contentType?: string;
  _creationTime: number;
}

export type UploadCheck = { ok: true; kind: UploadKind } | { ok: false; error: string };

/** Тип и размер файла по метаданным хранилища (их записывает сам Convex при загрузке). */
export function checkUpload(meta: Pick<StoredMeta, "size" | "contentType">, allowed: readonly UploadKind[] = ANY_UPLOAD): UploadCheck {
  const kind = uploadKind(meta.contentType);
  if (!kind || !allowed.includes(kind)) {
    const what = allowed.length === 1 && allowed[0] === "audio" ? "Нужен аудиофайл: mp3, wav, ogg или m4a" : "Такой тип файла не принимаем: фото, видео, аудио, PDF, Word или Excel";
    return { ok: false, error: what };
  }
  if (meta.size > UPLOAD_LIMIT[kind]) return { ok: false, error: `Файл слишком большой: ${KIND_LABEL[kind].toLowerCase()} — до ${UPLOAD_LIMIT[kind] / MB} МБ` };
  if (meta.size <= 0) return { ok: false, error: "Файл пустой" };
  return { ok: true, kind };
}

const NOT_FOUND = "Файл не найден — загрузите его ещё раз";
/** «Забрать» загрузку можно в течение часа после неё: старые и чужие id (их видно в ссылках) не подойдут. */
const CLAIM_WINDOW_MS = 3600_000;

const uploadRow = (ctx: QueryCtx, storageId: Id<"_storage">) =>
  ctx.db
    .query("uploads")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .unique();

/**
 * Шаг после загрузки по uploadUrl: тип и размер проверяет сервер, загрузка закрепляется за пользователем.
 * Неподходящий файл удаляется сразу — поэтому ответ, а не исключение: исключение откатило бы и удаление.
 */
export async function registerUpload(ctx: MutationCtx, userId: Id<"users">, storageId: Id<"_storage">): Promise<UploadCheck> {
  const meta = await ctx.db.system.get("_storage", storageId);
  // Хранилище файлов общее для всех компаний: загрузку ищем среди всех — файл другой компании присвоить нельзя.
  const row = await unscopedDb(ctx)
    .query("uploads")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .first();
  // Повтор подтверждения (сеть оборвалась на ответе) — тот же ответ; чужая загрузка — «не найдена».
  if (row) return row.userId === userId && tenantOfDoc(row) === tenantOf(ctx) && meta ? checkUpload(meta) : { ok: false, error: NOT_FOUND };
  if (!meta || Date.now() - meta._creationTime > CLAIM_WINDOW_MS) return { ok: false, error: NOT_FOUND };
  const check = checkUpload(meta);
  if (!check.ok) {
    await dropFile(ctx, storageId);
    return check;
  }
  await ctx.db.insert("uploads", { storageId, userId, at: new Date().toISOString() });
  return check;
}

/** Прикрепить загрузку к заказу или звонку: только свою, подтверждённую, один раз и подходящего типа. */
export async function takeUpload(ctx: MutationCtx, userId: Id<"users">, storageId: Id<"_storage">, allowed: readonly UploadKind[] = ANY_UPLOAD): Promise<UploadKind> {
  const row = await uploadRow(ctx, storageId);
  if (!row || row.userId !== userId) throw new ConvexError(NOT_FOUND);
  if (row.usedAt) throw new ConvexError("Этот файл уже прикреплён — загрузите его ещё раз");
  const meta = await ctx.db.system.get("_storage", storageId);
  if (!meta) throw new ConvexError(NOT_FOUND);
  const check = checkUpload(meta, allowed);
  if (!check.ok) throw new ConvexError(check.error);
  await ctx.db.patch(row._id, { usedAt: new Date().toISOString() });
  return check.kind;
}

/** Имя файла для показа и скачивания: без управляющих символов и путей, не длиннее 120 символов. */
export function cleanFileName(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f"\\/<>]/g, "").trim().slice(0, 120);
}

// ── Подписанные ссылки ───────────────────────────────────────────────────────

/** Ссылка живёт 15 минут; экраны получают свежие через запросы с меткой «t» (src/data/files.ts). */
export const FILE_URL_TTL_S = 15 * 60;
/** Срок округляем вверх до минуты: повторный запуск запроса в ту же минуту даёт те же ссылки — картинки не перегружаются. */
const URL_GRID_S = 60;
/** Путь HTTP-действия, которое отдаёт файл по подписи (http.ts). */
export const FILES_PATH = "/files/";
/** Секрет подписи, если FILES_SIGNING_KEY не задан: создаётся один раз, клиентам не отдаётся и в резервную копию не попадает. */
const KEY_SETTING = "filesSigningKey";

export async function signingKey(ctx: QueryCtx): Promise<string | null> {
  const fromEnv = env("FILES_SIGNING_KEY");
  if (fromEnv) return fromEnv;
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", KEY_SETTING))
    .unique();
  return row?.value ?? null;
}

/** Без FILES_SIGNING_KEY ключ подписи создаётся при первой загрузке, копии или уборке (crons.ts). */
export async function ensureSigningKey(ctx: MutationCtx): Promise<void> {
  if (env("FILES_SIGNING_KEY")) return;
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", KEY_SETTING))
    .unique();
  if (!row) await ctx.db.insert("settings", { key: KEY_SETTING, value: randomToken(32) });
}

export const fileSignature = (key: string, storageId: string, exp: number, name: string): string => hmacSha256Hex(key, `files:v1\n${storageId}\n${exp}\n${name}`);

export interface FileSigner {
  /** Подписанная ссылка; undefined — нет файла, ключа подписи или адреса Convex. name — имя файла при скачивании. */
  url(storageId: Id<"_storage"> | undefined, name?: string): string | undefined;
}

/** Подписывает ссылки одним сроком на весь ответ запроса. */
export async function fileSigner(ctx: QueryCtx): Promise<FileSigner> {
  const key = await signingKey(ctx);
  const site = env("CONVEX_SITE_URL")?.replace(/\/+$/, "");
  if (!key || !site) return { url: () => undefined };
  // Ключ подписи — свой у каждой компании: ссылка говорит, чьим ключом её проверять (без «c» — компания по умолчанию).
  const tenant = boundTenant(ctx);
  const c = tenant && tenant !== DEFAULT_TENANT ? `&c=${encodeURIComponent(tenant)}` : "";
  const exp = Math.ceil((Date.now() / 1000 + FILE_URL_TTL_S) / URL_GRID_S) * URL_GRID_S;
  return {
    url(storageId, name) {
      if (!storageId) return undefined;
      const n = name ? cleanFileName(name) : "";
      return `${site}${FILES_PATH}${storageId}?exp=${exp}${n ? `&name=${encodeURIComponent(n)}` : ""}${c}&sig=${fileSignature(key, storageId, exp, n)}`;
    },
  };
}

/** tenant — компания ссылки (?c=…): у каждой компании свой ключ подписи, если FILES_SIGNING_KEY не задан. */
export type FileLink = { storageId: string; exp: number; name: string; sig: string; tenant?: string };

/** Разбор ссылки /files/<id>?exp=…&sig=…[&name=…]. Мусор — null. */
export function parseFileLink(url: URL): FileLink | null {
  if (!url.pathname.startsWith(FILES_PATH)) return null;
  const storageId = url.pathname.slice(FILES_PATH.length);
  const exp = url.searchParams.get("exp") ?? "";
  const sig = url.searchParams.get("sig") ?? "";
  const name = url.searchParams.get("name") ?? "";
  const tenant = url.searchParams.get("c");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(storageId) || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig) || name.length > 200) return null;
  if (tenant !== null && !/^[a-z0-9-]{2,40}$/.test(tenant)) return null;
  return { storageId, exp: Number(exp), name, sig, ...(tenant ? { tenant } : {}) };
}

/**
 * Можно ли отдать файл по ссылке: срок не прошёл и не дальше, чем мы выдаём, подпись верна (сравнение за постоянное время).
 * "expired" и "invalid" — обе причины дают 403.
 */
export function checkFileLink(link: FileLink, key: string | null, nowMs: number): "ok" | "expired" | "invalid" {
  if (!key) return "invalid";
  const now = nowMs / 1000;
  if (link.exp > now + FILE_URL_TTL_S + 2 * URL_GRID_S) return "invalid";
  if (!safeEqual(link.sig, fileSignature(key, link.storageId, link.exp, link.name))) return "invalid";
  return link.exp < now ? "expired" : "ok";
}

// ── Ответ с файлом ───────────────────────────────────────────────────────────

/** Открытый диапазон «bytes=N-» отдаём кусками: плееры сами запрашивают продолжение. */
const MAX_CHUNK = 8 * MB;

/**
 * Один диапазон «bytes=a-b», «bytes=a-» или «bytes=-n» (RFC 9110). null — заголовка нет, он не разобран или диапазонов
 * несколько: отдаём файл целиком. "unsatisfiable" — начало за концом файла (416).
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : null;
  if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end: end === null ? Math.min(size - 1, start + MAX_CHUNK - 1) : Math.min(end, size - 1) };
}

/** Показывать прямо в браузере: картинки, звук, видео и PDF. Остальное — только скачать (HTML/SVG не исполнятся). */
const INLINE = /^(image\/(jpeg|jpg|pjpeg|png|webp|gif|heic|heif|avif|bmp)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/;

function disposition(inline: boolean, name: string): string {
  if (!name) return inline ? "inline" : "attachment";
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * Ответ с файлом: поддержка Range (206) для перемотки аудио и видео, свой Content-Type, Cache-Control private
 * на остаток срока ссылки, nosniff; небезопасные для показа типы — только скачиванием и в песочнице.
 */
export function fileResponse(request: Request, blob: Blob, opts: { type: string; name: string; exp: number; nowMs: number }): Response {
  // Тип — как его записало хранилище, но только корректным токеном «тип/подтип»: иначе — «просто байты».
  const stored = baseType(opts.type);
  const type = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(stored) ? stored : "application/octet-stream";
  const inline = INLINE.test(type);
  const size = blob.size;
  const headers = new Headers({
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": `private, max-age=${Math.max(0, Math.min(FILE_URL_TTL_S, Math.floor(opts.exp - opts.nowMs / 1000)))}`,
    "Content-Disposition": disposition(inline, opts.name),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (!inline) headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
  const head = request.method === "HEAD";
  const range = parseRange(request.headers.get("range"), size);
  if (range === "unsatisfiable") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (!range) {
    headers.set("Content-Length", String(size));
    return new Response(head ? null : blob, { status: 200, headers });
  }
  headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  headers.set("Content-Length", String(range.end - range.start + 1));
  return new Response(head ? null : blob.slice(range.start, range.end + 1), { status: 206, headers });
}
