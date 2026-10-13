// OLX.kz Partner API v2 (developer.olx.kz): протокол без сети и базы — адреса, разбор ответов и ошибок, даты,
// курсор синхронизации. Одинаково работает в рантайме Convex и в тестах. Запросы и токены — в lib/olxApi.ts,
// функции Convex (подключение, синхронизация, отметка «прочитано») — в channels/olx.ts.
import { v, type Infer } from "convex/values";

export const OLX_ORIGIN = "https://www.olx.kz";
export const OLX_API = `${OLX_ORIGIN}/api/partner`;
export const OLX_AUTHORIZE_URL = `${OLX_ORIGIN}/oauth/authorize/`;
export const OLX_TOKEN_URL = `${OLX_ORIGIN}/api/open/oauth/token`;
/** read — читать чаты, write — отвечать и отмечать прочитанным, v2 — без него API отвечает 401. */
export const OLX_SCOPE = "read write v2";
/** Предел длины ответа: свой лимит OLX не публикует, длинное может отклонить. */
export const OLX_MAX_TEXT = 2000;
/** Даты OLX приходят без пояса («2026-10-12 14:03:11») — это время Казахстана (UTC+5 с 01.03.2024). */
export const OLX_DEFAULT_OFFSET = "+05:00";
export const OLX_REAUTH_TEXT = "Нужно заново подключить OLX";

// ── Сужение недоверенного JSON ──

type Rec = Record<string, unknown>;
export const isRecord = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x.trim() : undefined);

