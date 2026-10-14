/// <reference types="vite/client" />
// Провайдеры АТС (ТЗ п.19.1, п.22.1, п.5.7): Binotel, Zadarma, OnlinePBX — события на фикстурах в форме calls._ingest,
// проверка ключа и подписи, запись разговора по API провайдера, «Позвонить через АТС» (форма запросов) и запасной tel:.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { hmacHexBase64 } from "./lib/hmac";
import { md5Hex } from "./lib/md5";
import { zadarmaAuth } from "./lib/pbx/zadarma";
import { binotel } from "./lib/pbx/binotel";
import { onlinepbx } from "./lib/pbx/onlinepbx";
import type { WebhookInput } from "./lib/pbx/types";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const SITE = "https://test.convex.site";
const INTEGRATIONS_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const CLIENT = "77071234567";
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 1]);

type Seen = { url: string; method: string; headers: Headers; body: string };
let seen: Seen[] = [];
let routes: ((s: Seen) => Response | null)[] = [];

beforeEach(() => {
  seen = [];
  routes = [];
  vi.stubEnv("INTEGRATIONS_KEY", INTEGRATIONS_KEY);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const s: Seen = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
      seen.push(s);
      for (const r of routes) {
        const res = r(s);
        if (res) return res;
      }
      return new Response("not found", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => Response.json(body);
const audio = () => new Response(MP3, { headers: { "content-type": "audio/mpeg" } });

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true, pbxExtension: "101" });
    const noExt = await ctx.db.insert("users", { name: "Айгуль Оператор", email: "op2@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель", email: "mgr@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгерим", kind: "person", phone: CLIENT, city: "Алматы", source: "phone", tags: [], createdAt: new Date().toISOString(), ordersCount: 0, activeCount: 0, lastActivityAt: new Date().toISOString() });
    return { owner, operator, noExt, manager, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const connect = async (provider: "binotel" | "zadarma" | "onlinepbx", fields: Record<string, string>) => {
    await as(ids.owner).action(api.pbx.save, { provider, fields });
    return t.run(async (ctx) => (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "pbxSecret")).unique())!.value);
  };
  const post = (path: string, body: string, headers: Record<string, string> = {}) => t.fetch(path, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers } });
  const calls = () => t.run((ctx) => ctx.db.query("calls").collect());
  const flush = () => t.finishAllScheduledFunctions(() => {});
  const journal = () => t.run((ctx) => ctx.db.query("audit").collect());
  return { t, ids, as, connect, post, calls, flush, journal };
}

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("подписи и криптография провайдеров", () => {
  test("MD5 и HMAC-SHA1 — по эталонным векторам (RFC 1321, RFC 2202)", async () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890")).toBe("57edf4a22be3c955ac49da2e2107b67a");
    // Zadarma: base64 от hex-строки HMAC (как base64_encode(hash_hmac('sha1', …)) в PHP).
    expect(await hmacHexBase64("SHA-1", "Jefe", "what do ya want for nothing?")).toBe(btoa("effcdf6ae5eb2fa2d27416d5f184df9c259a7c79"));
  });

  test("Zadarma: подпись запроса — метод + параметры по алфавиту + md5(параметров)", async () => {
    const { query, authorization } = await zadarmaAuth({ key: "KEY1", secret: "SECRET1" }, "/v1/request/callback/", { to: "77071234567", from: "101" });
    expect(query).toBe("from=101&to=77071234567");
    const expected = await hmacHexBase64("SHA-1", "SECRET1", `/v1/request/callback/from=101&to=77071234567${md5Hex("from=101&to=77071234567")}`);
    expect(authorization).toBe(`KEY1:${expected}`);
  });
});

