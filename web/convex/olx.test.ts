/// <reference types="vite/client" />
// OLX.kz Partner API: подключение (OAuth, одноразовый state), синхронизация чатов (снимки счётчиков, дубли, история
// при подключении), токены (обновление, 401, invalid_grant), блокировка CloudFront, ответы оператора и «прочитано».
// OLX подменён fetch-заглушкой по фикстурам из спецификации (test/fixtures/olx); на неожиданный адрес — исключение.
import { convexTest } from "convex-test";
import type { WithoutSystemFields } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import E1 from "../test/fixtures/olx/E1.json?raw";
import E3 from "../test/fixtures/olx/E3.json?raw";
import E4 from "../test/fixtures/olx/E4.json?raw";
import E5 from "../test/fixtures/olx/E5.json?raw";
import E6 from "../test/fixtures/olx/E6.json?raw";
import E7 from "../test/fixtures/olx/E7.json?raw";
import E8 from "../test/fixtures/olx/E8.html?raw";
import F1 from "../test/fixtures/olx/F1.json?raw";
import F2 from "../test/fixtures/olx/F2.json?raw";
import F3 from "../test/fixtures/olx/F3.json?raw";
import F4 from "../test/fixtures/olx/F4.json?raw";
import F5 from "../test/fixtures/olx/F5-response.json?raw";
import F6 from "../test/fixtures/olx/F6.json?raw";
import F7 from "../test/fixtures/olx/F7.json?raw";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { asMessage, asThread, asToken, classifyFailure, hasScopes, parseOlxDate, sendErrorText } from "./lib/olx";
import { openSecret } from "./lib/secretBox";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

type Rec = Record<string, unknown>;
const newTest = () => convexTest(schema, modules);
type TestEnv = ReturnType<typeof newTest>;

const T = "t-test";
const SITE = "https://demo-123.convex.site";
const APP = "https://app.test";
const CALLBACK = `${SITE}/olx/callback`;
const TOKEN_URL = "https://www.olx.kz/api/open/oauth/token";
const API = "https://www.olx.kz/api/partner";
const CDN = "https://frankfurt.apollo.olxcdn.com/";
const CLIENT_ID = "200027";
const CLIENT_SECRET = "secret-test";
/** 15:30 по Алматы: все сообщения фикстур уже в прошлом. */
const NOW = new Date("2026-10-12T10:30:00Z");
const REAUTH = "Нужно заново подключить OLX";
const CF_ID = "6M0q-VjzE8C1cATaVRL8BgsR8r42wV0sfbyrBKMQph6J22jL7QZKrg==";
/** Ключ шифрования токенов (32 байта в base64): без него токены OLX не сохраняются. */
const INTEGRATIONS_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";

const parse = (raw: string): Rec => JSON.parse(raw) as Rec;
const dataOf = (raw: string): Rec[] => parse(raw).data as Rec[];
const iso = (ms: number) => new Date(ms).toISOString();

const TOKENS = parse(F1);
const ACCESS = String(TOKENS.access_token);
const REFRESH = String(TOKENS.refresh_token);
const [THREAD_ROW, BUYER_ROW, THIRD_ROW] = dataOf(F3) as [Rec, Rec, Rec];
const THREAD = String(THREAD_ROW.uuid);
const BUYER = String(BUYER_ROW.uuid);
const THIRD = String(THIRD_ROW.uuid);
const ADVERT = parse(F6).data as Rec;
const REPLY_TEXT = String((parse(F5).data as Rec).text);

/** Тред 7c41…: начали мы — покупателем на чужом объявлении (первое сообщение «sent»). */
const BUYER_MESSAGES: Rec[] = [
  { id: 9810000001, uuid: "1a2b3c4d-0000-4000-8000-000000000001", thread_id: 2290104410, thread_uuid: BUYER, created_at: "2026-10-11 19:47:02", type: "sent", text: "Здравствуйте! Компрессор ещё продаёте?", is_read: true, attachments: null },
  { id: 9810000002, uuid: "1a2b3c4d-0000-4000-8000-000000000002", thread_id: 2290104410, thread_uuid: BUYER, created_at: "2026-10-11 19:50:13", type: "received", text: "Да, продаю. Звоните 8 701 000 00 00", is_read: true, attachments: null },
  { id: 9810000003, uuid: "1a2b3c4d-0000-4000-8000-000000000003", thread_id: 2290104410, thread_uuid: BUYER, created_at: "2026-10-11 19:52:40", type: "received", text: "Могу привезти завтра", is_read: true, attachments: null },
];
/** Тред c2e9…: одно новое сообщение без телефона; собеседник и объявление у OLX недоступны (404). */
const THIRD_MESSAGES: Rec[] = [
  { id: 9812000001, uuid: "5e6f7a8b-0000-4000-8000-000000000003", thread_id: 2289907765, thread_uuid: THIRD, created_at: "2026-10-12 15:20:45", type: "received", text: "Добрый день! Нужна установка кондиционера в Алатауском районе", is_read: false, attachments: null },
];

// ── Заглушка OLX ─────────────────────────────────────────────────────────────

type Call = { url: string; method: string; headers: Headers; body: Rec | null };
let calls: Call[] = [];

