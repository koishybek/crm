/// <reference types="vite/client" />
// Токены интеграций в базе — только зашифрованными (аудит E28, I-2): AES-GCM ключом INTEGRATIONS_KEY. Без ключа
// подключить OLX нельзя (понятная причина владельцу и в «Состоянии системы»), синхронизация не падает; токены,
// сохранённые до шифрования, работают; сменили ключ — доступ потерян и об этом сказано.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import F2 from "../test/fixtures/olx/F2.json?raw";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { integrationsKeyIssue, isSealed, openSecret, sealSecret, SecretBoxError } from "./lib/secretBox";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

/** 32 байта в base64 — два разных ключа и один слишком короткий (16 байт). */
const KEY_A = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const KEY_B = "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk=";
const KEY_SHORT = "BwcHBwcHBwcHBwcHBwcHBw==";
const SITE = "https://demo-123.convex.site";
const TOKEN_URL = "https://www.olx.kz/api/open/oauth/token";
const API = "https://www.olx.kz/api/partner";
const ACCESS = "olx-access-token-plain-0001";
const REFRESH = "olx-refresh-token-plain-0002";

type Call = { url: string; auth: string | null };
let calls: Call[] = [];

beforeEach(() => {
  calls = [];
  vi.stubEnv("OLX_CLIENT_ID", "200027");
  vi.stubEnv("OLX_CLIENT_SECRET", "secret-test");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("APP_URL", "https://app.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
      if (url === TOKEN_URL) return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 86400, token_type: "bearer", scope: "v2 read write" });
      if (url === `${API}/users/me`) return new Response(F2, { headers: { "Content-Type": "application/json" } });
      if (url.startsWith(`${API}/threads`)) return Response.json({ data: [] });
      throw new Error(`Неожиданный запрос: ${url}`);
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const owner = await t.run((ctx) => ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: "t-komfort", active: true }));
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, owner, as, ownerApi: as(owner) };
}

/** Владелец прошёл подключение на странице OLX: state из connectUrl → callback с кодом; первый проход синхронизации завершён. */
async function connectViaOlx(env: Awaited<ReturnType<typeof setup>>): Promise<Response> {
  const state = new URL(await env.ownerApi.mutation(api.channels.olx.connectUrl, {})).searchParams.get("state")!;
  const res = await env.t.fetch(`/olx/callback?code=CODE-1&state=${state}`, { method: "GET" });
  await env.t.finishInProgressScheduledFunctions();
  return res;
}
const row = (t: Awaited<ReturnType<typeof setup>>["t"]) => t.run((ctx) => ctx.db.query("integrations").first());

describe("шифрование секретов (lib/secretBox)", () => {
  test("круговой путь; каждый раз новый IV; поле, ключ и подмена проверяются; старый открытый текст читается", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", KEY_A);
    expect(integrationsKeyIssue()).toBeNull();
    const sealed = await sealSecret(ACCESS, "olx.accessToken");
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain(ACCESS);
    expect(await openSecret(sealed, "olx.accessToken")).toEqual({ value: ACCESS, legacy: false });
    expect(await sealSecret(ACCESS, "olx.accessToken")).not.toBe(sealed);

    const fails = async (p: Promise<unknown>, reason: "key" | "open") => {
      const e = await p.then(() => null, (x: unknown) => x);
      expect(e).toBeInstanceOf(SecretBoxError);
      expect((e as SecretBoxError).reason).toBe(reason);
    };
    // Шифртекст access-токена не подставить в поле refresh-токена; испорченный — не открывается.
    await fails(openSecret(sealed, "olx.refreshToken"), "open");
    const i = sealed.length - 5;
    await fails(openSecret(`${sealed.slice(0, i)}${sealed[i] === "A" ? "B" : "A"}${sealed.slice(i + 1)}`, "olx.accessToken"), "open");
    // Сохранено до шифрования — работает как есть.
    expect(await openSecret("plain-old-token", "olx.accessToken")).toEqual({ value: "plain-old-token", legacy: true });

    vi.stubEnv("INTEGRATIONS_KEY", KEY_B);
    await fails(openSecret(sealed, "olx.accessToken"), "open");
    vi.stubEnv("INTEGRATIONS_KEY", KEY_SHORT);
    expect(integrationsKeyIssue()).toContain("неверно");
    await fails(sealSecret(ACCESS, "olx.accessToken"), "key");
    vi.stubEnv("INTEGRATIONS_KEY", "");
    expect(integrationsKeyIssue()).toContain("Не задан ключ шифрования INTEGRATIONS_KEY");
    await fails(sealSecret(ACCESS, "olx.accessToken"), "key");
  });
});