/** Неотрицательное целое: id у OLX — числа, но строку из цифр тоже принимаем. */
function int(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : typeof x === "string" && /^\d{1,15}$/.test(x.trim()) ? Number(x) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/** uuid треда и сообщения — ключ в базе и часть пути запроса: только безопасные символы. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;
const keyOf = (x: unknown): string | undefined => {
  const s = str(x);
  return s && KEY.test(s) ? s : undefined;
};

function httpsUrl(x: unknown): string | undefined {
  const s = str(x);
  if (!s) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString().slice(0, 1000) : undefined;
  } catch {
    return undefined;
  }
}

/** Тело ответа как JSON — даже с Content-Type: text/html (так OLX отдаёт ошибки OAuth). Не JSON — undefined. */
export function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** Успешные ответы OLX обычно в конверте {"data": …}, но не все — принимаем оба вида. */
export const unwrap = (body: unknown): unknown => (isRecord(body) && "data" in body ? body.data : body);

/** Список из ответа; не список (страница прокси, чужой формат) — null. */
export function listOf(body: unknown): unknown[] | null {
  const d = unwrap(body);
  return Array.isArray(d) ? d : null;
}

// ── OAuth ──

export function authorizeUrl(a: { clientId: string; redirectUri: string; state: string }): string {
  // redirect_uri обязателен: в приложении OLX зарегистрированы два адреса (prod и dev).
  const q = new URLSearchParams({ client_id: a.clientId, response_type: "code", scope: OLX_SCOPE, state: a.state, redirect_uri: a.redirectUri });
  return `${OLX_AUTHORIZE_URL}?${q.toString()}`;
}

export interface OlxToken {
  accessToken: string;
  refreshToken?: string;
  /** Секунд от момента запроса к /oauth/token. */
  expiresIn: number;
  scope?: string;
}

export function asToken(body: unknown): OlxToken | null {
  const b = unwrap(body);
  if (!isRecord(b)) return null;
  const accessToken = str(b.access_token);
  const expiresIn = typeof b.expires_in === "number" ? b.expires_in : Number(b.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return { accessToken, refreshToken: str(b.refresh_token), expiresIn: Math.min(expiresIn, 30 * 86400), scope: str(b.scope) };
}

/** Выданы ли нужные права (OLX просит проверять scope выданного токена). Поля нет — выдано запрошенное. */
export function hasScopes(scope: string | undefined): boolean {
  if (!scope) return true;
  const got = new Set(scope.split(/[\s,+]+/).filter(Boolean));
  return OLX_SCOPE.split(" ").every((s) => got.has(s));
}

export interface OlxAccount {
  id: string;
  name?: string;
  email?: string;
}

/** GET /users/me — какой аккаунт OLX подключён. */
export function asAccount(body: unknown): OlxAccount | null {
  const b = unwrap(body);
  if (!isRecord(b)) return null;
  const id = int(b.id);
  return id === undefined ? null : { id: String(id), name: str(b.name)?.slice(0, 120), email: str(b.email)?.slice(0, 120) };
}

/** Имя и email аккаунта — владелец сверит, что подключён аккаунт компании, а не личный. */
export const accountLabel = (a: OlxAccount): string => [a.name, a.email].filter(Boolean).join(" · ") || `ID ${a.id}`;

// ── Треды, сообщения, объявления ──

export const vOlxThread = v.object({
  /** uuid треда — conversations.externalId и путь в запросах; пока OLX не отдаёт uuid — числовой id строкой. */
  key: v.string(),
  id: v.optional(v.number()),
  advertId: v.optional(v.number()),
  interlocutorId: v.optional(v.number()),
  /** Всего сообщений в треде (входящие и исходящие) — по нему видно, что тред изменился. */
  total: v.number(),
  /** Непрочитанных подключённым аккаунтом. */
  unread: v.number(),
});
export type OlxThread = Infer<typeof vOlxThread>;

const vAttachment = v.object({ name: v.optional(v.string()), url: v.string() });
export type OlxAttachment = Infer<typeof vAttachment>;

export const vOlxMessage = v.object({
  /** uuid сообщения (нет uuid — «t{тред}:m{id}»): ключ от дублей, в базе — «olx:…». */
  key: v.string(),
  id: v.optional(v.number()),
  /** С точки зрения подключённого аккаунта: received — от покупателя, sent — от компании. */
  type: v.union(v.literal("sent"), v.literal("received")),
  text: v.string(),
  /** ISO UTC; без даты — время записи. */
  at: v.optional(v.string()),
  isRead: v.boolean(),
  attachments: v.array(vAttachment),
});
export type OlxMessage = Infer<typeof vOlxMessage>;

export function asThread(x: unknown): OlxThread | null {
  if (!isRecord(x)) return null;
  const id = int(x.id);
  const key = keyOf(x.uuid) ?? (id !== undefined ? String(id) : undefined);
  const total = int(x.total_count);
  if (!key || total === undefined) return null;
  return { key, id, advertId: int(x.advert_id), interlocutorId: int(x.interlocutor_id), total, unread: int(x.unread_count) ?? 0 };
}

export function asMessage(x: unknown, threadId: number | undefined, offset: string): OlxMessage | null {
  if (!isRecord(x)) return null;
  const type = x.type === "sent" || x.type === "received" ? x.type : null;
  const id = int(x.id);
  const tid = int(x.thread_id) ?? threadId;
  const key = keyOf(x.uuid) ?? (id !== undefined && tid !== undefined ? `t${tid}:m${id}` : undefined);
  if (!type || !key) return null;
  const attachments = (Array.isArray(x.attachments) ? x.attachments : [])
    .flatMap((a): OlxAttachment[] => {
      if (!isRecord(a)) return [];
      const url = httpsUrl(a.url);
      return url ? [{ name: str(a.name)?.slice(0, 200), url }] : [];
    })
    .slice(0, 10);
  return { key, id, type, text: typeof x.text === "string" ? x.text.slice(0, 8000) : "", at: parseOlxDate(x.created_at, offset), isRead: x.is_read === true, attachments };
}

/** По времени, при равном — по id: порядок выдачи OLX не документирован. */
export function sortMessages(list: OlxMessage[]): OlxMessage[] {
  const t = (m: OlxMessage) => (m.at ? Date.parse(m.at) : NaN);
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = t(a.m);
      const tb = t(b.m);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return ta - tb;
      return (a.m.id ?? 0) - (b.m.id ?? 0) || a.i - b.i;
    })
    .map((x) => x.m);
}

/** Тот же текст с точностью до пробелов и переносов — так узнаём свой ответ в треде OLX. */
export const sameText = (a: string, b: string): boolean => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** Текст для ленты: сообщение + ссылки на вложения, которые не сохранили у себя. */
export function messageText(m: OlxMessage, keptUrl?: string): string {
  const links = m.attachments.filter((a) => a.url !== keptUrl).map((a) => `📎 ${a.name ? `${a.name} — ` : ""}${a.url}`);
  return [m.text.trim(), ...links].filter(Boolean).join("\n");
}

/** Вложения скачиваем только с CDN OLX по https — остальное остаётся ссылкой. */
export function isOlxCdn(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "olxcdn.com" || u.hostname.endsWith(".olxcdn.com"));
  } catch {
    return false;
  }
}

export interface OlxAdvert {
  id: number;
  title: string;
  url?: string;
}