interface FakeOlx {
  /** Какой access-токен OLX сейчас принимает. */
  access: string;
  threads: Rec[];
  messages: Record<string, Rec[]>;
  token: (body: Rec) => Response;
  /** Подмена ответа на список тредов (блокировка и т.п.). */
  list?: () => Response;
  /** Подмена ответа на отправку сообщения. */
  send?: (thread: string, body: Rec) => Response;
  /** OLX не понимает offset — каждая страница с начала. */
  ignoreOffset?: boolean;
  /** Сколько следующих запросов сообщений треда OLX провалит (503). */
  failMessages?: number;
}
let olx: FakeOlx;
let sentSeq = 0;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
/** Ошибки OAuth OLX отдаёт с Content-Type: text/html, хотя тело — JSON. */
const oauthError = (status: number, raw: string) => new Response(raw, { status, headers: { "Content-Type": "text/html; charset=UTF-8" } });
const cloudfront = () => new Response(E8, { status: 403, headers: { "Content-Type": "text/html", Server: "CloudFront", "X-Amz-Cf-Id": CF_ID } });

function thread(key: string): Rec {
  const t = olx.threads.find((x) => x.uuid === key);
  if (!t) throw new Error(`нет треда ${key}`);
  return t;
}

/** Новое сообщение в треде OLX: счётчики треда растут, как у настоящего OLX. */
function addMessage(key: string, m: Rec): void {
  olx.messages[key] = [...(olx.messages[key] ?? []), m];
  const t = thread(key);
  t.total_count = Number(t.total_count) + 1;
  if (m.type === "received") t.unread_count = Number(t.unread_count) + 1;
}

/** В аккаунте OLX — только эти треды (свежие копии фикстуры: тесты меняют их счётчики). */
const only = (...keys: string[]) => {
  olx.threads = olx.threads.filter((x) => keys.includes(String(x.uuid)));
};

/** OLX принял ответ: сообщение в треде, тело ответа — как в фикстуре F5. */
function accept(key: string, body: Rec): Rec {
  const base = parse(F5).data as Rec;
  const n = sentSeq++;
  const msg = { ...base, id: 9811000005 + n, uuid: n === 0 ? base.uuid : `ff4ad82a-bf5f-40fc-8057-0000000000${String(n).padStart(2, "0")}`, thread_uuid: key, text: body.text };
  addMessage(key, msg);
  return msg;
}

function fakeOlx(input: string | URL | Request, init?: RequestInit): Response {
  const url = input instanceof Request ? input.url : String(input);
  const headers = new Headers(init?.headers);
  const method = init?.method ?? "GET";
  const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Rec) : null;
  calls.push({ url, method, headers, body });
  if (url === TOKEN_URL) return olx.token(body ?? {});
  if (url.startsWith(CDN)) return new Response(new Uint8Array([255, 216, 255, 224, 0, 16]), { headers: { "Content-Type": "image/jpeg" } });
  if (!url.startsWith(`${API}/`)) throw new Error(`Неожиданный запрос: ${url}`);
  if (headers.get("version") !== "2.0") return json(400, parse(E3));
  if (headers.get("authorization") !== `Bearer ${olx.access}`) return oauthError(401, E1);
  const u = new URL(url);
  const path = u.pathname.slice("/api/partner".length);
  const page = (list: Rec[]) => {
    const limit = Number(u.searchParams.get("limit") ?? 1000);
    const offset = olx.ignoreOffset ? 0 : Number(u.searchParams.get("offset") ?? 0);
    return json(200, { data: list.slice(offset, offset + limit) });
  };
  if (path === "/users/me") return json(200, parse(F2));
  if (path === "/threads") return olx.list?.() ?? page(olx.threads);
  const m = /^\/threads\/([^/]+)\/(messages|commands)$/.exec(path);
  if (m && m[2] === "commands" && method === "POST") return new Response(null, { status: 204 });
  if (m && method === "POST") return olx.send ? olx.send(m[1]!, body ?? {}) : json(200, { data: accept(m[1]!, body ?? {}) });
  if (m && olx.failMessages) {
    olx.failMessages--;
    return new Response("<html><body>503 Service Unavailable</body></html>", { status: 503, headers: { "Content-Type": "text/html" } });
  }
  if (m) return page(olx.messages[m[1]!] ?? []);
  if (path === "/users/556677001") return json(200, parse(F7));
  if (path === "/adverts/118765432") return json(200, parse(F6));
  if (/^\/(users|adverts)\/\d+$/.test(path)) return json(404, parse(E7));
  throw new Error(`Неожиданный путь OLX: ${path}`);
}

beforeEach(() => {
  calls = [];
  sentSeq = 0;
  olx = {
    access: ACCESS,
    threads: dataOf(F3),
    messages: { [THREAD]: dataOf(F4), [BUYER]: BUYER_MESSAGES.map((x) => ({ ...x })), [THIRD]: THIRD_MESSAGES.map((x) => ({ ...x })) },
    token: (body) => (body.grant_type === "authorization_code" ? json(200, TOKENS) : json(200, { access_token: "fresh-access", expires_in: 86400, token_type: "bearer", scope: "v2 read write", refresh_token: "ref-2" })),
  };
  vi.stubEnv("OLX_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("OLX_CLIENT_SECRET", CLIENT_SECRET);
  vi.stubEnv("INTEGRATIONS_KEY", INTEGRATIONS_KEY);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("APP_URL", APP);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => fakeOlx(input, init)),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── Окружение теста ──────────────────────────────────────────────────────────

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const t = newTest();
  const ids = await t.run(async (ctx) => ({
    owner: await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true }),
    operator: await ctx.db.insert("users", { name: "Оператор Мадина", email: "op@test.kz", role: "operator", tenantId: T, active: true }),
  }));
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as, owner: as(ids.owner), op: as(ids.operator) };
}

/**
 * OLX уже подключён (как после callback). По умолчанию первая загрузка закончена — всё новое «живое».
 * Токены здесь открытым текстом — как сохранённые до шифрования: такие работают и заменяются зашифрованными при обновлении.
 */
