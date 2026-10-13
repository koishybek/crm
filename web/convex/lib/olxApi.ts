// OLX.kz Partner API: настройки из окружения, HTTP-запросы с токеном, ответ клиенту и отметка «прочитано».
// Токен обновляем за 5 минут до конца и после 401 — один раз и «одним потоком» (аренда в базе): OLX меняет
// refresh-токен, и два параллельных обновления не должны сжечь друг другу доступ. Токены читают и пишут только
// внутренние функции channels/olx.ts; в логи, ответы и адреса они не попадают. В базе токены зашифрованы
// (lib/secretBox.ts): расшифровываем здесь, внутри actions, перед самим запросом к OLX.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { env } from "../env";
import { REPLY_BLOCK } from "./chat";
import {
  asAccount,
  asMessage,
  asToken,
  classifyFailure,
  collectPages,
  isPausing,
  isSystemic,
  listOf,
  OLX_API,
  OLX_MAX_TEXT,
  OLX_REAUTH_TEXT,
  OLX_TOKEN_URL,
  parseJson,
  sameText,
  sendErrorText,
  sortMessages,
  timeOffset,
  unwrap,
  type OlxAccount,
  type OlxFailure,
  type OlxToken,
} from "./olx";
import { hitLimit } from "./rateLimit";
import { integrationsKeyIssue, openSecret, sealSecret, SecretBoxError, type SecretPurpose } from "./secretBox";

/** Адрес возврата после входа в OLX — он же зарегистрирован в приложении на developer.olx.kz. */
export const OLX_CALLBACK_PATH = "/olx/callback";
const REQUIRED = ["OLX_CLIENT_ID", "OLX_CLIENT_SECRET"] as const;
const TIMEOUT_MS = 20_000;
/** access-токен OLX живёт сутки — обновляем заранее, за 5 минут до конца. */
export const REFRESH_BEFORE_MS = 5 * 60_000;
/** Сколько раз по секунде ждать, пока токен обновляет другой процесс (cron, отправка ответа). */
const LEASE_WAITS = 3;

export interface OlxConfig {
  clientId: string;
  clientSecret: string;
  /** ${CONVEX_SITE_URL}/olx/callback. */
  redirectUri: string;
  userAgent: string;
  /** Пояс дат OLX, записанных без зоны. */
  offset: string;
}

const siteUrl = (): string | undefined => env("CONVEX_SITE_URL")?.replace(/\/+$/, "");

export function olxCallbackUrl(): string | null {
  const site = siteUrl();
  return site ? `${site}${OLX_CALLBACK_PATH}` : null;
}

/** Каких переменных окружения не хватает — имена, без значений. */
export function olxMissingEnv(): string[] {
  return [...REQUIRED.filter((k) => !env(k)), ...(siteUrl() ? [] : ["CONVEX_SITE_URL"])];
}

export function olxConfig(): OlxConfig | null {
  const clientId = env("OLX_CLIENT_ID");
  const clientSecret = env("OLX_CLIENT_SECRET");
  const redirectUri = olxCallbackUrl();
  if (!clientId || !clientSecret || !redirectUri) return null;
  // Свой постоянный User-Agent: на некоторые стандартные (python-httpx и т.п.) CloudFront OLX отвечает 403.
  const home = env("APP_URL")?.replace(/\/+$/, "") ?? siteUrl();
  return { clientId, clientSecret, redirectUri, userAgent: `HomeMaxService/1.0 (+${home})`, offset: timeOffset(env("OLX_TIME_OFFSET")) };
}