describe("OLX: токены в базе", () => {
  test("подключение: в базе только шифртекст; синхронизация расшифровывает токен и идёт с ним в OLX", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", KEY_A);
    const env = await setup();
    expect((await connectViaOlx(env)).headers.get("location")).toBe("https://app.test/settings?olx=connected");
    const r = (await row(env.t))!;
    expect(r.status).toBe("connected");
    expect(isSealed(r.accessToken!) && isSealed(r.refreshToken!)).toBe(true);
    const stored = JSON.stringify(r);
    expect(stored).not.toContain(ACCESS);
    expect(stored).not.toContain(REFRESH);
    expect((await openSecret(r.accessToken!, "olx.accessToken")).value).toBe(ACCESS);
    expect((await openSecret(r.refreshToken!, "olx.refreshToken")).value).toBe(REFRESH);

    await env.t.action(internal.channels.olx.sync, {});
    // Проход после подключения запускается и сам (планировщик) — каждый запрос к OLX идёт с расшифрованным токеном.
    const auth = calls.filter((c) => c.url.startsWith(`${API}/threads`)).map((c) => c.auth);
    expect(auth.length).toBeGreaterThan(0);
    expect(new Set(auth)).toEqual(new Set([`Bearer ${ACCESS}`]));
  });

  test("без ключа: подключить нельзя — понятная причина владельцу, в карточке и в «Состоянии системы»; синхронизация молча ждёт", async () => {
    const env = await setup();
    await expect(env.ownerApi.mutation(api.channels.olx.connectUrl, {})).rejects.toThrow("INTEGRATIONS_KEY");
    const settings = await env.ownerApi.query(api.channels.olx.settings, {});
    expect(settings.keyIssue).toContain("INTEGRATIONS_KEY");
    let olx = (await env.ownerApi.query(api.health.overview, {})).subsystems.find((s) => s.key === "olx")!;
    expect(olx).toMatchObject({ configured: false });
    expect(olx.hint).toContain("INTEGRATIONS_KEY");

    // State, выданный ещё с ключом, — callback без ключа код не обменивает.
    await env.t.run((ctx) => ctx.db.insert("oauthStates", { state: "state-before-key-removed", provider: "olx", userId: env.owner, createdAt: new Date().toISOString() }));
    const back = await env.t.fetch("/olx/callback?code=CODE-1&state=state-before-key-removed", { method: "GET" });
    expect(back.headers.get("location")).toBe("https://app.test/settings?olx=error&reason=key");

    // Подключено раньше, ключ потом убрали: красный в мониторинге, синхронизация в OLX не ходит и токены не трогает.
    vi.stubEnv("INTEGRATIONS_KEY", KEY_A);
    const access = await sealSecret(ACCESS, "olx.accessToken");
    vi.stubEnv("INTEGRATIONS_KEY", "");
    await env.t.run((ctx) =>
      ctx.db.insert("integrations", { provider: "olx", status: "connected", accountId: "1", accountName: "HMS", accessToken: access, expiresAt: new Date(Date.now() + 86400_000).toISOString(), connectedBy: env.owner }),
    );
    olx = (await env.ownerApi.query(api.health.overview, {})).subsystems.find((s) => s.key === "olx")!;
    expect(olx.issue).toContain("INTEGRATIONS_KEY");
    await env.t.action(internal.channels.olx.sync, {});
    expect(calls).toHaveLength(0);
    expect((await row(env.t))?.accessToken).toBe(access);
  });

  test("ключ сменили — токены не расшифровываются: доступ потерян, токены стёрты, владельцу одно уведомление", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", KEY_A);
    const env = await setup();
    await connectViaOlx(env);
    vi.stubEnv("INTEGRATIONS_KEY", KEY_B);
    calls = [];
    await env.t.action(internal.channels.olx.sync, {});
    await env.t.action(internal.channels.olx.sync, {});
    expect(calls).toHaveLength(0);
    const r = (await row(env.t))!;
    expect(r).toMatchObject({ status: "error" });
    expect(r.lastError).toContain("INTEGRATIONS_KEY");
    expect(r.accessToken).toBeUndefined();
    expect(r.refreshToken).toBeUndefined();
    const notes = await env.t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.filter((n) => n.text.startsWith("OLX отключился"))).toHaveLength(1);
  });

  test("открытые токены база не принимает — даже от внутренней функции", async () => {
    vi.stubEnv("INTEGRATIONS_KEY", KEY_A);
    const env = await setup();
    await expect(
      env.t.mutation(internal.channels.olx._connect, { userId: env.owner, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: new Date().toISOString(), accountId: "1", accountName: "HMS" }),
    ).rejects.toThrow("не зашифрованы");
    await expect(env.t.mutation(internal.channels.olx._tokenRefreshed, { accessToken: ACCESS, expiresAt: new Date().toISOString() })).rejects.toThrow("не зашифрованы");
    expect(await row(env.t)).toBeNull();
  });
});