async function connect(t: TestEnv, owner: Id<"users">, extra: Partial<WithoutSystemFields<Doc<"integrations">>> = {}): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.insert("integrations", {
      provider: "olx",
      status: "connected",
      accountId: "870012345",
      accountName: "Home Max Service",
      accessToken: olx.access,
      refreshToken: "ref-1",
      expiresAt: iso(NOW.getTime() + 86400_000),
      connectedBy: owner,
      connectedAt: iso(NOW.getTime() - 2 * 3600_000),
      cursor: JSON.stringify({ ready: true, skip: {} }),
      ...extra,
    });
  });
}

const sync = (t: TestEnv) => t.action(internal.channels.olx.sync, {});
const drain = (t: TestEnv) => t.finishAllScheduledFunctions(vi.runAllTimers);
const integration = (t: TestEnv) => t.run((ctx) => ctx.db.query("integrations").first());
/** Токены из базы, расшифрованные; enc — оба сохранены шифртекстом. */
async function tokensOf(row: Doc<"integrations"> | null): Promise<{ accessToken?: string; refreshToken?: string; enc: boolean }> {
  const open = async (s: string | undefined, purpose: "olx.accessToken" | "olx.refreshToken") => (s === undefined ? undefined : (await openSecret(s, purpose)).value);
  return {
    accessToken: await open(row?.accessToken, "olx.accessToken"),
    refreshToken: await open(row?.refreshToken, "olx.refreshToken"),
    enc: [row?.accessToken, row?.refreshToken].every((s) => s === undefined || s.startsWith("enc:v1:")),
  };
}
const conversation = (t: TestEnv, key: string) =>
  t.run((ctx) =>
    ctx.db
      .query("conversations")
      .withIndex("by_channel_external", (q) => q.eq("channel", "olx").eq("externalId", key))
      .first(),
  );
const messagesOf = (t: TestEnv, id: Id<"conversations">) =>
  t.run((ctx) =>
    ctx.db
      .query("conversationMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", id))
      .collect(),
  );
const table = <N extends "notifications" | "audit" | "leads" | "oauthStates" | "systemStatus">(t: TestEnv, name: N) => t.run((ctx) => ctx.db.query(name).collect());
const callsTo = (part: string) => calls.filter((c) => c.url.includes(part));
const olxMeta = (c: Doc<"conversations"> | null): Rec => ((c?.meta as Rec | undefined)?.olx as Rec | undefined) ?? {};

/** Заход браузера владельца на адрес возврата. */
const callback = (t: TestEnv, query: string) => t.fetch(`/olx/callback?${query}`, { method: "GET" });

// ── Протокол ─────────────────────────────────────────────────────────────────

describe("протокол OLX", () => {
  test("даты без пояса — время Казахстана, с зоной — как есть; конверт data; запасной ключ без uuid", () => {
    expect(parseOlxDate("2026-10-12 14:03:11")).toBe("2026-10-12T09:03:11.000Z");
    expect(parseOlxDate("2026-10-12 14:03:11", "+06:00")).toBe("2026-10-12T08:03:11.000Z");
    expect(parseOlxDate("2026-10-12T14:03:11Z")).toBe("2026-10-12T14:03:11.000Z");
    expect(parseOlxDate("2026-10-12T14:03:11+05:00")).toBe("2026-10-12T09:03:11.000Z");
    expect(parseOlxDate("вчера")).toBeUndefined();
    expect(asThread(THREAD_ROW)).toEqual({ key: THREAD, id: 2290112233, advertId: 118765432, interlocutorId: 556677001, total: 4, unread: 2 });
    const first = dataOf(F4)[0]!;
    expect(asMessage(first, undefined, "+05:00")).toMatchObject({ key: "6344cb38-9b8d-464e-b5ad-903dd06fb695", type: "received", isRead: true, at: "2026-10-12T09:03:11.000Z", attachments: [] });
    // uuid ещё нет — ключ из числовых id треда и сообщения.
    expect(asMessage({ ...first, uuid: undefined }, undefined, "+05:00")?.key).toBe("t2290112233:m9811000001");
    expect(asToken(TOKENS)).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 86400, scope: "v2 read write" });
    expect(asToken({ data: TOKENS })?.accessToken).toBe(ACCESS);
    expect(hasScopes("v2 read write")).toBe(true);
    expect(hasScopes("read v2")).toBe(false);
  });

  test("ошибки OLX всех форм: OAuth (в text/html), API, API в конверте, HTML CloudFront", () => {
    const h = (map: Record<string, string> = {}) => (name: string) => map[name.toLowerCase()] ?? null;
    expect(classifyFailure(401, E1, h())).toEqual({ kind: "unauthorized" });
    expect(classifyFailure(401, E4, h())).toEqual({ kind: "client" });
    expect(classifyFailure(400, E5, h())).toEqual({ kind: "grant" });
    expect(classifyFailure(404, E7, h())).toEqual({ kind: "not_found" });
    expect(classifyFailure(400, E3, h())).toMatchObject({ kind: "rejected", status: 400, reason: "Missing required 'Version' header!" });
    const validation = classifyFailure(400, E6, h());
    expect(validation).toMatchObject({ kind: "rejected", field: "text", reason: "This value should not be blank." });
    expect(sendErrorText(validation)).toBe("OLX не принимает пустое сообщение");
    expect(classifyFailure(403, E8, h({ "x-amz-cf-id": CF_ID }))).toEqual({ kind: "blocked", requestId: CF_ID });
    expect(classifyFailure(403, E8, h())).toEqual({ kind: "blocked", requestId: CF_ID });
    expect(classifyFailure(403, JSON.stringify({ error: { status: 403, title: "Forbidden" } }), h())).toEqual({ kind: "forbidden" });
    expect(classifyFailure(429, "", h({ "retry-after": "120" }))).toEqual({ kind: "throttled", retryAfterSec: 120 });
    expect(classifyFailure(502, "<html>Bad gateway</html>", h())).toEqual({ kind: "server", status: 502 });
  });
});

