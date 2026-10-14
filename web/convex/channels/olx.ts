// OLX.kz — канал единого чата «Сообщения» через Partner API (developer.olx.kz).
// Подключение — владелец через OAuth: connectUrl → страница OLX → GET /olx/callback (маршрут в http.ts) → токены
// в integrations. Push-уведомлений у OLX нет: cron раз в минуту проходит все треды и забирает сообщения тех, у которых
// изменились счётчики (total_count, unread_count). Сообщения ложатся через inbox (дубли отсекаются по uuid), ответ
// оператора уходит через lib/outbound.ts → sendOlx. Телефон покупателя OLX не отдаёт: заявка создаётся сама, только
// если клиент написал номер в тексте; иначе оператор создаёт её из чата.
import { ConvexError, v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { httpAction, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "../lib/functions";
import { env } from "../env";
import { externalKey, ingestMessage } from "../inbox";
import { OWNER, requireRole } from "../lib/access";
import { audit } from "../lib/audit";
import { PLACEHOLDER } from "../lib/chat";
import { randomToken } from "../lib/crypto";
import { notify, nowIso } from "../lib/domain";
import { markError, markOk } from "../lib/health";
import {
  accountLabel,
  asAdvert,
  asMessage,
  asThread,
  asUserName,
  authorizeUrl,
  backoffMs,
  collectPages,
  failureText,
  hasScopes,
  isOlxCdn,
  isPausing,
  isRecord,
  isSystemic,
  listOf,
  messageText,
  OLX_REAUTH_TEXT,
  readCursor,
  returnReason,
  sameText,
  sortMessages,
  threadChanged,
  vOlxFailure,
  vOlxMessage,
  vOlxThread,
  writeCursor,
  type OlxAccount,
  type OlxAdvert,
  type OlxAttachment,
  type OlxCursor,
  type OlxFailure,
  type OlxMessage,
  type OlxReturnReason,
  type OlxSnapshot,
  type OlxThread,
  type OlxToken,
} from "../lib/olx";
import {
  exchangeCode,
  failureOf,
  fetchAccount,
  OlxError,
  olxCallbackUrl,
  olxConfig,
  olxIntegration,
  olxMissingEnv,
  olxSession,
  REFRESH_BEFORE_MS,
  type OlxConfig,
  type OlxSession,
  type TokenLease,
} from "../lib/olxApi";
import { hitLimit } from "../lib/rateLimit";
import { actionHasModule, perTenantAction, requireModule } from "../lib/tenant";
import { bindTenant, tenantOfDoc, unscopedDb } from "../lib/tenantDb";
import { integrationsKeyIssue, isSealed, sealSecret } from "../lib/secretBox";
import { safeFileName, storageMime } from "../lib/whatsapp";
import type { OlxSettings } from "../../src/data/types";

/** state подключения живёт 10 минут — столько же, сколько код авторизации OLX. */
const STATE_TTL_MS = 10 * 60_000;
/** Проход синхронизации: не больше 120 запросов и 4 минут. При cron раз в минуту это ≤ 600 запросов за 5 минут (лимит OLX — 4500 с IP). */
const RUN_BUDGET = 120;
const RUN_TIME_MS = 4 * 60_000;
const SYNC_LEASE_MS = 5 * 60_000;
const REFRESH_LEASE_MS = 30_000;
const THREADS_PAGE = 50;
const THREAD_PAGES = 40;
const MESSAGES_PAGE = 100;
const MESSAGE_PAGES = 20;
/** Сообщений одного треда за раз: давняя история длинной переписки в ленте не нужна. */
const THREAD_MESSAGES = 300;
/** Сообщения, пришедшие за 10 минут до подключения, ещё «живые» — с уведомлением и авто-заявкой. */
const LIVE_BEFORE_CONNECT_MS = 10 * 60_000;
/** Фото и файлы покупателей, которые сохраняем у себя за проход; остальные остаются ссылкой. */
const DOWNLOADS_PER_RUN = 10;
const FILE_MAX_BYTES = 10 * 1024 * 1024;
const FILE_TIMEOUT_MS = 30_000;

// ── Состояние интеграции ─────────────────────────────────────────────────────

const byThread = (ctx: QueryCtx, key: string): Promise<Doc<"conversations"> | null> =>
  ctx.db
    .query("conversations")
    .withIndex("by_channel_external", (q) => q.eq("channel", "olx").eq("externalId", key))
    .first();

async function seenMessage(ctx: QueryCtx, key: string): Promise<boolean> {
  return !!(await ctx.db
    .query("conversationMessages")
    .withIndex("by_external", (q) => q.eq("externalId", externalKey("olx", key)))
    .first());
}

/** Снимок треда в conversations.meta.olx: счётчики OLX и отметки «имени / объявления у OLX нет». */
function olxMeta(meta: unknown): { total?: number; unread?: number; name?: string; advert?: string } {
  const o = isRecord(meta) && isRecord(meta.olx) ? meta.olx : {};
  const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const s = (x: unknown) => (typeof x === "string" ? x : undefined);
  return { total: n(o.total), unread: n(o.unread), name: s(o.name), advert: s(o.advert) };
}

/** Пауза запросов к OLX после блокировки, 429 или сбоев: повтор раньше только продлит блокировку. */
async function pauseFor(ctx: MutationCtx, row: Doc<"integrations">, f: OlxFailure): Promise<void> {
  const step = row.backoffStep ?? 0;
  const text = failureText(f);
  await ctx.db.patch(row._id, { backoffUntil: new Date(Date.now() + backoffMs(f, step)).toISOString(), backoffStep: step + 1, lastError: text });
  await markError(ctx, "olx", text);
}

/** Токены не расшифровываются ключом INTEGRATIONS_KEY: его сменили (или данные испорчены) — токены бесполезны. */
const KEY_CHANGED_TEXT = "Токены OLX не расшифровываются: ключ шифрования INTEGRATIONS_KEY сменили — подключите OLX заново";

/**
 * Доступ к OLX потерян (refresh-токен протух или отозван, либо токены не расшифровываются): стоп опросу, токены стираем,
 * владельцам — одно уведомление. why — причина для карточки и мониторинга, по умолчанию «Нужно заново подключить OLX».
 */
async function markLost(ctx: MutationCtx, row: Doc<"integrations">, why?: string): Promise<void> {
  if (row.status !== "connected") return; // уже отмечено или отключено — второй раз не пишем
  const text = why ?? OLX_REAUTH_TEXT;
  await ctx.db.patch(row._id, {
    status: "error",
    lastError: text,
    accessToken: undefined,
    refreshToken: undefined,
    expiresAt: undefined,
    refreshLeaseUntil: undefined,
    syncLeaseUntil: undefined,
  });
  await markError(ctx, "olx", text, { ownerNotified: true });
  const owners = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .collect();
  await notify(
    ctx,
    owners.filter((u) => u.active !== false).map((u) => u._id),
    `OLX отключился: ${why ? "токены доступа не расшифровываются (сменился ключ шифрования)" : "доступ истёк или отозван"}. Подключите OLX заново в настройках — до этого новые сообщения с OLX не приходят.`,
    { link: "/settings", tone: "bad", email: { kind: "channel_lost" } },
  );
  await audit(ctx, "OLX", "integration.expired", `Доступ к OLX${row.accountName ? ` (${row.accountName})` : ""} ${why ? "потерян: токены не расшифровываются ключом INTEGRATIONS_KEY" : "истёк или отозван"} — нужно подключить заново`, {
    meta: { provider: "olx", accountId: row.accountId },
  });
}

/** Перед записью токенов: только зашифрованные (секреты в базе — никогда открытым текстом, аудит E28). */
function assertSealed(...tokens: (string | undefined)[]): void {
  if (tokens.some((t) => t !== undefined && !isSealed(t))) throw new ConvexError("Токены OLX не зашифрованы — сохранение отменено");
}

// ── Карточка владельца ───────────────────────────────────────────────────────

/** Что настроено и как идёт синхронизация. Токены не отдаём никогда — только состояние. */
export const settings = query({
  args: {},
  handler: async (ctx): Promise<OlxSettings> => {
    await requireRole(ctx, OWNER);
    const row = await olxIntegration(ctx);
    const by = row?.connectedBy ? await ctx.db.get(row.connectedBy) : null;
    return {
      configured: olxConfig() !== null,
      missing: olxMissingEnv(),
      keyIssue: integrationsKeyIssue() ?? undefined,
      callbackUrl: olxCallbackUrl(),
      status: row?.status ?? "disconnected",
      accountId: row?.accountId,
      accountName: row?.accountName,
      connectedAt: row?.connectedAt,
      connectedBy: by?.name,
      lastSyncAt: row?.lastSyncAt,
      lastError: row?.lastError,
      pausedUntil: row?.backoffUntil && Date.parse(row.backoffUntil) > Date.now() ? row.backoffUntil : undefined,
    };
  },
});

async function dropExpiredStates(ctx: MutationCtx): Promise<void> {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const s of await ctx.db.query("oauthStates").take(200)) {
    if (s.provider === "olx" && Date.parse(s.createdAt) < cutoff) await ctx.db.delete(s._id);
  }
}

/** Адрес страницы входа OLX. state — одноразовый и неугадываемый: callback примет только его, 10 минут. */
export const connectUrl = mutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const me = await requireRole(ctx, OWNER);
    await requireModule(ctx, me.tenantId, "olx");
    const cfg = olxConfig();
    if (!cfg) throw new ConvexError("OLX ещё не настроен: на сервере нет ключей приложения (OLX_CLIENT_ID и OLX_CLIENT_SECRET)");
    // Токены OLX храним только зашифрованными: без ключа подключение бессмысленно — говорим об этом до страницы OLX.
    const keyIssue = integrationsKeyIssue();
    if (keyIssue) throw new ConvexError(`Подключить OLX пока нельзя. ${keyIssue}`);
    if (!(await hitLimit(ctx, `olx:connect:${me._id}`, 10, STATE_TTL_MS))) throw new ConvexError("Слишком много попыток подключения — подождите 10 минут");
    await dropExpiredStates(ctx);
    const state = randomToken(32);
    await ctx.db.insert("oauthStates", { state, provider: "olx", userId: me._id, createdAt: nowIso() });
    return authorizeUrl({ clientId: cfg.clientId, redirectUri: cfg.redirectUri, state });
  },
});

