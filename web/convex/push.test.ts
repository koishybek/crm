/// <reference types="vite/client" />
// Уведомления на телефон (ТЗ п.23.6): шифрование по RFC 8291 на тест-векторе, VAPID-подпись (RFC 8292),
// подписка и отписка, notify → push, подписка, которую push-сервис больше не знает (404/410), удаляется.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { notify } from "./lib/domain";
import { b64url, encryptPush, fromB64url, importSenderKeys, isPushEndpoint } from "./lib/webpush";
import { APP_NAME } from "../src/data/catalog";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const b = (s: string) => fromB64url(s)!;
const utf8 = new TextEncoder();

describe("шифрование web push — тест-вектор RFC 8291 (приложение A)", () => {
  test("тело совпадает с RFC байт в байт", async () => {
    const keys = await importSenderKeys(b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), b("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"));
    const body = await encryptPush(utf8.encode("When I grow up, I want to be a watermelon"), b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"), b("BTBZMqHH6r4Tts7J_aSIgg"), {
      keys,
      salt: b("DGv6ra1nlYgDCS1FRnbzlw"),
    });
    expect(b64url(body)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
  });

  test("сервер ходит только к известным push-сервисам по https", () => {
    expect(isPushEndpoint("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    expect(isPushEndpoint("https://web.push.apple.com/QGx")).toBe(true);
    expect(isPushEndpoint("https://wns2-par02p.notify.windows.com/w/?token=x")).toBe(true);
    expect(isPushEndpoint("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
    expect(isPushEndpoint("https://fcm.googleapis.com:8443/x")).toBe(false);
    expect(isPushEndpoint("https://evil.test/fcm.googleapis.com")).toBe(false);
    expect(isPushEndpoint("https://169.254.169.254/latest")).toBe(false);
  });
});

// ── Браузер-заглушка: ключи подписки и расшифровка тем же алгоритмом через встроенный HKDF ──

interface Device {
  endpoint: string;
  p256dh: string;
  auth: string;
  privateKey: CryptoKey;
}

async function device(endpoint: string): Promise<Device> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { endpoint, p256dh: b64url(raw), auth: b64url(crypto.getRandomValues(new Uint8Array(16))), privateKey: pair.privateKey };
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

async function decrypt(d: Device, body: Uint8Array<ArrayBuffer>): Promise<unknown> {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, d.privateKey, 256));
  const info = new Uint8Array([...utf8.encode("WebPush: info\0"), ...b(d.p256dh), ...asPublic]);
  const ikm = await hkdf(b(d.auth), ecdh, info, 32);
  const cek = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, aes, cipher));
  expect(plain[plain.length - 1]).toBe(2);
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

type Sent = { url: string; headers: Headers; body: Uint8Array<ArrayBuffer> };
let sent: Sent[];
let status: Record<string, number>;
let vapidPublic: CryptoKey;
let vapidPublicB64 = "";

beforeEach(async () => {
  sent = [];
  status = {};
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  vapidPublic = pair.publicKey;
  vapidPublicB64 = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  vi.stubEnv("VAPID_PUBLIC_KEY", vapidPublicB64);
  vi.stubEnv("VAPID_PRIVATE_KEY", (await crypto.subtle.exportKey("jwk", pair.privateKey)).d!);
  vi.stubEnv("VAPID_SUBJECT", "mailto:admin@homemax.kz");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers), body: new Uint8Array(init?.body as Uint8Array<ArrayBuffer>) });
      return new Response(null, { status: status[String(url)] ?? 201 });
    }),
  );
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    worker: await ctx.db.insert("users", { name: "Мастер Ерлан", email: "77010000001", role: "executor", tenantId: "t-komfort", active: true }),
    operator: await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: "t-komfort", active: true }),
  }));
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const subs = () => t.run((ctx) => ctx.db.query("pushSubscriptions").collect());
  const flush = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  return { t, ids, as, subs, flush };
}

describe("подписка", () => {
  test("включить, проверить и выключить на этом устройстве; чужую подписку не выключить", async () => {
    const { t, ids, as, subs } = await setup();
    const d = await device("https://fcm.googleapis.com/fcm/send/dev-1");
    await expect(t.mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth })).rejects.toThrow("Нужно войти");
    await expect(as(ids.worker).mutation(api.push.subscribe, { endpoint: "https://evil.test/push", p256dh: d.p256dh, auth: d.auth })).rejects.toThrow("Этот браузер не поддерживается");
    await expect(as(ids.worker).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: "AAAA", auth: d.auth })).rejects.toThrow("неверную подписку");

    await as(ids.worker).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    expect(await as(ids.worker).query(api.push.state, { endpoint: d.endpoint })).toMatchObject({ configured: true, subscribed: true, publicKey: expect.any(String) });
    expect((await as(ids.operator).query(api.push.state, { endpoint: d.endpoint })).subscribed).toBe(false);

    await as(ids.operator).mutation(api.push.unsubscribe, { endpoint: d.endpoint });
    expect(await subs()).toHaveLength(1);
    await as(ids.worker).mutation(api.push.unsubscribe, { endpoint: d.endpoint });
    expect(await subs()).toHaveLength(0);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.map((a) => a.action)).toEqual(["user.pushOn", "user.pushOff"]);
  });

  test("тот же браузер после входа другого человека — подписка переходит к нему", async () => {
    const { ids, as, subs } = await setup();
    const d = await device("https://updates.push.services.mozilla.com/wpush/v2/dev-2");
    await as(ids.worker).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    await as(ids.operator).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    const rows = await subs();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(ids.operator);
  });

  test("без ключей VAPID — включить нельзя, переключатель скрыт", async () => {
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    const { ids, as } = await setup();
    const d = await device("https://fcm.googleapis.com/fcm/send/dev-3");
    expect(await as(ids.worker).query(api.push.state, {})).toEqual({ configured: false, subscribed: false });
    await expect(as(ids.worker).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth })).rejects.toThrow("ещё не настроены владельцем");
  });
});