// ── Подключение ──────────────────────────────────────────────────────────────

describe("подключение OLX", () => {
  test("connectUrl: только владелец; state в базе; в адресе OLX — client_id, response_type, scope, state и redirect_uri", async () => {
    const { t, ids, owner, op } = await setup();
    await expect(op.mutation(api.channels.olx.connectUrl, {})).rejects.toThrow("Нет доступа");
    const url = new URL(await owner.mutation(api.channels.olx.connectUrl, {}));
    expect(`${url.origin}${url.pathname}`).toBe("https://www.olx.kz/oauth/authorize/");
    const [state] = await table(t, "oauthStates");
    expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: CLIENT_ID, response_type: "code", scope: "read write v2", state: state!.state, redirect_uri: CALLBACK });
    expect(state).toMatchObject({ provider: "olx", userId: ids.owner, createdAt: NOW.toISOString() });
    expect(state!.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls).toHaveLength(0);
    // Ключей ещё нет — подключать нечего.
    vi.stubEnv("OLX_CLIENT_SECRET", "");
    await expect(owner.mutation(api.channels.olx.connectUrl, {})).rejects.toThrow("OLX ещё не настроен");
  });

  test("callback: неизвестный, просроченный и уже использованный state, отказ на странице OLX — без обмена кода", async () => {
    const { t, ids, owner } = await setup();
    const location = (r: Response) => r.headers.get("location");

    const unknown = await callback(t, "code=abc&state=nope");
    expect(unknown.status).toBe(302);
    expect(location(unknown)).toBe(`${APP}/settings?olx=error&reason=state`);

    await t.run((ctx) => ctx.db.insert("oauthStates", { state: "old-state-0123456789", provider: "olx", userId: ids.owner, createdAt: iso(NOW.getTime() - 11 * 60_000) }));
    expect(location(await callback(t, "code=abc&state=old-state-0123456789"))).toBe(`${APP}/settings?olx=error&reason=expired`);

    const denied = new URL(await owner.mutation(api.channels.olx.connectUrl, {})).searchParams.get("state")!;
    expect(location(await callback(t, `error=access_denied&state=${denied}`))).toBe(`${APP}/settings?olx=error&reason=denied`);
    expect(callsTo(TOKEN_URL)).toHaveLength(0);

    const state = new URL(await owner.mutation(api.channels.olx.connectUrl, {})).searchParams.get("state")!;
    expect(location(await callback(t, `code=CODE-1&state=${state}`))).toBe(`${APP}/settings?olx=connected`);
    expect(callsTo(TOKEN_URL)).toHaveLength(1);
    // Повтор того же адреса (кнопка «назад», перехват) — state уже погашен.
    expect(location(await callback(t, `code=CODE-1&state=${state}`))).toBe(`${APP}/settings?olx=error&reason=state`);
    expect(location(await callback(t, `error=access_denied&state=${denied}`))).toBe(`${APP}/settings?olx=error&reason=state`);
    expect(callsTo(TOKEN_URL)).toHaveLength(1);
    expect(await table(t, "oauthStates")).toHaveLength(0);
  });

  test("callback: код → токены (JSON, redirect_uri, свой User-Agent), аккаунт из /users/me; интеграция подключена, журнал; токены наружу не уходят", async () => {
    const { t, ids, owner } = await setup();
    const state = new URL(await owner.mutation(api.channels.olx.connectUrl, {})).searchParams.get("state")!;
    const res = await callback(t, `code=CODE-123&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP}/settings?olx=connected`);
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");

    const [exchange, me] = calls;
    expect(exchange).toMatchObject({ url: TOKEN_URL, method: "POST" });
    expect(exchange!.body).toEqual({ grant_type: "authorization_code", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: "CODE-123", scope: "v2 read write", redirect_uri: CALLBACK });
    expect(exchange!.headers.get("content-type")).toBe("application/json");
    expect(exchange!.headers.get("user-agent")).toBe(`HomeMaxService/1.0 (+${APP})`);
    expect(me).toMatchObject({ url: `${API}/users/me`, method: "GET" });
    expect(me!.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    expect(exchange!.headers.get("version")).toBeNull();
    expect(me!.headers.get("version")).toBe("2.0");
    expect(me!.headers.get("content-type")).toBeNull();
    expect(me!.headers.get("user-agent")).toBe(`HomeMaxService/1.0 (+${APP})`);

    const row = await integration(t);
    expect(row).toMatchObject({
      provider: "olx",
      status: "connected",
      accountId: "870012345",
      accountName: "Home Max Service · homemax.service@example.com",
      expiresAt: iso(NOW.getTime() + 86400_000),
      connectedBy: ids.owner,
      connectedAt: NOW.toISOString(),
    });
    // В базе — только шифртекст (INTEGRATIONS_KEY), расшифровывается в те же токены.
    expect(await tokensOf(row)).toEqual({ accessToken: ACCESS, refreshToken: REFRESH, enc: true });
    expect(JSON.stringify(row)).not.toContain(ACCESS);
    expect((await table(t, "audit")).map((a) => [a.action, a.actorId])).toEqual([["integration.connected", ids.owner]]);

    // Ни карточка владельца, ни мониторинг, ни адрес возврата токенов не содержат.
    const settings = await owner.query(api.channels.olx.settings, {});
    expect(settings).toMatchObject({ configured: true, status: "connected", accountId: "870012345", callbackUrl: CALLBACK, connectedBy: "Владелец" });
    const exposed = JSON.stringify([settings, await owner.query(api.health.list, {}), res.headers.get("location")]);
    for (const secret of [ACCESS, REFRESH, CLIENT_SECRET, "CODE-123"]) expect(exposed).not.toContain(secret);
  });
});