/** «Синхронизировать сейчас»: тот же проход, что у cron, — не чаще раза в минуту и не во время паузы OLX. */
export const syncNow = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const row = await olxIntegration(ctx);
    if (!olxConfig() || !row || row.status !== "connected") throw new ConvexError("OLX не подключён");
    if (row.backoffUntil && Date.parse(row.backoffUntil) > Date.now()) throw new ConvexError("OLX временно ограничил запросы — синхронизация продолжится сама, когда пауза закончится");
    if (!(await hitLimit(ctx, `olx:syncNow:${me.tenantId}`, 1, 60_000))) throw new ConvexError("Синхронизация уже запущена — подождите минуту");
    await ctx.scheduler.runAfter(0, internal.channels.olx.sync, {});
  },
});

/** Отключить: токены стираем. Отозвать доступ и на стороне OLX можно в настройках аккаунта OLX. */
export const disconnect = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const row = await olxIntegration(ctx);
    if (!row || row.status === "disconnected") return;
    await ctx.db.patch(row._id, {
      status: "disconnected",
      accessToken: undefined,
      refreshToken: undefined,
      expiresAt: undefined,
      lastError: undefined,
      backoffUntil: undefined,
      backoffStep: undefined,
      syncLeaseUntil: undefined,
      refreshLeaseUntil: undefined,
    });
    await audit(ctx, me, "integration.disconnected", `OLX отключён${row.accountName ? `: ${row.accountName}` : ""}`, { meta: { provider: "olx", accountId: row.accountId } });
  },
});