describe("Binotel", () => {
  const completed = (over: Record<string, string> = {}) =>
    form({
      requestType: "apiCallCompleted",
      attemptsCounter: "1",
      "callDetails[companyID]": "5531",
      "callDetails[generalCallID]": "2593512345",
      "callDetails[startTime]": String(Math.floor(Date.now() / 1000) - 300),
      "callDetails[callType]": "0",
      "callDetails[internalNumber]": "101",
      "callDetails[externalNumber]": "87071234567",
      "callDetails[waitsec]": "7",
      "callDetails[billsec]": "184",
      "callDetails[disposition]": "ANSWER",
      "callDetails[pbxNumberData][number]": "77273450000",
      ...over,
    });

  test("звонок завершён → разговор с клиентом, оператор по внутреннему номеру; запись — через stats/call-record в хранилище", async () => {
    const s = await setup();
    const key = await s.connect("binotel", { key: "bkey", secret: "bsecret", companyId: "5531" });
    routes.push((r) => (r.url === "https://api.binotel.com/api/4.0/stats/call-record.json" ? json({ status: "success", url: "https://cdn.binotel.example/rec/2593512345.mp3" }) : null));
    routes.push((r) => (r.url === "https://cdn.binotel.example/rec/2593512345.mp3" ? audio() : null));
    const res = await s.post(`/pbx/binotel?key=${key}`, completed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "success" });
    await s.flush();
    const [c] = await s.calls();
    expect(c).toMatchObject({ externalId: "2593512345", direction: "in", from: CLIENT, to: "77273450000", status: "completed", duration: 184, operatorId: s.ids.operator, clientId: s.ids.client });
    expect(c!.recordingId).toBeDefined();
    const rec = seen.find((x) => x.url.endsWith("stats/call-record.json"))!;
    expect(JSON.parse(rec.body)).toEqual({ generalCallID: "2593512345", key: "bkey", secret: "bsecret" });
  });

  test("без ответа — пропущенный, запись не запрашивается; чужая компания и неверный ключ — 403", async () => {
    const s = await setup();
    const key = await s.connect("binotel", { key: "bkey", secret: "bsecret", companyId: "5531" });
    expect((await s.post(`/pbx/binotel?key=${key}`, completed({ "callDetails[disposition]": "NOANSWER", "callDetails[billsec]": "0" }))).status).toBe(200);
    await s.flush();
    expect((await s.calls())[0]).toMatchObject({ status: "missed" });
    expect(seen.filter((x) => x.url.includes("call-record"))).toHaveLength(0);
    expect((await s.post(`/pbx/binotel?key=${key}`, completed({ "callDetails[companyID]": "9999", "callDetails[generalCallID]": "x2" }))).status).toBe(403);
    expect((await s.post(`/pbx/binotel?key=wrong`, completed({ "callDetails[generalCallID]": "x3" }))).status).toBe(403);
    expect((await s.post(`/pbx/binotel`, completed({ "callDetails[generalCallID]": "x4" }))).status).toBe(403);
    expect(await s.calls()).toHaveLength(1);
  });

  test("apiCallSettings — звонок поступил (всплывает карточка); PUSH answeredTheCall — разговор", async () => {
    const s = await setup();
    const key = await s.connect("binotel", { key: "bkey", secret: "bsecret" });
    await s.post(`/pbx/binotel?key=${key}`, form({ requestType: "apiCallSettings", generalCallID: "777", callType: "0", externalNumber: "87011112233", didNumber: "77273450000", companyID: "5531" }));
    expect((await s.calls())[0]).toMatchObject({ status: "ringing", from: "77011112233", direction: "in" });
    await s.post(`/pbx/binotel?key=${key}`, form({ requestType: "answeredTheCall", generalCallID: "777", internalNumber: "101", externalNumber: "87011112233" }));
    expect((await s.calls())[0]).toMatchObject({ status: "answered", operatorId: s.ids.operator });
  });

  test("провайдер в настройках другой — 409 и событие не принимается", async () => {
    const s = await setup();
    const key = await s.connect("zadarma", { key: "k", secret: "s" });
    expect((await s.post(`/pbx/binotel?key=${key}`, completed())).status).toBe(409);
    expect(await s.calls()).toHaveLength(0);
  });
});