// ── Синхронизация ────────────────────────────────────────────────────────────

describe("синхронизация OLX", () => {
  test("первая загрузка: тема — объявление, имя — из OLX; история без «непрочитанных» и заявок; тред покупателя пропущен; повтор без дублей", async () => {
    const { t, ids } = await setup();
    // Только что подключили: курсора нет — идёт первая загрузка.
    await connect(t, ids.owner, { cursor: undefined });
    await sync(t);

    const conv = (await conversation(t, THREAD))!;
    expect(conv).toMatchObject({ subject: ADVERT.title, subjectUrl: ADVERT.url, contactName: "Айгерим", contactPhone: "77000001234", status: "open", lastDirection: "in" });
    // Прочитанное на OLX раньше — история; два непрочитанных — «живые».
    expect(conv.unread).toBe(2);
    expect(olxMeta(conv)).toMatchObject({ total: 4, unread: 2, advertId: 118765432, interlocutorId: 556677001 });
    const msgs = await messagesOf(t, conv._id);
    const f4 = dataOf(F4);
    expect(msgs.map((m) => [m.direction, m.kind, m.text, m.at, m.externalId])).toEqual([
      ["in", "text", f4[0]!.text, "2026-10-12T09:03:11.000Z", `olx:${String(f4[0]!.uuid)}`],
      ["out", "text", f4[1]!.text, "2026-10-12T09:05:40.000Z", `olx:${String(f4[1]!.uuid)}`],
      ["in", "image", "Фото", "2026-10-12T09:10:55.000Z", `olx:${String(f4[2]!.uuid)}`],
      ["in", "text", f4[3]!.text, "2026-10-12T09:12:09.000Z", `olx:${String(f4[3]!.uuid)}`],
    ]);
    // Сообщение компании из приложения OLX — исходящее, «отправлено», без автора.
    expect(msgs[1]).toMatchObject({ status: "sent" });
    expect(msgs[1]!.authorId).toBeUndefined();
    // Фото покупателя сохранено у нас.
    expect(msgs[2]!.fileId).toBeDefined();
    expect(msgs[2]!.fileName).toBe("IMG_20261012_141055.jpg");

    // Третий тред: имени и объявления у OLX нет (404) — без темы, больше не спрашиваем.
    const third = (await conversation(t, THIRD))!;
    expect(third.unread).toBe(1);
    expect(third.subject).toBeUndefined();
    expect(third.contactName).toBeUndefined();
    expect(olxMeta(third)).toMatchObject({ total: 1, unread: 1, name: "none", advert: "none" });
    // Тред, начатый нами как покупателем, — не обращение клиента.
    expect(await conversation(t, BUYER)).toBeNull();
    expect(callsTo(`/threads/${BUYER}/messages`)).toHaveLength(1);
    expect(callsTo("/users/556677002")).toHaveLength(0);

    // Уведомления — по «живым» сообщениям (не чаще раза в 10 минут на диалог), фоновый опрос не отмечает «прочитано».
    expect((await table(t, "notifications")).filter((n) => n.text.includes("на OLX"))).toHaveLength(4);
    expect(callsTo("/commands")).toHaveLength(0);
    const row = await integration(t);
    expect(row).toMatchObject({ lastSyncAt: NOW.toISOString(), status: "connected" });
    expect(row!.lastError).toBeUndefined();
    expect(row!.syncLeaseUntil).toBeUndefined();
    expect(JSON.parse(row!.cursor!)).toEqual({ ready: true, skip: { [BUYER]: 3 } });

    // Заявка — только из «живого» сообщения с номером; история её не создаёт.
    await drain(t);
    const leads = await table(t, "leads");
    expect(leads.map((l) => [l.clientPhone, l.source])).toEqual([["77000001234", "olx"]]);

    // Повтор: ничего не изменилось — только список тредов, ни одного дубля.
    const before = calls.length;
    const count = (await t.run((ctx) => ctx.db.query("conversationMessages").collect())).length;
    await sync(t);
    expect(calls.slice(before).map((c) => new URL(c.url).pathname)).toEqual(["/api/partner/threads", "/api/partner/threads"]);
    expect((await t.run((ctx) => ctx.db.query("conversationMessages").collect())).length).toBe(count);
  });

  test("новые сообщения: входящее — «непрочитанное», ответ компании из приложения OLX — исходящий; имя и объявление не спрашиваем снова", async () => {
    const { t, ids } = await setup();
    await connect(t, ids.owner);
    await sync(t);
    const conv = (await conversation(t, THREAD))!;
    // В «живом» режиме все три входящих — непрочитанные.
    expect(conv.unread).toBe(3);
    const notes = (await table(t, "notifications")).length;

    vi.setSystemTime(new Date(NOW.getTime() + 5 * 60_000));
    addMessage(THREAD, { id: 9811000010, uuid: "9c0d1e2f-0000-4000-8000-000000000010", thread_id: 2290112233, thread_uuid: THREAD, created_at: "2026-10-12 15:31:00", type: "received", text: "Во сколько приедет мастер?", is_read: false, attachments: null });
    addMessage(THREAD, { id: 9811000011, uuid: "9c0d1e2f-0000-4000-8000-000000000011", thread_id: 2290112233, thread_uuid: THREAD, created_at: "2026-10-12 15:33:00", type: "sent", text: "Мастер будет в 18:30", is_read: false, attachments: null });
    const before = calls.length;
    await sync(t);

    const after = (await conversation(t, THREAD))!;
    expect(after).toMatchObject({ unread: 4, lastDirection: "out", lastText: "Мастер будет в 18:30" });
    expect(olxMeta(after)).toMatchObject({ total: 6, unread: 3 });
    const msgs = await messagesOf(t, conv._id);
    expect(msgs.slice(-2).map((m) => [m.direction, m.text, m.status ?? null])).toEqual([
      ["in", "Во сколько приедет мастер?", null],
      ["out", "Мастер будет в 18:30", "sent"],
    ]);
    const fresh = calls.slice(before).map((c) => new URL(c.url).pathname);
    expect(fresh.filter((p) => p.includes("/users/") || p.includes("/adverts/"))).toEqual([]);
    expect(fresh.filter((p) => p.endsWith("/messages"))).toEqual([`/api/partner/threads/${THREAD}/messages`]);
    // Второе уведомление за 10 минут по тому же диалогу — нет; от сообщения компании — тоже нет.
    expect((await table(t, "notifications")).length).toBe(notes);
  });

  test("«Синхронизировать сейчас»: только владелец, проход тот же, не чаще раза в минуту", async () => {
    const { t, ids, owner, op } = await setup();
    await connect(t, ids.owner);
    await expect(op.mutation(api.channels.olx.syncNow, {})).rejects.toThrow("Нет доступа");
    await owner.mutation(api.channels.olx.syncNow, {});
    await expect(owner.mutation(api.channels.olx.syncNow, {})).rejects.toThrow("подождите минуту");
    await drain(t);
    expect(await conversation(t, THREAD)).not.toBeNull();
    expect((await integration(t))!.lastSyncAt).toBeDefined();
  });

  test("OLX игнорирует offset — проход не зацикливается и ничего не пропускает", async () => {
    const { t, ids } = await setup();
    await connect(t, ids.owner);
    olx.ignoreOffset = true;
    await sync(t);
    // Вторая страница начинается с той же записи — стоп.
    expect(callsTo(`${API}/threads?`)).toHaveLength(2);
    expect(await conversation(t, THREAD)).not.toBeNull();
    expect(await conversation(t, THIRD)).not.toBeNull();
    // Сообщения: получили total_count записей — дальше не листаем.
    expect(callsTo(`/threads/${THREAD}/messages`)).toHaveLength(1);
  });

  test("401 → обновление токена (refresh_token, новый refresh) → повтор успешен; за 5 минут до конца — обновление заранее", async () => {
    const { t, ids } = await setup();
    only(THIRD);
    olx.access = "fresh-access";
    await connect(t, ids.owner, { accessToken: "stale-token" });
    await sync(t);

    expect(calls.slice(0, 3).map((c) => [c.url.replace(/\?.*/, ""), c.headers.get("authorization")])).toEqual([
      [`${API}/threads`, "Bearer stale-token"],
      [TOKEN_URL, null],
      [`${API}/threads`, "Bearer fresh-access"],
    ]);
    expect(calls[1]!.body).toEqual({ grant_type: "refresh_token", client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: "ref-1" });
    let row = await integration(t);
    expect(row).toMatchObject({ status: "connected", expiresAt: iso(NOW.getTime() + 86400_000), lastSyncAt: NOW.toISOString() });
    // Токены, сохранённые до шифрования, при обновлении записываются уже зашифрованными.
    expect(await tokensOf(row)).toEqual({ accessToken: "fresh-access", refreshToken: "ref-2", enc: true });
    expect(row!.refreshLeaseUntil).toBeUndefined();
    expect(await conversation(t, THIRD)).not.toBeNull();

    // Токену осталось 4 минуты — обновляем до запроса. Новый refresh не пришёл — храним прежний.
    await t.run((ctx) => ctx.db.patch(row!._id, { expiresAt: iso(NOW.getTime() + 4 * 60_000) }));
    olx.access = "fresh-access-2";
    olx.token = () => json(200, { access_token: "fresh-access-2", expires_in: 86400, token_type: "bearer" });
    const before = calls.length;
    await sync(t);
    expect(calls.slice(before, before + 2).map((c) => c.url.replace(/\?.*/, ""))).toEqual([TOKEN_URL, `${API}/threads`]);
    row = await integration(t);
    expect(await tokensOf(row)).toEqual({ accessToken: "fresh-access-2", refreshToken: "ref-2", enc: true });
  });

  test("invalid_grant при обновлении → «Нужно заново подключить OLX», одно уведомление владельцу, журнал; дальше опрос молчит", async () => {
    const { t, ids, owner, op } = await setup();
    await connect(t, ids.owner, { expiresAt: iso(NOW.getTime() - 60_000) });
    olx.token = () => oauthError(400, E5);
    const { conversationId } = await t.mutation(internal.inbox.ingest, { channel: "olx", externalId: THREAD, text: "Здравствуйте, актуально?", kind: "text", notify: false, autoLead: false });

    await sync(t);
    expect(calls.map((c) => c.url)).toEqual([TOKEN_URL]);
    const row = await integration(t);
    expect(row).toMatchObject({ status: "error", lastError: REAUTH });
    expect(row!.accessToken).toBeUndefined();
    expect(row!.refreshToken).toBeUndefined();
    const notes = await table(t, "notifications");
    expect(notes.map((n) => [n.userId, n.tone, n.link])).toEqual([[ids.owner, "bad", "/settings"]]);
    expect((await table(t, "audit")).map((a) => [a.action, a.actorName])).toEqual([["integration.expired", "OLX"]]);
    expect((await table(t, "systemStatus")).find((s) => s.key === "olx")?.error).toBe(REAUTH);

    // Повторные проходы не ходят в OLX и не пишут владельцу снова.
    await sync(t);
    await sync(t);
    expect(calls).toHaveLength(1);
    expect(await table(t, "notifications")).toHaveLength(1);
    // Ответить в OLX нельзя, пока не подключат заново.
    expect((await op.query(api.inbox.get, { id: conversationId }))!.replyBlock).toBe(REAUTH);
    await expect(op.mutation(api.inbox.reply, { conversationId, text: "Добрый день" })).rejects.toThrow(REAUTH);
    expect(await owner.query(api.channels.olx.settings, {})).toMatchObject({ status: "error", lastError: REAUTH });
  });

  test("403 CloudFront (HTML) → пауза 30 минут без падения, Request ID в ошибке; в паузе в OLX не ходим; после — снова", async () => {
    const { t, ids, owner } = await setup();
    await connect(t, ids.owner);
    olx.list = cloudfront;
    await sync(t);

    let row = await integration(t);
    expect(row).toMatchObject({ status: "connected", backoffUntil: iso(NOW.getTime() + 30 * 60_000), backoffStep: 1 });
    expect(row!.lastError).toContain("CloudFront");
    expect(row!.lastError).toContain(CF_ID);
    expect(row!.syncLeaseUntil).toBeUndefined();
    expect((await table(t, "systemStatus")).find((s) => s.key === "olx")?.error).toContain("CloudFront");
    expect(await owner.query(api.channels.olx.settings, {})).toMatchObject({ pausedUntil: row!.backoffUntil });
    await expect(owner.mutation(api.channels.olx.syncNow, {})).rejects.toThrow("ограничил запросы");

    const before = calls.length;
    await sync(t);
    expect(calls.length).toBe(before);

    vi.setSystemTime(new Date(NOW.getTime() + 31 * 60_000));
    olx.list = undefined;
    await sync(t);
    expect(calls.length).toBeGreaterThan(before);
    row = await integration(t);
    expect(row!.backoffUntil).toBeUndefined();
    expect(row!.lastError).toBeUndefined();
    expect(await conversation(t, THREAD)).not.toBeNull();
  });

  test("не настроен, не подключён или отключён — синхронизация ничего не делает и в OLX не ходит", async () => {
    const { t, ids, owner } = await setup();
    await sync(t);
    expect(calls).toHaveLength(0);

    await connect(t, ids.owner);
    vi.stubEnv("OLX_CLIENT_ID", "");
    await sync(t);
    expect(calls).toHaveLength(0);
    vi.stubEnv("OLX_CLIENT_ID", CLIENT_ID);

    await owner.mutation(api.channels.olx.disconnect, {});
    const row = await integration(t);
    expect(row).toMatchObject({ status: "disconnected" });
    expect(row!.accessToken).toBeUndefined();
    expect(row!.refreshToken).toBeUndefined();
    expect((await table(t, "audit")).map((a) => [a.action, a.actorId])).toEqual([["integration.disconnected", ids.owner]]);
    await sync(t);
    expect(calls).toHaveLength(0);
    expect(await owner.query(api.channels.olx.settings, {})).toMatchObject({ status: "disconnected", configured: true });
    await expect(owner.mutation(api.channels.olx.syncNow, {})).rejects.toThrow("OLX не подключён");
  });
});