/** Ссылка на объявление — только страница olx.kz по https (из числового id она не строится). */
function advertUrl(x: unknown): string | undefined {
  const url = httpsUrl(x);
  if (!url) return undefined;
  const host = new URL(url).hostname;
  return host === "olx.kz" || host.endsWith(".olx.kz") ? url : undefined;
}

export function asAdvert(body: unknown): OlxAdvert | null {
  const b = unwrap(body);
  if (!isRecord(b)) return null;
  const id = int(b.id);
  const title = str(b.title);
  return id === undefined || !title ? null : { id, title: title.slice(0, 300), url: advertUrl(b.url) };
}

/** GET /users/{id} — имя собеседника. Телефон и email покупателя OLX не отдаёт. */
export function asUserName(body: unknown): string | undefined {
  const b = unwrap(body);
  return isRecord(b) ? str(b.name)?.slice(0, 120) : undefined;
}

// ── Даты ──

const NAIVE_DATE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(\.\d+)?$/;
const ZONED_DATE = /(?:[zZ]|[+-]\d{2}:?\d{2})$/;

/** Смещение из OLX_TIME_OFFSET («+05:00»); неверное или пустое — время Казахстана. */
export const timeOffset = (raw: string | undefined): string => (raw && /^[+-](?:0\d|1[0-4]):[0-5]\d$/.test(raw) ? raw : OLX_DEFAULT_OFFSET);

/** «YYYY-MM-DD HH:mm:ss» без пояса — со смещением offset; ISO с Z или смещением — как есть. Результат — ISO UTC. */
export function parseOlxDate(raw: unknown, offset: string = OLX_DEFAULT_OFFSET): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  const naive = NAIVE_DATE.exec(s);
  const ms = naive ? Date.parse(`${naive[1]}T${naive[2]}${(naive[3] ?? "").slice(0, 4)}${offset}`) : ZONED_DATE.test(s) ? Date.parse(s) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

// ── Ошибки ──

export const vOlxFailure = v.union(
  /** 401: токен недействителен или не хватает прав (invalid_token, insufficient_scope). */
  v.object({ kind: v.literal("unauthorized") }),
  /** invalid_grant: код подключения или refresh-токен протух либо отозван. */
  v.object({ kind: v.literal("grant") }),
  /** invalid_client / unauthorized_client / invalid_scope: ключи приложения неверны или приложение не активно. */
  v.object({ kind: v.literal("client") }),
  /** 403 HTML от CloudFront: лимит 4500 запросов за 5 минут с IP или плохой User-Agent — блок на 30 минут. */
  v.object({ kind: v.literal("blocked"), requestId: v.optional(v.string()) }),
  v.object({ kind: v.literal("throttled"), retryAfterSec: v.optional(v.number()) }),
  /** 5xx, обрыв связи или таймаут (status 0). */
  v.object({ kind: v.literal("server"), status: v.number(), timeout: v.optional(v.boolean()) }),
  /** 403 JSON: у аккаунта нет прав на ресурс. */
  v.object({ kind: v.literal("forbidden") }),
  v.object({ kind: v.literal("not_found") }),
  /** 400 и прочее: OLX отклонил запрос или данные. reason — заголовок ошибки OLX (английский), только для подбора текста. */
  v.object({ kind: v.literal("rejected"), status: v.number(), field: v.optional(v.string()), reason: v.optional(v.string()) }),
  // Ниже — состояния без ответа OLX.
  /** OLX не настроен или не подключён. */
  v.object({ kind: v.literal("not_connected") }),
  /** Доступ потерян — нужно подключить заново (уже отмечено, владелец уведомлён). */
  v.object({ kind: v.literal("reauth") }),
  /** Пауза после блокировки или сбоев OLX: до until запросы не отправляем. */
  v.object({ kind: v.literal("paused"), until: v.string() }),
  /** Исчерпан бюджет запросов или времени прохода — продолжим на следующем. */
  v.object({ kind: v.literal("budget") }),
);
export type OlxFailure = Infer<typeof vOlxFailure>;

function retryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const sec = Number(h.trim());
  if (Number.isFinite(sec) && sec >= 0) return Math.min(sec, 3600);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.min(3600, Math.round((at - Date.now()) / 1000))) : undefined;
}