describe("Zadarma", () => {
  const SECRET = "zsecret";
  const signed = async (fields: Record<string, string>, signedBy: string[]) => ({ body: form(fields), signature: await hmacHexBase64("SHA-1", SECRET, signedBy.map((k) => fields[k] ?? "").join("")) });

  test("проверка адреса zd_echo — ответ тем же значением, только с ключом АТС", async () => {
    const s = await setup();
    const key = await s.connect("zadarma", { key: "zkey", secret: SECRET });
    const ok = await s.t.fetch(`/pbx/zadarma?key=${key}&zd_echo=abc123`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("abc123");
    expect((await s.t.fetch(`/pbx/zadarma?zd_echo=abc123`)).status).toBe(403);
    expect((await s.t.fetch(`/pbx/zadarma?key=${key}&zd_echo=${encodeURIComponent("<script>")}`)).status).toBe(400);
  });

  test("NOTIFY_START → NOTIFY_ANSWER → NOTIFY_END по подписи; NOTIFY_RECORD — запись по /v1/pbx/record/request/", async () => {
    const s = await setup();
    const key = await s.connect("zadarma", { key: "zkey", secret: SECRET });
    routes.push((r) => (r.url.startsWith("https://api.zadarma.com/v1/pbx/record/request/") ? json({ status: "success", link: "https://api.zadarma.com/v1/pbx/record/download/abc/1.mp3", lifetime_till: "2026-10-14 12:00:00" }) : null));
    routes.push((r) => (r.url === "https://api.zadarma.com/v1/pbx/record/download/abc/1.mp3" ? audio() : null));
    const base = { call_start: "2026-10-14 10:00:00", pbx_call_id: "in_9a8b7c", caller_id: "+77071234567", called_did: "77273450000" };
    const start = await signed({ event: "NOTIFY_START", ...base }, ["caller_id", "called_did", "call_start"]);
    expect((await s.post(`/pbx/zadarma?key=${key}`, start.body, { Signature: start.signature })).status).toBe(200);
    expect((await s.calls())[0]).toMatchObject({ status: "ringing", externalId: "in_9a8b7c", from: CLIENT, clientId: s.ids.client });
    const answer = await signed({ event: "NOTIFY_ANSWER", caller_id: "+77071234567", destination: "101", call_start: base.call_start, pbx_call_id: base.pbx_call_id, internal: "101" }, ["caller_id", "destination", "call_start"]);
    expect((await s.post(`/pbx/zadarma?key=${key}`, answer.body, { Signature: answer.signature })).status).toBe(200);
    const end = await signed({ event: "NOTIFY_END", ...base, internal: "101", duration: "95", disposition: "answered", status_code: "16", is_recorded: "1", call_id_with_rec: "1697264400.1234" }, ["caller_id", "called_did", "call_start"]);
    expect((await s.post(`/pbx/zadarma?key=${key}`, end.body, { Signature: end.signature })).status).toBe(200);
    expect((await s.calls())[0]).toMatchObject({ status: "completed", duration: 95, operatorId: s.ids.operator });
    const rec = await signed({ event: "NOTIFY_RECORD", call_id_with_rec: "1697264400.1234", pbx_call_id: base.pbx_call_id }, ["pbx_call_id", "call_id_with_rec"]);
    expect((await s.post(`/pbx/zadarma?key=${key}`, rec.body, { Signature: rec.signature })).status).toBe(200);
    await s.flush();
    expect((await s.calls())[0]!.recordingId).toBeDefined();
    const req = seen.find((x) => x.url.startsWith("https://api.zadarma.com/v1/pbx/record/request/"))!;
    expect(req.url).toBe("https://api.zadarma.com/v1/pbx/record/request/?call_id=1697264400.1234");
    const { authorization } = await zadarmaAuth({ key: "zkey", secret: SECRET }, "/v1/pbx/record/request/", { call_id: "1697264400.1234" });
    expect(req.headers.get("authorization")).toBe(authorization);
  });

  test("неверная или пустая подпись — 403, звонка нет, отказ в журнале", async () => {
    const s = await setup();
    const key = await s.connect("zadarma", { key: "zkey", secret: SECRET });
    const fields = { event: "NOTIFY_START", call_start: "2026-10-14 10:00:00", pbx_call_id: "in_1", caller_id: "+77071234567", called_did: "77273450000" };
    const forged = await hmacHexBase64("SHA-1", "другой-секрет", `${fields.caller_id}${fields.called_did}${fields.call_start}`);
    expect((await s.post(`/pbx/zadarma?key=${key}`, form(fields), { Signature: forged })).status).toBe(403);
    expect((await s.post(`/pbx/zadarma?key=${key}`, form(fields))).status).toBe(403);
    // Подпись от других полей (подмена номера при той же подписи) — тоже отказ.
    const good = await signed(fields, ["caller_id", "called_did", "call_start"]);
    expect((await s.post(`/pbx/zadarma?key=${key}`, form({ ...fields, caller_id: "+77009998877" }), { Signature: good.signature })).status).toBe(403);
    expect(await s.calls()).toHaveLength(0);
    expect((await s.journal()).some((a) => a.action === "integration.pbxRejected")).toBe(true);
  });
});

describe("OnlinePBX", () => {
  test("call_start → call_end с download_url: запись скачивается по ссылке; чужой домен — 403; внутренние звонки — мимо", async () => {
    const s = await setup();
    const key = await s.connect("onlinepbx", { domain: "homemax.onpbx.ru", apiKey: "opkey" });
    routes.push((r) => (r.url === "https://records.onlinepbx.example/rec.mp3" ? audio() : null));
    const common = { domain: "homemax.onpbx.ru", direction: "inbound", uuid: "8090e90f-5b17", caller: "87071234567", callee: "101", from_domain: "", to_domain: "homemax.onpbx.ru", gateway: "77273450000" };
    expect((await s.post(`/pbx/onlinepbx?key=${key}`, form({ ...common, event: "call_start", date: String(Math.floor(Date.now() / 1000)) }))).status).toBe(200);
    expect((await s.calls())[0]).toMatchObject({ status: "ringing", from: CLIENT, operatorId: s.ids.operator });
    expect((await s.post(`/pbx/onlinepbx?key=${key}`, form({ ...common, event: "call_end", call_duration: "70", dialog_duration: "61", hangup_cause: "NORMAL_CLEARING", download_url: "https://records.onlinepbx.example/rec.mp3" }))).status).toBe(200);
    await s.flush();
    expect((await s.calls())[0]).toMatchObject({ status: "completed", duration: 61 });
    expect((await s.calls())[0]!.recordingId).toBeDefined();
    expect((await s.post(`/pbx/onlinepbx?key=${key}`, form({ ...common, uuid: "other", domain: "evil.onpbx.ru", event: "call_start" }))).status).toBe(403);
    expect((await s.post(`/pbx/onlinepbx?key=${key}`, form({ ...common, uuid: "local-1", direction: "local", event: "call_start" }))).status).toBe(200);
    expect(await s.calls()).toHaveLength(1);
  });

  test("разбор без сервера: исходящий без разговора — пропущенный, запись по uuid через API (без ссылки)", async () => {
    const input = (o: Record<string, string>): WebhookInput => ({ method: "POST", query: new URLSearchParams(), headers: new Headers(), body: form(o), contentType: "application/x-www-form-urlencoded" });
    const missed = await onlinepbx.parseWebhook(input({ event: "call_end", direction: "outbound", uuid: "u1", caller: "101", callee: "87071234567", dialog_duration: "0" }), { domain: "homemax.onpbx.ru" });
    expect(missed).toMatchObject({ ok: true, events: [{ event: "missed", direction: "out", to: "87071234567", operator: "101", duration: 0 }] });
    const talked = await onlinepbx.parseWebhook(input({ event: "call_end", direction: "outbound", uuid: "u2", caller: "101", callee: "87071234567", dialog_duration: "12" }), { domain: "homemax.onpbx.ru" });
    expect(talked).toMatchObject({ ok: true, recording: { externalId: "u2", ref: { kind: "id", id: "u2" } } });
    const other = await binotel.parseWebhook(input({ requestType: "somethingElse" }), {});
    expect(other).toMatchObject({ ok: true, events: [] });
  });
});

describe("«Позвонить через АТС»", () => {
  test("Binotel: POST calls/internal-number-to-external-number с ключами и внутренним номером; журнал без номера целиком", async () => {
    const s = await setup();
    await s.connect("binotel", { key: "bkey", secret: "bsecret" });
    routes.push((r) => (r.url.endsWith("calls/internal-number-to-external-number.json") ? json({ status: "success", generalCallID: "999" }) : null));
    expect(await s.as(s.ids.operator).query(api.pbx.dialState, {})).toEqual({ enabled: true, provider: "binotel" });
    const r = await s.as(s.ids.operator).action(api.calls.dial, { phone: "+7 (707) 123-45-67", clientId: s.ids.client });
    expect(r).toEqual({ mode: "pbx", provider: "binotel" });
    const req = seen.find((x) => x.url.includes("internal-number-to-external-number"))!;
    expect(req.method).toBe("POST");
    expect(JSON.parse(req.body)).toEqual({ internalNumber: "101", externalNumber: CLIENT, key: "bkey", secret: "bsecret" });
    const entry = (await s.journal()).find((a) => a.action === "call.dial")!;
    expect(entry.summary).toContain("…4567");
    expect(entry.summary).not.toContain(CLIENT);
  });

  test("Zadarma: GET /v1/request/callback/ с подписью; OnlinePBX: вход по ключу API, затем call/now с x-pbx-authentication", async () => {
    const s = await setup();
    await s.connect("zadarma", { key: "zkey", secret: "zsecret" });
    routes.push((r) => (r.url.startsWith("https://api.zadarma.com/v1/request/callback/") ? json({ status: "success", from: 101, to: 77071234567, time: 1 }) : null));
    expect(await s.as(s.ids.operator).action(api.calls.dial, { phone: CLIENT })).toEqual({ mode: "pbx", provider: "zadarma" });
    const z = seen.find((x) => x.url.startsWith("https://api.zadarma.com/v1/request/callback/"))!;
    expect(z.url).toBe("https://api.zadarma.com/v1/request/callback/?from=101&to=77071234567");
    expect(z.headers.get("authorization")).toBe((await zadarmaAuth({ key: "zkey", secret: "zsecret" }, "/v1/request/callback/", { from: "101", to: CLIENT })).authorization);

    await s.connect("onlinepbx", { domain: "homemax.onpbx.ru", apiKey: "opkey" });
    routes.push((r) => (r.url === "https://api2.onlinepbx.ru/homemax.onpbx.ru/auth.json" ? json({ status: "1", data: { key: "K", key_id: "ID", new: 0 } }) : null));
    routes.push((r) => (r.url === "https://api2.onlinepbx.ru/homemax.onpbx.ru/call/now.json" ? json({ status: "1", data: { uuid: "u-1" } }) : null));
    expect(await s.as(s.ids.operator).action(api.calls.dial, { phone: CLIENT })).toEqual({ mode: "pbx", provider: "onlinepbx" });
    const auth = seen.find((x) => x.url.endsWith("/auth.json"))!;
    expect(new URLSearchParams(auth.body).get("auth_key")).toBe("opkey");
    const call = seen.find((x) => x.url.endsWith("/call/now.json"))!;
    expect(call.headers.get("x-pbx-authentication")).toBe("ID:K");
    expect(Object.fromEntries(new URLSearchParams(call.body))).toEqual({ from: "101", to: CLIENT });
    // Сессия сохранена зашифрованной — следующий звонок без нового входа.
    await s.as(s.ids.operator).action(api.calls.dial, { phone: CLIENT });
    expect(seen.filter((x) => x.url.endsWith("/auth.json"))).toHaveLength(1);
    const session = await s.t.run(async (ctx) => (await ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "pbx.sessionKey")).unique())!.value);
    expect(session.startsWith("enc:v1:")).toBe(true);
  });

  test("запасной tel: — АТС не подключена, нет внутреннего номера или АТС отказала; руководителю — нет доступа", async () => {
    const s = await setup();
    expect(await s.as(s.ids.operator).action(api.calls.dial, { phone: CLIENT })).toMatchObject({ mode: "tel", href: `tel:+${CLIENT}` });
    await s.connect("binotel", { key: "bkey", secret: "bsecret" });
    expect(await s.as(s.ids.noExt).action(api.calls.dial, { phone: CLIENT })).toMatchObject({ mode: "tel", reason: expect.stringContaining("внутренний номер") });
    routes.push((r) => (r.url.includes("internal-number-to-external-number") ? json({ status: "error", code: "120", message: "Employee is offline" }) : null));
    const failed = await s.as(s.ids.operator).action(api.calls.dial, { phone: CLIENT });
    expect(failed).toMatchObject({ mode: "tel", reason: expect.stringContaining("Employee is offline") });
    await expect(s.as(s.ids.manager).action(api.calls.dial, { phone: CLIENT })).rejects.toThrow();
    await expect(s.as(s.ids.operator).action(api.calls.dial, { phone: "123" })).rejects.toThrow("Неверный номер");
  });
});