// ── Подключение: callback OAuth (маршрут — в http.ts) ────────────────────────

/** Проверить и погасить state: неизвестный, просроченный или уже использованный — отказ. */
export const _takeState = internalMutation({
  args: { state: v.string() },
  handler: async (ctx, { state }): Promise<{ ok: true; userId: Id<"users"> } | { ok: false; reason: "state" | "expired" }> => {
    // Адрес открыт всем — перебор state ограничиваем.
    if (!state || !(await hitLimit(ctx, "olx:callback", 30, 60_000))) return { ok: false, reason: "state" };
    // Вход без пользователя: state ищем среди всех компаний и дальше работаем в компании, которая его выдала.
    const row = await unscopedDb(ctx)
      .query("oauthStates")
      .withIndex("by_state", (q) => q.eq("state", state))
      .first();
    if (!row || row.provider !== "olx") return { ok: false, reason: "state" };
    bindTenant(ctx, tenantOfDoc(row));
    await ctx.db.delete(row._id);
    if (Date.now() - Date.parse(row.createdAt) > STATE_TTL_MS) return { ok: false, reason: "expired" };
    const user = await ctx.db.get(row.userId);
    if (!user || user.active === false || user.role !== "owner") return { ok: false, reason: "state" };
    return { ok: true, userId: row.userId };
  },
});

export const _connect = internalMutation({
  args: { userId: v.id("users"), accessToken: v.string(), refreshToken: v.optional(v.string()), expiresAt: v.string(), accountId: v.string(), accountName: v.string() },
  handler: async (ctx, a): Promise<void> => {
    assertSealed(a.accessToken, a.refreshToken);
    const user = await ctx.db.get(a.userId);
    const row = await olxIntegration(ctx);
    const connectedAt = nowIso();
    const fields = {
      status: "connected" as const,
      accountId: a.accountId,
      accountName: a.accountName,
      accessToken: a.accessToken,
      refreshToken: a.refreshToken,
      expiresAt: a.expiresAt,
      connectedBy: a.userId,
      connectedAt,
    };
    // Курсор с нуля: первая загрузка кладёт историю без уведомлений и авто-заявок.
    if (row) await ctx.db.patch(row._id, { ...fields, cursor: undefined, lastError: undefined, backoffUntil: undefined, backoffStep: undefined, syncLeaseUntil: undefined, refreshLeaseUntil: undefined });
    else await ctx.db.insert("integrations", { provider: "olx", ...fields });
    await markOk(ctx, "olx", `Подключён аккаунт ${a.accountName}`);
    const another = !!row?.accountId && row.accountId !== a.accountId;
    await audit(ctx, user ?? "Система", "integration.connected", `OLX подключён: ${a.accountName}${another ? " (раньше был подключён другой аккаунт)" : ""}`, {
      meta: { provider: "olx", accountId: a.accountId, previousAccountId: another ? row?.accountId : undefined },
    });
    await ctx.scheduler.runAfter(0, internal.channels.olx.sync, {});
  },
});

