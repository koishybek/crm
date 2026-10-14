/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { safeEqual, sha256Hex } from "./lib/crypto";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, result: {} })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    return { owner, operator };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const newKey = async (name = "Сайт") => as(ids.owner).mutation(api.apiKeys.create, { name });
  return { t, ids, as, newKey };
}

type T_ = Awaited<ReturnType<typeof setup>>["t"];
const lead = (extra: Record<string, unknown> = {}) => ({ name: "Ерлан", phone: "+7 701 444 55 66", serviceId: "wm-repair", city: "Астана", description: "Не сливает воду", ...extra });
const postLead = (t: T_, key: string | null, body: unknown, headers: Record<string, string> = {}) =>
  t.fetch("/api/v1/leads", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
const getLead = (t: T_, key: string, number: number | string) => t.fetch(`/api/v1/leads/${number}`, { headers: { Authorization: `Bearer ${key}` } });

describe("SHA-256 и сравнение секретов", () => {
  test("проверочные векторы", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(sha256Hex("привет, мир")).toBe("7ae3c8e991627c58597ead5c7bea19821fa14354b33bb52cf1ed490d4d8aea86");
    expect(sha256Hex("Заявка 😀")).toBe("c26fbacf20179ad10c3574c02146670433007e909c2b0eade3ff8508306b2ef2");
    expect(sha256Hex("a".repeat(1000))).toBe("41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3");
    // Границы дополнения: 55, 56 и 64 байта.
    expect(sha256Hex("x".repeat(55))).toBe("d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072");
    expect(sha256Hex("y".repeat(56))).toBe("4877e564e5e36e367c7c8d59670774becd3350610b6df4c399c9fa9b66da5813");
    expect(sha256Hex("z".repeat(64))).toBe("72996563049cc84daa2c3f31fd5c3d10770e69d6ebbb8da5b6d76db303dbae43");
  });

  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("ключи API", () => {
  test("ключ показывается один раз: в базе — только хэш, в списке — начало ключа", async () => {
    const { t, as, ids, newKey } = await setup();
    const created = await newKey("Сайт компании");
    expect(created.key).toMatch(/^hms_[A-Za-z0-9_-]{43}$/);
    expect(created.prefix).toBe(created.key.slice(0, 8));
    const row = (await t.run((ctx) => ctx.db.get(created.id)))!;
    expect(row.hash).toBe(sha256Hex(created.key));
    expect(JSON.stringify(row)).not.toContain(created.key);
    const { keys } = await as(ids.owner).query(api.apiKeys.list, {});
    expect(keys).toEqual([{ id: created.id, name: "Сайт компании", prefix: created.prefix, createdAt: row.createdAt, createdBy: "Владелец", scopes: ["leads:write", "leads:read"] }]);
    expect(JSON.stringify(keys)).not.toContain(created.key);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    const entry = journal.find((x) => x.action === "integration.apiKey")!;
    expect(entry).toMatchObject({ actorId: ids.owner, entityId: created.id, meta: { prefix: created.prefix } });
    expect(JSON.stringify(entry)).not.toContain(created.key);
    await expect(as(ids.owner).mutation(api.apiKeys.create, { name: "   " })).rejects.toThrow("Назовите ключ");
  });

  test("оператор ключами не управляет", async () => {
    const { as, ids, newKey } = await setup();
    const { id } = await newKey();
    await expect(as(ids.operator).mutation(api.apiKeys.create, { name: "x" })).rejects.toThrow("Нет доступа");
    await expect(as(ids.operator).query(api.apiKeys.list, {})).rejects.toThrow("Нет доступа");
    await expect(as(ids.operator).mutation(api.apiKeys.revoke, { id })).rejects.toThrow("Нет доступа");
  });

  test("заявка по ключу: 201, источник по умолчанию «Сайт», в журнале — «API» с началом ключа, отметка использования", async () => {
    const { t, newKey } = await setup();
    const { key, prefix, id } = await newKey();
    const res = await postLead(t, key, lead());
    expect(res.status).toBe(201);
    const body = (await res.json()) as { number: number; id: string };
    const row = (await t.run((ctx) => ctx.db.get(body.id as Id<"leads">)))!;
    expect(row).toMatchObject({ number: body.number, source: "site", serviceId: "wm-repair", city: "Астана", clientPhone: "77014445566", clientName: "Ерлан" });
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    const entry = journal.find((x) => x.action === "lead.created")!;
    expect(entry).toMatchObject({ actorName: "API", entityId: body.id });
    expect(entry.meta).toMatchObject({ keyPrefix: prefix, source: "site" });
    expect((await t.run((ctx) => ctx.db.get(id)))!.lastUsedAt).toBeDefined();
    // Свой источник — из справочника источников.
    const olx = await postLead(t, key, lead({ phone: "+77015550001", source: "olx" }));
    expect(olx.status).toBe(201);
    expect((await t.run((ctx) => ctx.db.query("leads").collect())).map((l) => l.source).sort()).toEqual(["olx", "site"]);
  });

  test("идемпотентность: тот же externalId или Idempotency-Key — та же заявка, без дубля", async () => {
    const { t, newKey } = await setup();
    const { key } = await newKey();
    const first = (await (await postLead(t, key, lead({ externalId: "site-42" }))).json()) as { number: number };
    const again = await postLead(t, key, lead({ externalId: "site-42" }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { number: number }).number).toBe(first.number);
    const viaHeader = await postLead(t, key, lead({ phone: "+77015550002" }), { "Idempotency-Key": "req-7" });
    const viaHeaderAgain = await postLead(t, key, lead({ phone: "+77015550002" }), { "Idempotency-Key": "req-7" });
    expect(viaHeader.status).toBe(201);
    expect(viaHeaderAgain.status).toBe(200);
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(2);
  });

  test("без ключа, неверный и отозванный ключ — 401 в JSON", async () => {
    const { t, as, ids, newKey } = await setup();
    const { key, id } = await newKey();
    const none = await postLead(t, null, lead());
    expect(none.status).toBe(401);
    expect(((await none.json()) as { error: string }).error).toContain("Authorization");
    expect((await postLead(t, "hms_short", lead())).status).toBe(401);
    expect((await postLead(t, `hms_${"A".repeat(43)}`, lead())).status).toBe(401);
    await as(ids.owner).mutation(api.apiKeys.revoke, { id });
    const revoked = await postLead(t, key, lead());
    expect(revoked.status).toBe(401);
    expect(((await revoked.json()) as { error: string }).error).toBe("Неверный или отозванный ключ API");
    expect((await getLead(t, key, 1001)).status).toBe(401);
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
    const { keys } = await as(ids.owner).query(api.apiKeys.list, {});
    expect(keys[0]!.revokedAt).toBeDefined();
  });

  test("статус заявки: без персональных данных, только свои заявки ключа, виден заказ", async () => {
    const { t, newKey, as, ids } = await setup();
    const a = await newKey("Сайт");
    const b = await newKey("Партнёр");
    const { number, id } = (await (await postLead(t, a.key, lead())).json()) as { number: number; id: Id<"leads"> };
    const res = await getLead(t, a.key, number);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ number, status: "new", statusLabel: "Новая" });
    expect(Object.keys(body).sort()).toEqual(["createdAt", "number", "status", "statusLabel"]);
    expect(JSON.stringify(body)).not.toMatch(/Ерлан|77014445566|Не сливает/);
    expect((await getLead(t, b.key, number)).status).toBe(404);
    expect((await getLead(t, a.key, 999999)).status).toBe(404);
    expect((await getLead(t, a.key, "abc")).status).toBe(400);
    const order = await as(ids.operator).mutation(api.leads.convert, { id });
    const withOrder = (await (await getLead(t, a.key, number)).json()) as Record<string, unknown>;
    expect(withOrder).toMatchObject({ status: "converted", orderNumber: order.number, orderStatus: "new", orderStatusLabel: "Новый" });
  });

  test("проверка тела: телефон, источник, услуга, обязательные поля", async () => {
    const { t, newKey } = await setup();
    const { key } = await newKey();
    const cases: [Record<string, unknown>, string][] = [
      [{ phone: "+7 995 000 00 00" }, "phone"],
      [{ name: undefined }, "name"],
      [{ description: "" }, "description"],
      [{ source: "tiktok" }, "source"],
      [{ serviceId: "no-such-service" }, "serviceId"],
      [{ description: 123 }, "description"],
    ];
    for (const [patch, field] of cases) {
      const res = await postLead(t, key, lead(patch));
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(field);
    }
    const big = await postLead(t, key, lead({ description: "x".repeat(17_000) }));
    expect(big.status).toBe(413);
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
  });

  test("лимит 120 запросов в минуту на ключ — 429 с Retry-After", async () => {
    const { t, newKey } = await setup();
    const { key, id } = await newKey();
    await t.run((ctx) => ctx.db.insert("rateLimits", { key: `api:${id}`, windowStart: Date.now(), count: 120 }));
    const res = await postLead(t, key, lead());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
  });
});