// ── Ответы и «прочитано» ─────────────────────────────────────────────────────

describe("ответы оператора и «прочитано»", () => {
  test("ответ уходит в тред (POST, JSON, Version, Bearer); uuid из ответа OLX — id сообщения; опрос не дублирует", async () => {
    const { t, ids, op } = await setup();
    only(THREAD);
    await connect(t, ids.owner);
    await sync(t);
    const conversationId = (await conversation(t, THREAD))!._id;

    const { messageId } = await op.mutation(api.inbox.reply, { conversationId, text: REPLY_TEXT });
    await drain(t);
    const [post] = calls.filter((c) => c.method === "POST" && c.url.endsWith("/messages"));
    expect(post!.url).toBe(`${API}/threads/${THREAD}/messages`);
    expect(post!.body).toEqual({ text: REPLY_TEXT });
    expect(post!.headers.get("content-type")).toBe("application/json");
    expect(post!.headers.get("version")).toBe("2.0");
    expect(post!.headers.get("authorization")).toBe(`Bearer ${ACCESS}`);
    const reply = await t.run((ctx) => ctx.db.get(messageId));
    expect(reply).toMatchObject({ status: "sent", externalId: `olx:${String((parse(F5).data as Rec).uuid)}`, authorId: ids.operator });

    // OLX вернёт наш ответ опросом — это то же сообщение, а не новое.
    await sync(t);
    expect(await messagesOf(t, conversationId)).toHaveLength(5);

    // В ответе на отправку нет id (формат OLX не подтверждён) — id берём из треда.
    olx.send = (key, body) => {
      accept(key, body);
      return json(200, {});
    };
    const second = await op.mutation(api.inbox.reply, { conversationId, text: "Мастер позвонит за 30 минут" });
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(second.messageId))).toMatchObject({ status: "sent", externalId: "olx:ff4ad82a-bf5f-40fc-8057-000000000001" });
    await sync(t);
    expect(await messagesOf(t, conversationId)).toHaveLength(6);

    // OLX отклонил текст — «не отправлено» с причиной по-русски; канал при этом исправен.
    olx.send = () => json(400, parse(E6));
    const third = await op.mutation(api.inbox.reply, { conversationId, text: "Тест" });
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(third.messageId))).toMatchObject({ status: "failed", error: "OLX не принимает пустое сообщение" });
    expect((await table(t, "systemStatus")).find((s) => s.key === "olx")?.error).toBeUndefined();
    // Длинный ответ OLX может отклонить — не пускаем заранее.
    await expect(op.mutation(api.inbox.reply, { conversationId, text: "а".repeat(2001) })).rejects.toThrow("не больше 2000 символов");
  });

  test("OLX принял ответ, но ответил 5xx — сообщение найдено в треде; id не узнали сразу — опрос узнаёт ответ по тексту, без дубля", async () => {
    const { t, ids, op } = await setup();
    only(THREAD);
    await connect(t, ids.owner);
    await sync(t);
    const conversationId = (await conversation(t, THREAD))!._id;

    // 502 после того, как OLX уже принял сообщение: повтор вслепую дал бы клиенту дубль — смотрим тред.
    olx.send = (key, body) => {
      accept(key, body);
      return new Response("<html><body>502 Bad Gateway</body></html>", { status: 502, headers: { "Content-Type": "text/html" } });
    };
    const first = await op.mutation(api.inbox.reply, { conversationId, text: REPLY_TEXT });
    await drain(t);
    expect(await t.run((ctx) => ctx.db.get(first.messageId))).toMatchObject({ status: "sent", externalId: `olx:${String((parse(F5).data as Rec).uuid)}` });
    expect((await integration(t))!.backoffUntil).toBeUndefined();

    // Ответ без id, а тред OLX в этот момент недоступен: сообщение «отправлено», id пока нет.
    olx.send = (key, body) => {
      accept(key, body);
      return json(200, {});
    };
    olx.failMessages = 1;
    const second = await op.mutation(api.inbox.reply, { conversationId, text: "Мастер позвонит за 30 минут до приезда" });
    await drain(t);
    const pending = await t.run((ctx) => ctx.db.get(second.messageId));
    expect(pending).toMatchObject({ status: "sent" });
    expect(pending!.externalId).toBeUndefined();

    // Опрос видит это сообщение в треде — это наш ответ, а не новое сообщение компании.
    await sync(t);
    expect(await messagesOf(t, conversationId)).toHaveLength(6);
    expect(await t.run((ctx) => ctx.db.get(second.messageId))).toMatchObject({ status: "sent", externalId: "olx:ff4ad82a-bf5f-40fc-8057-000000000001", authorId: ids.operator });
  });

  test("опрос записал ответ раньше, чем пришёл ответ OLX на отправку (текст изменён модерацией), — копия убирается, остаётся ответ оператора", async () => {
    const { t, ids, op } = await setup();
    only(THREAD);
    await connect(t, ids.owner);
    await sync(t);
    const conversationId = (await conversation(t, THREAD))!._id;

    const { messageId } = await op.mutation(api.inbox.reply, { conversationId, text: "Позвоните мне: 8 701 000 00 00" });
    // OLX уже принял ответ (вырезав номер), а опрос забрал его до того, как записался id из ответа на отправку.
    const echo = accept(THREAD, { text: "Позвоните мне: ***" });
    await sync(t);
    expect(await messagesOf(t, conversationId)).toHaveLength(6);
    olx.send = () => json(200, { data: echo });
    await drain(t);
    const msgs = await messagesOf(t, conversationId);
    expect(msgs).toHaveLength(5);
    expect(msgs.find((m) => m._id === messageId)).toMatchObject({ status: "sent", externalId: `olx:${String(echo.uuid)}`, authorId: ids.operator });
  });

  test("оператор открыл диалог OLX — тред отмечен прочитанным и на OLX, не чаще раза в минуту", async () => {
    const { t, ids, op } = await setup();
    only(THREAD);
    await connect(t, ids.owner);
    await sync(t);
    await drain(t);
    const conv = (await conversation(t, THREAD))!;
    expect(conv.unread).toBeGreaterThan(0);
    const base = Date.now();

    await op.mutation(api.inbox.markRead, { id: conv._id });
    await drain(t);
    const marks = () => calls.filter((c) => c.url.endsWith("/commands"));
    expect(marks()).toHaveLength(1);
    expect(marks()[0]).toMatchObject({ url: `${API}/threads/${THREAD}/commands`, method: "POST", body: { command: "mark-as-read" } });
    expect(marks()[0]!.headers.get("version")).toBe("2.0");
    expect((await conversation(t, THREAD))!.unread).toBe(0);

    // Через полминуты снова непрочитанное — в OLX не дёргаем: раз в минуту на тред.
    vi.setSystemTime(new Date(base + 30_000));
    await t.run((ctx) => ctx.db.patch(conv._id, { unread: 1 }));
    await op.mutation(api.inbox.markRead, { id: conv._id });
    await drain(t);
    expect(marks()).toHaveLength(1);

    vi.setSystemTime(new Date(base + 2 * 60_000));
    await t.run((ctx) => ctx.db.patch(conv._id, { unread: 1 }));
    await op.mutation(api.inbox.markRead, { id: conv._id });
    await drain(t);
    expect(marks()).toHaveLength(2);
  });
});