/** Вернуть браузер владельца в настройки с итогом в адресе: только короткий код — ни токенов, ни текстов ошибок OLX. */
function backToApp(params: { olx: "connected" } | { olx: "error"; reason: OlxReturnReason }): Response {
  const app = env("APP_URL")?.replace(/\/+$/, "");
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (app && /^https?:\/\//i.test(app)) return new Response(null, { status: 302, headers: { ...headers, Location: `${app}/settings?${new URLSearchParams(params).toString()}` } });
  const ok = params.olx === "connected";
  return new Response(ok ? "OLX подключён. Вернитесь в приложение." : "OLX не подключён. Вернитесь в приложение и попробуйте ещё раз.", {
    status: ok ? 200 : 400,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

const fail = (reason: OlxReturnReason): Response => backToApp({ olx: "error", reason });

/** GET /olx/callback?code=…&state=… — OLX возвращает владельца после «Разрешить» (или error при отказе). */
export const olxCallback = httpAction(async (ctx, request) => {
  const q = new URL(request.url).searchParams;
  // Сначала state — без него код не обмениваем.
  const taken = await ctx.runMutation(internal.channels.olx._takeState, { state: (q.get("state") ?? "").slice(0, 200) });
  if (!taken.ok) return fail(taken.reason);
  const cfg = olxConfig();
  if (!cfg) return fail("config");
  if (q.get("error")) return fail("denied");
  // Без ключа шифрования токены сохранить нельзя — код не обмениваем вовсе.
  if (integrationsKeyIssue()) return fail("key");
  const code = q.get("code") ?? "";
  if (!code || code.length > 1000) return fail("code");
  const startedAt = Date.now();
  let token: OlxToken;
  try {
    token = await exchangeCode(cfg, code);
  } catch (e) {
    const f = failureOf(e);
    console.warn(`olx: код подключения не обменян (${f.kind})`);
    return fail(returnReason(f, "exchange"));
  }
  if (!hasScopes(token.scope)) return fail("scope");
  let account: OlxAccount;
  try {
    account = await fetchAccount(cfg, token.accessToken);
  } catch (e) {
    const f = failureOf(e);
    console.warn(`olx: аккаунт не получен (${f.kind})`);
    return fail(returnReason(f, "account"));
  }
  // В базу — только шифртекст: открытые токены живут лишь в памяти этого запроса.
  let sealed: { accessToken: string; refreshToken?: string };
  try {
    sealed = {
      accessToken: await sealSecret(token.accessToken, "olx.accessToken"),
      refreshToken: token.refreshToken === undefined ? undefined : await sealSecret(token.refreshToken, "olx.refreshToken"),
    };
  } catch (e) {
    console.warn(`olx: токены не зашифрованы (${e instanceof Error ? e.name : "ошибка"})`);
    return fail("key");
  }
  await ctx.runMutation(internal.channels.olx._connect, {
    userId: taken.userId,
    ...sealed,
    expiresAt: new Date(startedAt + token.expiresIn * 1000).toISOString(),
    accountId: account.id,
    accountName: accountLabel(account),
  });
  return backToApp({ olx: "connected" });
});

// ── Токен (lib/olxApi.ts) ────────────────────────────────────────────────────

/** Действующий токен — или аренда на обновление: обновляет один процесс, остальные ждут его результата. */
export const _tokenLease = internalMutation({
  args: { staleExpiresAt: v.optional(v.string()) },
  handler: async (ctx, { staleExpiresAt }): Promise<TokenLease> => {
    const row = await olxIntegration(ctx);
    if (!row || row.status !== "connected" || !row.accessToken) return { kind: "none" };
    const now = Date.now();
    if (row.backoffUntil && Date.parse(row.backoffUntil) > now) return { kind: "paused", until: row.backoffUntil };
    // stale — этот токен OLX только что не принял (401); другой срок — его уже обновил другой процесс.
    const rejected = staleExpiresAt !== undefined && staleExpiresAt === row.expiresAt;
    if (!rejected && row.expiresAt && Date.parse(row.expiresAt) - now > REFRESH_BEFORE_MS) return { kind: "ready", accessToken: row.accessToken, expiresAt: row.expiresAt };
    if (!row.refreshToken) {
      await markLost(ctx, row);
      return { kind: "none" };
    }
    if (row.refreshLeaseUntil && row.refreshLeaseUntil > now) return { kind: "busy" };
    await ctx.db.patch(row._id, { refreshLeaseUntil: now + REFRESH_LEASE_MS });
    return { kind: "refresh", refreshToken: row.refreshToken, expiresAt: row.expiresAt };
  },
});

export const _tokenRefreshed = internalMutation({
  args: { accessToken: v.string(), refreshToken: v.optional(v.string()), expiresAt: v.string() },
  handler: async (ctx, a): Promise<void> => {
    assertSealed(a.accessToken, a.refreshToken);
    const row = await olxIntegration(ctx);
    if (!row || row.status !== "connected") return; // пока обновляли, OLX отключили — токены не возвращаем
    await ctx.db.patch(row._id, { accessToken: a.accessToken, refreshToken: a.refreshToken ?? row.refreshToken, expiresAt: a.expiresAt, refreshLeaseUntil: undefined });
  },
});

/** Токены OLX не расшифровываются нынешним ключом (его сменили) — доступ потерян, владельцу подключить заново. */
export const _undecryptable = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const row = await olxIntegration(ctx);
    if (row) await markLost(ctx, row, KEY_CHANGED_TEXT);
  },
});

export const _tokenRefreshFailed = internalMutation({
  args: { failure: vOlxFailure, leasedExpiresAt: v.optional(v.string()) },
  handler: async (ctx, { failure, leasedExpiresAt }): Promise<void> => {
    const row = await olxIntegration(ctx);
    if (!row || row.status !== "connected") return;
    await ctx.db.patch(row._id, { refreshLeaseUntil: undefined });
    // invalid_grant — refresh-токен протух или отозван; если токен за это время обновил другой процесс — доступ цел.
    if (failure.kind === "grant" && row.expiresAt === leasedExpiresAt) await markLost(ctx, row);
    else if (isPausing(failure)) await pauseFor(ctx, row, failure);
  },
});

/** Второй 401 подряд после обновления токена — доступ потерян. */
export const _lost = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const row = await olxIntegration(ctx);
    if (row) await markLost(ctx, row);
  },
});