/** Ошибка API: {"error":{…}} или в конверте {"data":{"error":{…}}}; validation[0] — поле и его ошибка. */
function apiError(body: unknown): { field?: string; reason?: string } {
  const box = isRecord(body) && isRecord(body.data) && isRecord(body.data.error) ? body.data.error : isRecord(body) && isRecord(body.error) ? body.error : undefined;
  if (!box) return { reason: isRecord(body) ? str(body.error_description)?.slice(0, 200) : undefined };
  const first = Array.isArray(box.validation) ? box.validation.find(isRecord) : undefined;
  return { field: str(first?.field)?.slice(0, 60), reason: (str(first?.title) ?? str(box.detail) ?? str(box.title) ?? str(box.message))?.slice(0, 200) };
}

/** Неуспешный ответ OLX → вид ошибки. Порядок разбора: тело как JSON; не JSON — HTML CloudFront или прокси. */
export function classifyFailure(status: number, raw: string, header: (name: string) => string | null): OlxFailure {
  const body = parseJson(raw);
  if (status === 0 || status >= 500) return { kind: "server", status };
  if (status === 429) return { kind: "throttled", retryAfterSec: retryAfter(header("retry-after")) };
  if (status === 403 && body === undefined) {
    const requestId = header("x-amz-cf-id") ?? /Request ID:\s*([A-Za-z0-9_=-]{8,120})/.exec(raw)?.[1];
    return { kind: "blocked", requestId: requestId?.slice(0, 120) };
  }
  const oauth = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
  if (oauth === "invalid_grant") return { kind: "grant" };
  if (oauth === "invalid_client" || oauth === "unauthorized_client" || oauth === "invalid_scope") return { kind: "client" };
  if (status === 401) return { kind: "unauthorized" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "not_found" };
  return { kind: "rejected", status, ...apiError(body) };
}

/** Сбой канала целиком (а не одного треда): прерывает проход синхронизации. */
export const isSystemic = (f: OlxFailure): boolean => f.kind !== "not_found" && f.kind !== "forbidden" && f.kind !== "rejected";

/** После этих ошибок запросы к OLX ставим на паузу — повтор только продлит блокировку. */
export const isPausing = (f: OlxFailure): boolean => f.kind === "blocked" || f.kind === "throttled" || f.kind === "client";

const MIN = 60_000;

/** Пауза после ошибки: блок CloudFront — 30 минут, 429 — Retry-After, иначе 1 → 2 → 4 → 8 → 15 минут. */
export function backoffMs(f: OlxFailure, step: number): number {
  if (f.kind === "blocked") return 30 * MIN;
  if (f.kind === "client") return 15 * MIN;
  if (f.kind === "throttled" && f.retryAfterSec !== undefined) return Math.min(15 * MIN, Math.max(MIN, f.retryAfterSec * 1000));
  return Math.min(15 * MIN, MIN * 2 ** Math.min(Math.max(step, 0), 4));
}

/** Текст для владельца (карточка OLX, мониторинг). */
export function failureText(f: OlxFailure): string {
  switch (f.kind) {
    case "blocked":
      return `OLX временно заблокировал запросы (защита CloudFront) — пауза 30 минут${f.requestId ? `. Request ID для поддержки OLX: ${f.requestId}` : ""}`;
    case "throttled":
      return "OLX просит реже присылать запросы — синхронизация на паузе";
    case "server":
      return f.timeout ? "OLX не ответил вовремя — повторим через минуту" : f.status ? `OLX временно недоступен (HTTP ${f.status}) — повторим позже` : "Нет связи с OLX — повторим позже";
    case "client":
      return "OLX не принял ключи приложения — проверьте OLX_CLIENT_ID, OLX_CLIENT_SECRET и статус приложения на developer.olx.kz";
    case "unauthorized":
    case "grant":
    case "reauth":
      return OLX_REAUTH_TEXT;
    case "forbidden":
      return "OLX запретил это действие для подключённого аккаунта";
    case "not_found":
      return "Не найдено на OLX — возможно, диалог или объявление удалены";
    case "rejected":
      return `OLX отклонил запрос (HTTP ${f.status})`;
    case "not_connected":
      return "OLX не подключён";
    case "paused":
      return "OLX временно ограничил запросы — повторим автоматически";
    case "budget":
      return "Лимит запросов к OLX на один проход исчерпан — продолжим на следующем";
  }
}