export function olxIntegration(ctx: QueryCtx): Promise<Doc<"integrations"> | null> {
  return ctx.db
    .query("integrations")
    .withIndex("by_provider", (q) => q.eq("provider", "olx"))
    .first();
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

export class OlxError extends Error {
  constructor(readonly failure: OlxFailure) {
    super(`OLX: ${failure.kind}`);
    this.name = "OlxError";
  }
}

/** Ошибка запроса к OLX; любая другая (сбой рантайма) — как обрыв связи. */
export const failureOf = (e: unknown): OlxFailure => (e instanceof OlxError ? e.failure : { kind: "server", status: 0 });

interface Raw {
  status: number;
  body: string;
  header: (name: string) => string | null;
  timeout?: boolean;
}

async function request(cfg: OlxConfig, method: "GET" | "POST", url: string, o: { token?: string; json?: Record<string, unknown>; version: boolean }): Promise<Raw> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": cfg.userAgent };
  if (o.version) headers.Version = "2.0";
  if (o.token) headers.Authorization = `Bearer ${o.token}`;
  // Content-Type — только с телом: на GET с ним OLX отвечает 400.
  if (o.json) headers["Content-Type"] = "application/json";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { method, headers, body: o.json ? JSON.stringify(o.json) : undefined, signal: ctrl.signal });
    return { status: res.status, body: await res.text(), header: (name) => res.headers.get(name) };
  } catch (e) {
    return { status: 0, body: "", header: () => null, timeout: e instanceof Error && e.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
}

/** Успех → разобранное тело (204 → null); ошибка → OlxError. Тела ошибок в логи не пишем: в них бывают данные покупателя. */
function bodyOf(r: Raw): unknown {
  if (r.status >= 200 && r.status < 300) return r.body ? (parseJson(r.body) ?? null) : null;
  throw new OlxError(r.status === 0 ? { kind: "server", status: 0, timeout: r.timeout } : classifyFailure(r.status, r.body, r.header));
}

/** POST /oauth/token: JSON-тело с client_id и client_secret, как в документации; заголовок Version здесь не нужен. */
async function tokenRequest(cfg: OlxConfig, grantType: "authorization_code" | "refresh_token", fields: Record<string, string>): Promise<OlxToken> {
  const r = await request(cfg, "POST", OLX_TOKEN_URL, { json: { grant_type: grantType, client_id: cfg.clientId, client_secret: cfg.clientSecret, ...fields }, version: false });
  const token = asToken(bodyOf(r));
  if (!token) throw new OlxError({ kind: "rejected", status: r.status });
  return token;
}

/** Код из callback → токены. redirect_uri — тот же, что в адресе авторизации (обязателен: адресов в OLX два). */
export function exchangeCode(cfg: OlxConfig, code: string): Promise<OlxToken> {
  return tokenRequest(cfg, "authorization_code", { code, scope: "v2 read write", redirect_uri: cfg.redirectUri });
}

/** GET /users/me — какой аккаунт подключили. */
export async function fetchAccount(cfg: OlxConfig, token: string): Promise<OlxAccount> {
  const account = asAccount(bodyOf(await request(cfg, "GET", `${OLX_API}/users/me`, { token, version: true })));
  if (!account) throw new OlxError({ kind: "rejected", status: 200 });
  return account;
}

// ── Токен ────────────────────────────────────────────────────────────────────

/** Ответ аренды токена (channels/olx.ts → _tokenLease). */
export type TokenLease =
  | { kind: "ready"; accessToken: string; expiresAt: string }
  /** Обновлять нам: аренда взята. expiresAt — срок токена на момент аренды (по нему видно, что его успел обновить другой). */
  | { kind: "refresh"; refreshToken: string; expiresAt?: string }
  | { kind: "busy" }
  | { kind: "paused"; until: string }
  | { kind: "none" };

interface Token {
  value: string;
  expiresAt: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Токен из базы → открытый текст. Ключа нет — OLX «не подключён» (токены целы и заработают, когда ключ зададут);
 * токен не открывается ключом (ключ сменили) — доступ потерян: стираем и просим владельца подключить заново.
 */
async function openToken(ctx: ActionCtx, stored: string, purpose: SecretPurpose): Promise<string> {
  try {
    return (await openSecret(stored, purpose)).value;
  } catch (e) {
    const reason = e instanceof SecretBoxError ? e.reason : "open";
    console.warn(`olx: токен не расшифрован (${reason})`);
    if (reason === "key") throw new OlxError({ kind: "not_connected" });
    await ctx.runMutation(internal.channels.olx._undecryptable, {});
    throw new OlxError({ kind: "reauth" });
  }
}

/** Действующий access-токен. stale — срок токена, который OLX только что не принял (401): обновить, даже если срок не вышел. */
async function validToken(ctx: ActionCtx, cfg: OlxConfig, stale?: string): Promise<Token> {
  // Без ключа шифрования обновлённый токен не сохранить — к OLX не обращаемся вовсе (даже со старым открытым токеном).
  if (integrationsKeyIssue()) throw new OlxError({ kind: "not_connected" });
  for (let i = 0; i <= LEASE_WAITS; i++) {
    const lease: TokenLease = await ctx.runMutation(internal.channels.olx._tokenLease, { staleExpiresAt: stale });
    if (lease.kind === "ready") return { value: await openToken(ctx, lease.accessToken, "olx.accessToken"), expiresAt: lease.expiresAt };
    if (lease.kind === "refresh") return refresh(ctx, cfg, await openToken(ctx, lease.refreshToken, "olx.refreshToken"), lease.expiresAt);
    if (lease.kind === "paused") throw new OlxError({ kind: "paused", until: lease.until });
    if (lease.kind === "none") throw new OlxError({ kind: "not_connected" });
    // Токен прямо сейчас обновляет другой процесс — ждём его результата.
    if (i < LEASE_WAITS) await sleep(1000);
  }
  throw new OlxError({ kind: "server", status: 0 });
}

async function refresh(ctx: ActionCtx, cfg: OlxConfig, refreshToken: string, leasedExpiresAt: string | undefined): Promise<Token> {
  const startedAt = Date.now();
  let t: OlxToken;
  try {
    t = await tokenRequest(cfg, "refresh_token", { refresh_token: refreshToken });
  } catch (e) {
    const failure = failureOf(e);
    console.warn(`olx: токен не обновлён (${failure.kind})`);
    await ctx.runMutation(internal.channels.olx._tokenRefreshFailed, { failure, leasedExpiresAt });
    throw new OlxError(failure.kind === "grant" ? { kind: "reauth" } : failure);
  }
  // expires_in — секунды от момента запроса; refresh-токен OLX меняет раз в сутки — пришёл новый, храним новый,
  // иначе прежний — тоже заново зашифрованным (сохранённый до шифрования открытый текст так и заменяется).
  const expiresAt = new Date(startedAt + t.expiresIn * 1000).toISOString();
  await ctx.runMutation(internal.channels.olx._tokenRefreshed, {
    accessToken: await sealSecret(t.accessToken, "olx.accessToken"),
    refreshToken: await sealSecret(t.refreshToken ?? refreshToken, "olx.refreshToken"),
    expiresAt,
  });
  return { value: t.accessToken, expiresAt };
}

// ── Сессия запросов ──────────────────────────────────────────────────────────

export interface OlxSession {
  get(path: string, query?: Record<string, string | number>): Promise<unknown>;
  post(path: string, body: Record<string, unknown>): Promise<unknown>;
}

/**
 * Запросы к API от имени подключённого аккаунта. budget и until — потолок запросов и времени: лимит OLX —
 * 4500 запросов за 5 минут с IP, превышение блокирует на 30 минут. 401 → одно обновление токена и повтор;
 * снова 401 — доступ потерян, владельцу нужно подключить OLX заново.
 */
export function olxSession(ctx: ActionCtx, cfg: OlxConfig, limits: { budget: number; until: number }): OlxSession {
  let token: Token | null = null;
  let refreshed = false;
  let used = 0;

  async function once(method: "GET" | "POST", url: string, json: Record<string, unknown> | undefined, t: Token): Promise<Raw> {
    if (used >= limits.budget || Date.now() > limits.until) throw new OlxError({ kind: "budget" });
    used++;
    return request(cfg, method, url, { token: t.value, json, version: true });
  }

  async function call(method: "GET" | "POST", path: string, json?: Record<string, unknown>): Promise<unknown> {
    const url = `${OLX_API}${path}`;
    let t = token ?? (token = await validToken(ctx, cfg));
    let r = await once(method, url, json, t);
    if (r.status === 401) {
      if (!refreshed) {
        refreshed = true;
        t = token = await validToken(ctx, cfg, t.expiresAt);
        r = await once(method, url, json, t);
      }
      if (r.status === 401) {
        await ctx.runMutation(internal.channels.olx._lost, {});
        throw new OlxError({ kind: "reauth" });
      }
    }
    return bodyOf(r);
  }

  const qs = (q?: Record<string, string | number>): string => (q ? `?${new URLSearchParams(Object.entries(q).map(([k, val]): [string, string] => [k, String(val)])).toString()}` : "");
  return { get: (path, query) => call("GET", `${path}${qs(query)}`), post: (path, body) => call("POST", path, body) };
}

// ── Ответ оператора (lib/outbound.ts) ────────────────────────────────────────

export type OlxSendResult = { ok: true; id?: string } | { ok: false; error: string; systemic: boolean };

/** Наше только что отправленное сообщение: самое новое «sent» с тем же текстом, которого ещё нет в базе. */
async function ownSent(ctx: ActionCtx, session: OlxSession, path: string, text: string, offset: string): Promise<string | undefined> {
  try {
    const list = await collectPages(
      async (o) => listOf(await session.get(path, { offset: o, limit: 100 })) ?? [],
      (x) => asMessage(x, undefined, offset),
      (m) => m.key,
      { maxPages: 5 },
    );
    const same = sortMessages(list)
      .filter((m) => m.type === "sent" && sameText(m.text, text))
      .map((m) => m.key);
    if (!same.length) return undefined;
    const unknown = new Set(await ctx.runQuery(internal.channels.olx._unknownKeys, { keys: same }));
    return same.reverse().find((k) => unknown.has(k));
  } catch {
    return undefined;
  }
}

/**
 * Ответ в тред OLX. Новый тред API создать не даёт — пишем только в существующий (диалог в «Сообщениях» = тред).
 * id сообщения — из ответа OLX; если в ответе его нет (формат не подтверждён), — из треда.
 */
export async function sendOlx(ctx: ActionCtx, threadKey: string, text: string): Promise<OlxSendResult> {
  const cfg = olxConfig();
  if (!cfg) return { ok: false, error: REPLY_BLOCK.notConnected, systemic: true };
  if (text.length > OLX_MAX_TEXT) return { ok: false, error: `Слишком длинное сообщение для OLX — не больше ${OLX_MAX_TEXT} символов`, systemic: false };
  const session = olxSession(ctx, cfg, { budget: 8, until: Date.now() + 2 * 60_000 });
  const path = `/threads/${encodeURIComponent(threadKey)}/messages`;
  try {
    const sent = asMessage(unwrap(await session.post(path, { text })), undefined, cfg.offset);
    return { ok: true, id: sent?.key ?? (await ownSent(ctx, session, path, text, cfg.offset)) };
  } catch (e) {
    const f = failureOf(e);
    // Таймаут или 5xx: OLX мог принять сообщение — сначала смотрим тред, повтор вслепую дал бы клиенту дубль.
    const id = f.kind === "server" ? await ownSent(ctx, session, path, text, cfg.offset) : undefined;
    if (id) return { ok: true, id };
    console.warn(`olx: ответ не отправлен (${f.kind})`);
    if (isPausing(f)) await ctx.runMutation(internal.channels.olx._failed, { failure: f });
    return { ok: false, error: sendErrorText(f), systemic: isSystemic(f) };
  }
}

/** Можно ли отвечать в OLX (без запросов к OLX: зовётся и из запросов интерфейса). */
export async function olxReplyBlock(ctx: QueryCtx): Promise<string | null> {
  // Без ключа шифрования токен не открыть — ответ не уйдёт; подробности владелец видит в карточке OLX.
  if (!olxConfig() || integrationsKeyIssue()) return REPLY_BLOCK.notConnected;
  const row = await olxIntegration(ctx);
  if (row?.status === "connected") return null;
  return row?.status === "error" ? OLX_REAUTH_TEXT : REPLY_BLOCK.notConnected;
}

/**
 * Оператор открыл диалог с непрочитанными — отметить тред прочитанным и на OLX (команда mark-as-read).
 * Фоном и без гарантий; не чаще раза в минуту на тред и 30 раз в минуту всего.
 */
export async function scheduleOlxRead(ctx: MutationCtx, conversationId: Id<"conversations">): Promise<void> {
  if (!olxConfig() || (await olxIntegration(ctx))?.status !== "connected") return;
  if (!(await hitLimit(ctx, `olx:read:${conversationId}`, 1, 60_000)) || !(await hitLimit(ctx, "olx:read", 30, 60_000))) return;
  await ctx.scheduler.runAfter(0, internal.channels.olx.markThreadRead, { conversationId });
}