describe("настройки провайдера", () => {
  test("только владелец; секреты в базе зашифрованы и не отдаются; без INTEGRATIONS_KEY не сохраняются", async () => {
    const s = await setup();
    await expect(s.as(s.ids.operator).action(api.pbx.save, { provider: "binotel", fields: { key: "k", secret: "s" } })).rejects.toThrow("Нет доступа");
    await s.connect("binotel", { key: "bkey-plain", secret: "bsecret-plain", companyId: "5531" });
    const rows = await s.t.run((ctx) => ctx.db.query("settings").collect());
    expect(JSON.stringify(rows)).not.toContain("bsecret-plain");
    expect(JSON.stringify(rows)).not.toContain("bkey-plain");
    const view = await s.as(s.ids.owner).query(api.pbx.settings, {});
    expect(view).toMatchObject({ provider: "binotel", config: { companyId: "5531" }, hasSecrets: true, hasPbxSecret: true });
    expect(JSON.stringify(view)).not.toContain("bsecret-plain");
    // Тот же провайдер: секреты можно не вводить заново.
    await s.as(s.ids.owner).action(api.pbx.save, { provider: "binotel", fields: { companyId: "5532" } });
    routes.push((r) => (r.url.endsWith("stats/online-calls.json") ? json({ status: "success", callDetails: [] }) : null));
    expect(await s.as(s.ids.owner).action(api.pbx.check, {})).toContain("Binotel");
    expect(JSON.parse(seen.at(-1)!.body)).toMatchObject({ key: "bkey-plain", secret: "bsecret-plain" });
    vi.stubEnv("INTEGRATIONS_KEY", "");
    await expect(s.as(s.ids.owner).action(api.pbx.save, { provider: "zadarma", fields: { key: "k", secret: "s" } })).rejects.toThrow("INTEGRATIONS_KEY");
    await expect(s.as(s.ids.owner).action(api.pbx.save, { provider: "onlinepbx", fields: { domain: "evil.com", apiKey: "x" } })).rejects.toThrow("onpbx.ru");
  });

  test("внутренний номер: только цифры, один номер — один сотрудник, в журнале", async () => {
    const s = await setup();
    await expect(s.as(s.ids.owner).mutation(api.pbx.setExtension, { userId: s.ids.noExt, extension: "abc" })).rejects.toThrow("цифр");
    await expect(s.as(s.ids.owner).mutation(api.pbx.setExtension, { userId: s.ids.noExt, extension: "101" })).rejects.toThrow("уже у сотрудника");
    await expect(s.as(s.ids.operator).mutation(api.pbx.setExtension, { userId: s.ids.noExt, extension: "102" })).rejects.toThrow();
    await s.as(s.ids.owner).mutation(api.pbx.setExtension, { userId: s.ids.noExt, extension: "102" });
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.noExt)))!.pbxExtension).toBe("102");
    expect((await s.journal()).some((a) => a.action === "user.pbxExtension")).toBe(true);
  });
});