/** Текст для оператора: почему ответ не ушёл. */
export function sendErrorText(f: OlxFailure): string {
  switch (f.kind) {
    case "rejected":
      if (/blank|empty/i.test(f.reason ?? "")) return "OLX не принимает пустое сообщение";
      if (/long|length|characters|maximum/i.test(f.reason ?? "")) return "Слишком длинное сообщение для OLX — сократите текст";
      return "OLX не принял сообщение — проверьте текст (OLX может отклонять ссылки и номера телефонов) и попробуйте ещё раз";
    case "not_found":
      return "Диалог на OLX не найден — возможно, покупатель его удалил";
    case "forbidden":
      return "OLX не разрешает писать в этот диалог";
    case "server":
      return f.timeout ? "OLX не ответил вовремя — проверьте диалог на OLX, прежде чем повторять" : "OLX временно недоступен — попробуйте ещё раз через минуту";
    case "blocked":
    case "throttled":
    case "paused":
      return "OLX временно ограничил запросы — повторите через несколько минут";
    default:
      return failureText(f);
  }
}

/** Короткий код причины для адреса возврата после подключения (/settings?olx=error&reason=…): ни токенов, ни тел ответов. */
export type OlxReturnReason = "state" | "expired" | "denied" | "code" | "exchange" | "client" | "scope" | "account" | "blocked" | "config";

export function returnReason(f: OlxFailure, step: "exchange" | "account"): OlxReturnReason {
  if (f.kind === "grant") return "code";
  if (f.kind === "client") return "client";
  if (f.kind === "blocked" || f.kind === "throttled") return "blocked";
  return step;
}

// ── Постраничный обход ──

/**
 * offset/limit: offset растёт на число полученных записей (OLX может урезать limit). Конец — пустая страница или
 * expected записей; та же первая запись, что на прошлой странице, — OLX игнорирует offset, дальше не идём.
 */
export async function collectPages<T>(
  page: (offset: number) => Promise<unknown[]>,
  parse: (x: unknown) => T | null,
  keyOf: (t: T) => string,
  opts: { maxPages: number; expected?: number },
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let prevFirst: string | undefined;
  for (let p = 0; p < opts.maxPages; p++) {
    const raw = await page(offset);
    if (!raw.length) break;
    const parsed = raw.map(parse).filter((x): x is T => x !== null);
    const first = parsed[0] ? keyOf(parsed[0]) : undefined;
    if (p > 0 && first !== undefined && first === prevFirst) break;
    prevFirst = first;
    for (const it of parsed) {
      const k = keyOf(it);
      if (seen.has(k)) continue;
      seen.add(k);
      items.push(it);
    }
    offset += raw.length;
    if (opts.expected !== undefined && items.length >= opts.expected) break;
  }
  return items;
}

// ── Курсор синхронизации (integrations.cursor) ──

/**
 * ready — первая загрузка после подключения закончена: дальше всё новое — «живое».
 * skip — треды без диалога в «Сообщениях» (начатые нами как покупателем, пустые, удалённые): uuid → total_count,
 * чтобы не спрашивать OLX о них каждую минуту.
 */
export interface OlxCursor {
  ready: boolean;
  skip: Record<string, number>;
}

const MAX_SKIP = 500;

export function readCursor(raw: string | undefined): OlxCursor {
  const parsed = raw ? parseJson(raw) : undefined;
  const skip: Record<string, number> = {};
  if (isRecord(parsed) && isRecord(parsed.skip)) {
    for (const [k, n] of Object.entries(parsed.skip)) {
      const total = int(n);
      if (KEY.test(k) && total !== undefined) skip[k] = total;
    }
  }
  return { ready: isRecord(parsed) && parsed.ready === true, skip };
}

export function writeCursor(c: OlxCursor): string {
  return JSON.stringify({ ready: c.ready, skip: Object.fromEntries(Object.entries(c.skip).slice(-MAX_SKIP)) });
}

/** Снимок треда, сохранённый у нас (conversations.meta.olx), — для сравнения со списком OLX. */
export interface OlxSnapshot {
  key: string;
  total?: number;
  unread?: number;
  /** Имя собеседника уже есть (или OLX его не отдаёт) — users/{id} не спрашиваем. */
  named: boolean;
  /** Объявление уже есть (или недоступно) — adverts/{id} не спрашиваем. */
  advert: boolean;
}

/** Тред изменился: новый, другое число сообщений (модерация может и удалять) или прибавились непрочитанные. */
export function threadChanged(t: OlxThread, snap: OlxSnapshot | undefined, skipped: number | undefined): boolean {
  if (snap) return snap.total === undefined || t.total !== snap.total || t.unread > (snap.unread ?? 0);
  if (t.total === 0) return false;
  return skipped === undefined || skipped !== t.total;
}
