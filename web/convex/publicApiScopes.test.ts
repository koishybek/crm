/// <reference types="vite/client" />
// Открытый API (ТЗ п.20.7, п.26.7, п.19.10): права ключей, справочник услуг, статус заказа без персональных данных
// и денег, описание OpenAPI 3.1.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { sha256Hex } from "./lib/crypto";
import { API_SCOPES } from "../src/data/apiScopes";
import { WEBHOOK_EVENTS } from "../src/data/webhookEvents";

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
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгерим Нурланова", kind: "person", phone: "77071234567", city: "Алматы", address: "ул. Абая, 1", source: "site", tags: [], createdAt: "2026-10-01T05:00:00.000Z", ordersCount: 1, activeCount: 1, lastActivityAt: "2026-10-01T05:00:00.000Z" });
    await ctx.db.insert("orders", {
      tenantId: T,
      number: 1042,
      clientId: client,
      clientName: "Айгерим Нурланова",
      clientPhone: "77071234567",
      source: "site",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит, код домофона 25",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: "2026-10-02T07:00:00.000Z",
      priority: "normal",
      status: "in_progress",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [{ id: "p1", amount: 10000, method: "kaspi", at: "2026-10-01T06:00:00.000Z" }],
      payoutPaid: false,
      createdAt: "2026-10-01T05:00:00.000Z",
      createdBy: owner,
      files: [],
    });
    return { owner, operator };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const newKey = (scopes?: string[]) => as(ids.owner).mutation(api.apiKeys.create, { name: "Партнёр", scopes });
  const get = (path: string, key: string) => t.fetch(path, { headers: { Authorization: `Bearer ${key}` } });
  return { t, ids, as, newKey, get };
}

describe("права ключей", () => {
  test("ключ без поля прав (создан раньше) — только заявки; новый ключ — только отмеченное", async () => {
    const s = await setup();
    const legacy = await s.newKey();
    // Как у ключей до появления прав: поля scopes в базе нет.
    await s.t.run((ctx) => ctx.db.patch(legacy.id, { scopes: undefined }));
    expect((await s.get("/api/v1/orders/1042", legacy.key)).status).toBe(403);
    expect((await s.get("/api/v1/services", legacy.key)).status).toBe(403);
    expect((await s.get("/api/v1/leads/999", legacy.key)).status).toBe(404);

    const reader = await s.newKey(["orders:read"]);
    const res = await s.get("/api/v1/leads/1042", reader.key);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toContain("leads:read");
    const post = await s.t.fetch("/api/v1/leads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${reader.key}` },
      body: JSON.stringify({ name: "Ерлан", phone: "+77014445566", description: "Течёт кран" }),
    });
    expect(post.status).toBe(403);
    expect(await s.t.run((ctx) => ctx.db.query("leads").collect())).toEqual([]);
    expect((await s.get("/api/v1/orders/1042", reader.key)).status).toBe(200);
  });

  test("права при создании: неизвестные отбрасываются, пустой набор — ошибка; в списке видны права", async () => {
    const s = await setup();
    await expect(s.newKey([])).rejects.toThrow("хотя бы одно право");
    await expect(s.newKey(["admin:all"])).rejects.toThrow("хотя бы одно право");
    const k = await s.newKey(["services:read", "services:read", "orders:read", "admin:all"]);
    const row = (await s.t.run((ctx) => ctx.db.get(k.id)))!;
    expect(row.scopes).toEqual(["services:read", "orders:read"]);
    expect(row.hash).toBe(sha256Hex(k.key));
    const { keys } = await s.as(s.ids.owner).query(api.apiKeys.list, {});
    expect(keys[0]!.scopes).toEqual(["services:read", "orders:read"]);
    await expect(s.as(s.ids.operator).mutation(api.apiKeys.create, { name: "x", scopes: ["orders:read"] })).rejects.toThrow();
  });
});

describe("новые эндпоинты", () => {
  test("GET /api/v1/orders/{number}: статус и даты — без клиента, адреса, описания и денег", async () => {
    const s = await setup();
    const k = await s.newKey(["orders:read"]);
    const res = await s.get("/api/v1/orders/1042", k.key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      number: 1042,
      status: "in_progress",
      statusLabel: expect.any(String),
      serviceId: "ac-repair",
      service: expect.any(String),
      category: "ac",
      city: "Алматы",
      createdAt: "2026-10-01T05:00:00.000Z",
      deadline: "2026-10-02T07:00:00.000Z",
    });
    expect(JSON.stringify(body)).not.toMatch(/Айгерим|7071234567|Абая|домофон|30000|21000|10000/);
    expect((await s.get("/api/v1/orders/77", k.key)).status).toBe(404);
    expect((await s.get("/api/v1/orders/abc", k.key)).status).toBe(400);
    expect((await s.t.fetch("/api/v1/orders/1042")).status).toBe(401);
  });

  test("GET /api/v1/services: справочник без цен по умолчанию; цены — если владелец включил", async () => {
    const s = await setup();
    const k = await s.newKey(["services:read"]);
    const first = (await (await s.get("/api/v1/services", k.key)).json()) as { categories: { id: string }[]; services: Record<string, unknown>[] };
    expect(first.categories.length).toBeGreaterThan(0);
    expect(first.services.length).toBeGreaterThan(0);
    expect(first.services.every((x) => !("priceMin" in x) && !("payoutPct" in x))).toBe(true);
    await expect(s.as(s.ids.operator).mutation(api.apiKeys.setServicePrices, { enabled: true })).rejects.toThrow();
    await s.as(s.ids.owner).mutation(api.apiKeys.setServicePrices, { enabled: true });
    expect((await s.as(s.ids.owner).query(api.apiKeys.list, {})).servicePrices).toBe(true);
    const priced = (await (await s.get("/api/v1/services", k.key)).json()) as { services: Record<string, unknown>[] };
    expect(priced.services.every((x) => typeof x.priceMin === "number" && typeof x.priceMax === "number" && !("payoutPct" in x))).toBe(true);
  });

  test("GET /api/v1/openapi.json: OpenAPI 3.1 без ключа — все пути, права и события вебхуков", async () => {
    const s = await setup();
    const res = await s.t.fetch("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown>; webhooks: Record<string, unknown>; components: { securitySchemes: { bearer: { description: string } } } };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths).sort()).toEqual(["/api/v1/leads", "/api/v1/leads/{number}", "/api/v1/openapi.json", "/api/v1/orders/{number}", "/api/v1/services"]);
    expect(Object.keys(doc.webhooks).sort()).toEqual([...WEBHOOK_EVENTS].sort());
    for (const scope of API_SCOPES) expect(JSON.stringify(doc.paths)).toContain(scope);
    expect(doc.components.securitySchemes.bearer.description).toContain("orders:read");
  });
});