/** Блокировка или 429 при отправке ответа и отметке «прочитано» — пауза для всех запросов к OLX. */
export const _failed = internalMutation({
  args: { failure: vOlxFailure },
  handler: async (ctx, { failure }): Promise<void> => {
    const row = await olxIntegration(ctx);
    if (row?.status === "connected" && isPausing(failure)) await pauseFor(ctx, row, failure);
  },
});

// ── Синхронизация ────────────────────────────────────────────────────────────

/** Начать проход: только при подключении, вне паузы и если другой проход («Синхронизировать сейчас») не идёт. */
export const _syncStart = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ cursor?: string; liveSince: string } | null> => {
    const row = await olxIntegration(ctx);
    const now = Date.now();
    if (!row || row.status !== "connected") return null;
    if (row.backoffUntil && Date.parse(row.backoffUntil) > now) return null;
    if (row.syncLeaseUntil && row.syncLeaseUntil > now) return null;
    await ctx.db.patch(row._id, { syncLeaseUntil: now + SYNC_LEASE_MS });
    const connectedAt = row.connectedAt ? Date.parse(row.connectedAt) : now;
    return { cursor: row.cursor, liveSince: new Date(connectedAt - LIVE_BEFORE_CONNECT_MS).toISOString() };
  },
});

export const _syncFinish = internalMutation({
  args: { cursor: v.string(), threads: v.number(), added: v.number(), failure: v.optional(vOlxFailure) },
  handler: async (ctx, a): Promise<void> => {
    const row = await olxIntegration(ctx);
    if (!row) return;
    if (row.status !== "connected") {
      if (row.syncLeaseUntil) await ctx.db.patch(row._id, { syncLeaseUntil: undefined });
      return;
    }
    const f = a.failure;
    if (f && f.kind !== "budget") {
      await ctx.db.patch(row._id, { syncLeaseUntil: undefined, cursor: a.cursor });
      // Пауза уже стоит, доступ потерян или OLX отключили — отмечено там, где это случилось.
      if (f.kind !== "paused" && f.kind !== "reauth" && f.kind !== "not_connected") await pauseFor(ctx, row, f);
      return;
    }
    await ctx.db.patch(row._id, { syncLeaseUntil: undefined, cursor: a.cursor, lastSyncAt: nowIso(), lastError: undefined, backoffUntil: undefined, backoffStep: undefined });
    await markOk(ctx, "olx", a.added ? `Синхронизация: диалогов ${a.threads}, новых сообщений ${a.added}` : `Синхронизация: диалогов ${a.threads}, новых сообщений нет`);
  },
});

/** Сохранённые снимки тредов, у которых уже есть диалог в «Сообщениях». */
export const _snapshots = internalQuery({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, { keys }): Promise<OlxSnapshot[]> => {
    const out: OlxSnapshot[] = [];
    for (const key of keys.slice(0, 100)) {
      const c = await byThread(ctx, key);
      if (!c) continue;
      const o = olxMeta(c.meta);
      out.push({ key, total: o.total, unread: o.unread, named: !!c.contactName || o.name === "none", advert: !!c.subject || o.advert === "none" });
    }
    return out;
  },
});

/** Каких сообщений OLX (по uuid) у нас ещё нет. */
export const _unknownKeys = internalQuery({
  args: { keys: v.array(v.string()) },
  handler: async (ctx, { keys }): Promise<string[]> => {
    const out: string[] = [];
    for (const key of keys.slice(0, 500)) if (!(await seenMessage(ctx, key))) out.push(key);
    return out;
  },
});

const vKeptFile = v.object({ fileId: v.id("_storage"), fileName: v.string(), kind: v.union(v.literal("image"), v.literal("file")), url: v.string() });
type KeptFile = Infer<typeof vKeptFile>;
const vItem = v.object({
  m: vOlxMessage,
  /** История при первой загрузке: в ленту без «непрочитанных», уведомлений и авто-заявки. */
  history: v.boolean(),
  file: v.optional(vKeptFile),
});
type Item = Infer<typeof vItem>;
const vAdvert = v.object({ id: v.number(), title: v.string(), url: v.optional(v.string()) });

/**
 * Ответ оператора из «Сообщений», которому ещё не записан id OLX (отправляется, ответ OLX без id или «не отправлено»
 * по таймауту), с тем же текстом — самый ранний. Опрос узнал его — дубля в ленте нет, статус — «отправлено».
 */