describe("notify → push", () => {
  test("уведомление уходит зашифрованным на каждое устройство, с подписью VAPID; телефон расшифровывает текст и ссылку", async () => {
    const { t, ids, as, flush, subs } = await setup();
    const phone = await device("https://fcm.googleapis.com/fcm/send/phone");
    const laptop = await device("https://web.push.apple.com/laptop");
    for (const d of [phone, laptop]) await as(ids.worker).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });

    await t.run((ctx) => notify(ctx, [ids.worker], "Новый заказ №1024: ремонт кондиционера", { link: "/w/orders/abc" }));
    await flush();

    expect(sent.map((s) => s.url).sort()).toEqual([laptop.endpoint, phone.endpoint].sort());
    const toPhone = sent.find((s) => s.url === phone.endpoint)!;
    expect(toPhone.headers.get("content-encoding")).toBe("aes128gcm");
    expect(toPhone.headers.get("ttl")).toBe("86400");
    expect(await decrypt(phone, toPhone.body)).toEqual({ title: APP_NAME, body: "Новый заказ №1024: ремонт кондиционера", link: "/w/orders/abc" });
    // Текст уведомления не уходит открытым.
    expect(new TextDecoder().decode(toPhone.body)).not.toContain("1024");

    // Authorization: vapid t=<JWT ES256>, k=<публичный ключ>; aud — источник push-сервиса.
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(toPhone.headers.get("authorization") ?? "")!;
    expect(m[2]).toBe(vapidPublicB64);
    const [h, p, s] = m[1]!.split(".");
    expect(JSON.parse(new TextDecoder().decode(b(h!)))).toEqual({ typ: "JWT", alg: "ES256" });
    const claims = JSON.parse(new TextDecoder().decode(b(p!))) as { aud: string; exp: number; sub: string };
    expect(claims.aud).toBe("https://fcm.googleapis.com");
    expect(claims.sub).toBe("mailto:admin@homemax.kz");
    expect(claims.exp - Date.now() / 1000).toBeLessThanOrEqual(24 * 3600);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidPublic, b(s!), utf8.encode(`${h}.${p}`))).toBe(true);
    expect((await subs()).every((x) => x.lastOkAt)).toBe(true);
  });

  test("истёкшая подписка (404/410) удаляется, временный сбой (500) — нет", async () => {
    const { t, ids, as, flush, subs } = await setup();
    const gone = await device("https://fcm.googleapis.com/fcm/send/gone");
    const missing = await device("https://fcm.googleapis.com/fcm/send/missing");
    const flaky = await device("https://fcm.googleapis.com/fcm/send/flaky");
    for (const d of [gone, missing, flaky]) await as(ids.worker).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    status = { [gone.endpoint]: 410, [missing.endpoint]: 404, [flaky.endpoint]: 500 };
    await t.run((ctx) => notify(ctx, [ids.worker], "Заказ отменён"));
    await flush();
    expect(sent).toHaveLength(3);
    expect((await subs()).map((x) => x.endpoint)).toEqual([flaky.endpoint]);
  });

  test("без подписки и без ключей push не отправляется; отключённому — тоже", async () => {
    const { t, ids, as, flush } = await setup();
    await t.run((ctx) => notify(ctx, [ids.operator], "Новая заявка"));
    await flush();
    expect(sent).toHaveLength(0);

    const d = await device("https://fcm.googleapis.com/fcm/send/blocked");
    await as(ids.worker).mutation(api.push.subscribe, { endpoint: d.endpoint, p256dh: d.p256dh, auth: d.auth });
    await t.run((ctx) => ctx.db.patch(ids.worker, { active: false }));
    await t.run((ctx) => notify(ctx, [ids.worker], "Новый заказ"));
    await flush();
    expect(sent).toHaveLength(0);

    await t.run((ctx) => ctx.db.patch(ids.worker, { active: true }));
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    await t.run((ctx) => notify(ctx, [ids.worker], "Новый заказ"));
    await flush();
    expect(sent).toHaveLength(0);
  });
});