async function claimReply(ctx: MutationCtx, conversationId: Id<"conversations">, m: OlxMessage): Promise<boolean> {
  const since = new Date(Date.now() - 2 * 86400_000).toISOString();
  const recent = await ctx.db
    .query("conversationMessages")
    .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId).gte("at", since))
    .order("desc")
    .take(50);
  const mine = recent.filter((r) => r.direction === "out" && r.kind !== "system" && !r.externalId && !!r.authorId && sameText(r.text, m.text)).at(-1);
  if (!mine) return false;
  await ctx.db.patch(mine._id, { externalId: externalKey("olx", m.key), status: "sent", error: undefined });
  return true;
}

interface ThreadExtras {
  thread: OlxThread;
  contactName?: string;
  nameMissing?: boolean;
  advert?: OlxAdvert;
  advertMissing?: boolean;
}

/** Снимок счётчиков треда — после записи сообщений, в той же транзакции: сбой записи не сдвинет счётчики. */
async function saveSnapshot(ctx: MutationCtx, conv: Doc<"conversations">, a: ThreadExtras, created: boolean, inbound: number): Promise<void> {
  const meta = isRecord(conv.meta) ? conv.meta : {};
  const prev = isRecord(meta.olx) ? meta.olx : {};
  const olx = {
    ...prev,
    id: a.thread.id,
    advertId: a.thread.advertId,
    interlocutorId: a.thread.interlocutorId,
    total: a.thread.total,
    unread: a.thread.unread,
    ...(a.nameMissing ? { name: "none" } : {}),
    ...(a.advertMissing ? { advert: "none" } : {}),
  };
  const patch: Partial<Doc<"conversations">> = { meta: { ...meta, olx } };
  if (a.contactName && !conv.contactName) patch.contactName = a.contactName;
  if (a.advert && !conv.subject) Object.assign(patch, { subject: a.advert.title, subjectUrl: a.advert.url });
  // Первая загрузка: история — без «непрочитанных», но то, что не прочитано на OLX, видно и у нас.
  if (created) patch.unread = Math.max(conv.unread, Math.min(a.thread.unread, inbound));
  await ctx.db.patch(conv._id, patch);
}

/** Сообщения одного треда — в «Сообщения» одной транзакцией вместе со снимком счётчиков. */
export const _ingestThread = internalMutation({
  args: {
    thread: vOlxThread,
    items: v.array(vItem),
    contactName: v.optional(v.string()),
    nameMissing: v.optional(v.boolean()),
    advert: v.optional(vAdvert),
    advertMissing: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<{ added: number; unusedFiles: Id<"_storage">[] }> => {
    const existed = !!(await byThread(ctx, a.thread.key));
    const unusedFiles: Id<"_storage">[] = [];
    let added = 0;
    let inbound = 0;
    for (const { m, history, file } of a.items) {
      if (await seenMessage(ctx, m.key)) {
        if (file) unusedFiles.push(file.fileId);
        continue;
      }
      const conv = await byThread(ctx, a.thread.key);
      if (m.type === "sent" && conv && (await claimReply(ctx, conv._id, m))) continue;
      const text = messageText(m, file?.url);
      await ingestMessage(ctx, {
        channel: "olx",
        externalId: a.thread.key,
        contactName: a.contactName,
        text: text || (file ? (file.kind === "image" ? PLACEHOLDER.image : PLACEHOLDER.file) : ""),
        kind: file?.kind ?? "text",
        externalMessageId: m.key,
        at: m.at,
        fileId: file?.fileId,
        fileName: file?.fileName,
        subject: a.advert?.title,
        subjectUrl: a.advert?.url,
        // Сообщение компании, отправленное из приложения OLX, — исходящее: без заявки и уведомлений.
        direction: m.type === "sent" ? "out" : "in",
        history,
        // Фото без подписи и ссылки на вложения — не текст обращения: заявку из них не собираем.
        autoLead: m.text.trim() ? undefined : false,
      });
      added++;
      if (m.type === "received") inbound++;
    }
    const conv = await byThread(ctx, a.thread.key);
    if (conv) await saveSnapshot(ctx, conv, a, !existed, inbound);
    return { added, unusedFiles };
  },
});

/** Результат обогащения: значение, «у OLX этого нет» (больше не спрашиваем) или «не вышло сейчас» (спросим потом). */
type Enriched<T> = { value: T } | { missing: true } | { later: true };

interface Run {
  ctx: ActionCtx;
  cfg: OlxConfig;
  session: OlxSession;
  cursor: OlxCursor;
  /** Первая загрузка после подключения ещё не закончена. */
  initial: boolean;
  /** Сообщения новее — «живые» даже при первой загрузке. */
  liveSince: string;
  adverts: Map<number, Enriched<OlxAdvert>>;
  downloads: number;
}

async function page(session: OlxSession, path: string, query: Record<string, number>): Promise<unknown[]> {
  const list = listOf(await session.get(path, query));
  if (!list) throw new OlxError({ kind: "rejected", status: 200 });
  return list;
}

/** Имя и объявление — не главное: их ошибки проход не прерывают, но блокировку, паузу и потерю доступа соблюдаем. */
function enrichFailed(e: unknown): Enriched<never> {
  const f = failureOf(e);
  if (!isSystemic(f)) return { missing: true };
  if (f.kind === "server") return { later: true };
  throw e;
}

async function interlocutor(run: Run, t: OlxThread): Promise<Enriched<string>> {
  if (t.interlocutorId === undefined) return { missing: true };
  try {
    const name = asUserName(await run.session.get(`/users/${t.interlocutorId}`));
    return name ? { value: name } : { missing: true };
  } catch (e) {
    return enrichFailed(e);
  }
}

/** Объявление треда — тема диалога; одно объявление за проход спрашиваем один раз. */
async function advertOf(run: Run, t: OlxThread): Promise<Enriched<OlxAdvert>> {
  if (t.advertId === undefined) return { missing: true };
  const cached = run.adverts.get(t.advertId);
  if (cached) return cached;
  let res: Enriched<OlxAdvert>;
  try {
    const advert = asAdvert(await run.session.get(`/adverts/${t.advertId}`));
    res = advert ? { value: advert } : { missing: true };
  } catch (e) {
    res = enrichFailed(e);
  }
  run.adverts.set(t.advertId, res);
  return res;
}

/** Фото или файл покупателя — в хранилище: оператор откроет его прямо в «Сообщениях». Токен OLX на CDN не отправляем. */
async function download(ctx: ActionCtx, a: OlxAttachment): Promise<KeptFile | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FILE_TIMEOUT_MS);
  try {
    const res = await fetch(a.url, { signal: ctrl.signal });
    if (!res.ok || (res.url && !isOlxCdn(res.url)) || Number(res.headers.get("content-length") ?? 0) > FILE_MAX_BYTES) return null;
    const blob = await res.blob();
    if (!blob.size || blob.size > FILE_MAX_BYTES) return null;
    // Тип — из белого списка: html или svg из чата не откроются в браузере как страница.
    const mime = storageMime(res.headers.get("content-type") ?? undefined);
    const image = mime.startsWith("image/");
    const fileId = await ctx.storage.store(new Blob([blob], { type: mime }));
    return { fileId, fileName: safeFileName(a.name, image ? "photo.jpg" : "file"), kind: image ? "image" : "file", url: a.url };
  } catch (e) {
    console.warn(`olx: вложение не сохранено: ${e instanceof Error ? e.name : "ошибка"}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Вложения новых «живых» входящих — к себе (не больше 10 за проход); историю оставляем ссылками. */
async function keepFiles(run: Run, items: Item[]): Promise<Map<string, KeptFile>> {
  const kept = new Map<string, KeptFile>();
  const want = items.filter((i) => !i.history && i.m.type === "received" && i.m.attachments.some((a) => isOlxCdn(a.url)));
  if (!want.length || run.downloads >= DOWNLOADS_PER_RUN) return kept;
  const fresh = new Set(await run.ctx.runQuery(internal.channels.olx._unknownKeys, { keys: want.map((i) => i.m.key) }));
  for (const i of want) {
    const attachment = i.m.attachments.find((a) => isOlxCdn(a.url));
    if (!attachment || !fresh.has(i.m.key) || run.downloads >= DOWNLOADS_PER_RUN) continue;
    run.downloads++;
    const file = await download(run.ctx, attachment);
    if (file) kept.set(i.m.key, file);
  }
  return kept;
}

async function syncThread(run: Run, t: OlxThread, snap: OlxSnapshot | undefined): Promise<number> {
  const path = `/threads/${encodeURIComponent(t.key)}/messages`;
  const all = sortMessages(
    await collectPages(
      (offset) => page(run.session, path, { offset, limit: MESSAGES_PAGE }),
      (x) => asMessage(x, t.id, run.cfg.offset),
      (m) => m.key,
      { maxPages: MESSAGE_PAGES, expected: t.total },
    ),
  );
  // Тред начали мы (покупателем на чужом объявлении) или он пуст — не обращение клиента, в «Сообщения» не берём.
  if (!snap && (!all.length || all[0]!.type === "sent")) {
    run.cursor.skip[t.key] = t.total;
    return 0;
  }
  const initial = run.initial && !snap;
  const items: Item[] = all.slice(-THREAD_MESSAGES).map((m) => ({ m, history: initial && !(m.type === "received" && !m.isRead && (m.at ?? "") >= run.liveSince) }));
  const name = snap?.named ? undefined : await interlocutor(run, t);
  const advert = snap?.advert ? undefined : await advertOf(run, t);
  const files = await keepFiles(run, items);
  const r = await run.ctx.runMutation(internal.channels.olx._ingestThread, {
    thread: t,
    items: items.map((i) => ({ ...i, file: files.get(i.m.key) })),
    contactName: name && "value" in name ? name.value : undefined,
    nameMissing: name && "missing" in name ? true : undefined,
    advert: advert && "value" in advert ? advert.value : undefined,
    advertMissing: advert && "missing" in advert ? true : undefined,
  });
  // Параллельный проход успел записать те же сообщения — скачанные файлы не нужны.
  for (const id of r.unusedFiles) await run.ctx.storage.delete(id);
  delete run.cursor.skip[t.key];
  return r.added;
}

async function snapshots(ctx: ActionCtx, keys: string[]): Promise<Map<string, OlxSnapshot>> {
  const out = new Map<string, OlxSnapshot>();
  for (let i = 0; i < keys.length; i += 100) {
    for (const s of await ctx.runQuery(internal.channels.olx._snapshots, { keys: keys.slice(i, i + 100) })) out.set(s.key, s);
  }
  return out;
}

/** Полный проход: список тредов → изменившиеся → их сообщения. complete — все изменения забраны. */
async function syncAll(run: Run): Promise<{ threads: number; added: number; complete: boolean }> {
  const threads = await collectPages((offset) => page(run.session, "/threads", { offset, limit: THREADS_PAGE }), asThread, (t) => t.key, { maxPages: THREAD_PAGES });
  const snaps = await snapshots(run.ctx, threads.map((t) => t.key));
  // Сначала треды с непрочитанными: при первой загрузке и нехватке бюджета важнее свежие обращения.
  const changed = threads.filter((t) => threadChanged(t, snaps.get(t.key), run.cursor.skip[t.key])).sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0));
  let added = 0;
  for (const t of changed) {
    try {
      added += await syncThread(run, t, snaps.get(t.key));
    } catch (e) {
      const f = failureOf(e);
      if (f.kind === "budget") return { threads: threads.length, added, complete: false };
      if (isSystemic(f)) throw e;
      // Тред удалён или недоступен (404/403/400) — запоминаем его счётчики, чтобы не спрашивать OLX каждую минуту.
      const snap = snaps.get(t.key);
      if (snap) await run.ctx.runMutation(internal.channels.olx._ingestThread, { thread: t, items: [] });
      else run.cursor.skip[t.key] = t.total;
    }
  }
  return { threads: threads.length, added, complete: true };
}

/** Cron раз в минуту (и «Синхронизировать сейчас»): без подключения ничего не делает и в OLX не ходит. */
export const sync = internalAction({
  args: { tenantId: v.optional(v.string()) },
  handler: (cronCtx, { tenantId }): Promise<void> => perTenantAction(cronCtx, tenantId, internal.channels.olx.sync, syncTenant),
});

/** Синхронизация OLX одной компании: у каждой своё подключение (integrations) и свой курсор. */
async function syncTenant(ctx: ActionCtx): Promise<void> {
  const cfg = olxConfig();
  if (!cfg) return;
  // Модуль OLX выключен у компании (ТЗ §24.3) — её подключение не синхронизируем.
  if (!(await actionHasModule(ctx, "olx"))) return;
  // Без ключа шифрования токены не открыть и новые не сохранить: в OLX не ходим, токены не трогаем — с ключом всё продолжится.
  // Причину владелец видит в карточке OLX и в «Состоянии системы» (там она считается по окружению).
  if (integrationsKeyIssue()) return;
  const start = await ctx.runMutation(internal.channels.olx._syncStart, {});
  if (!start) return;
  const cursor = readCursor(start.cursor);
  const run: Run = {
    ctx,
    cfg,
    cursor,
    initial: !cursor.ready,
    liveSince: start.liveSince,
    session: olxSession(ctx, cfg, { budget: RUN_BUDGET, until: Date.now() + RUN_TIME_MS }),
    adverts: new Map(),
    downloads: 0,
  };
  let result = { threads: 0, added: 0 };
  let failure: OlxFailure | undefined;
  try {
    const r = await syncAll(run);
    result = r;
    if (r.complete) cursor.ready = true;
    else failure = { kind: "budget" };
  } catch (e) {
    failure = failureOf(e);
    if (!(e instanceof OlxError)) console.error(`olx: сбой синхронизации: ${e instanceof Error ? e.name : "ошибка"}`);
    else if (failure.kind === "blocked") console.warn(`olx: CloudFront заблокировал запросы, Request ID ${failure.requestId ?? "—"}`);
    else console.warn(`olx: синхронизация прервана (${failure.kind})`);
  }
  await ctx.runMutation(internal.channels.olx._syncFinish, { cursor: writeCursor(cursor), threads: result.threads, added: result.added, failure });
}

// ── «Прочитано» на OLX ───────────────────────────────────────────────────────

export const _readTarget = internalQuery({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }): Promise<string | null> => {
    const c = await ctx.db.get(conversationId);
    return c?.channel === "olx" ? c.externalId : null;
  },
});

/**
 * Оператор открыл диалог — тред на OLX тоже прочитан (lib/olxApi.ts → scheduleOlxRead). Фоновый опрос сам тред
 * прочитанным не отмечает: иначе в приложении OLX пропадут непрочитанные. Сбой — не беда, кроме блокировки.
 */
export const markThreadRead = internalAction({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }): Promise<void> => {
    const cfg = olxConfig();
    const thread = cfg ? await ctx.runQuery(internal.channels.olx._readTarget, { conversationId }) : null;
    if (!cfg || !thread) return;
    try {
      await olxSession(ctx, cfg, { budget: 3, until: Date.now() + 60_000 }).post(`/threads/${encodeURIComponent(thread)}/commands`, { command: "mark-as-read" });
    } catch (e) {
      const f = failureOf(e);
      console.warn(`olx: тред не отмечен прочитанным (${f.kind})`);
      if (isPausing(f)) await ctx.runMutation(internal.channels.olx._failed, { failure: f });
    }
  },
});
