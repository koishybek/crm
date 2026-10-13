/// <reference types="vite/client" />
// Резервные копии (ТЗ п.20, п.26): что попадает в копию, а что нет, сколько копий храним, кто и как часто может
// запустить копию вручную.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { KEEP_BACKUPS } from "./backup";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const at = new Date().toISOString();
const SECRETS = ["olx-access-SECRET", "olx-refresh-SECRET", "pbx-SECRET-value", "site-token-SECRET", "tg-link-SECRET", "apikey-hash-SECRET", "review-token-SECRET", "auth-password-SECRET"];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true, telegramLinkCode: "tg-link-SECRET" });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    await ctx.db.insert("authAccounts", { userId: owner, provider: "password", providerAccountId: "owner@test.kz", secret: "auth-password-SECRET" });
    await ctx.db.insert("authSessions", { userId: owner, expirationTime: Date.now() + 3_600_000 });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгуль Сапарова", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 0, lastActivityAt: at });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Айгуль Сапарова",
      clientPhone: "77071234567",
      source: "olx",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: at,
      priority: "normal",
      status: "done",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      createdAt: at,
      createdBy: owner,
      files: [],
    });
    await ctx.db.insert("integrations", { provider: "olx", status: "connected", accountName: "Home Max", accessToken: "olx-access-SECRET", refreshToken: "olx-refresh-SECRET" });
    await ctx.db.insert("settings", { key: "pbxSecret", value: "pbx-SECRET-value" });
    await ctx.db.insert("settings", { key: "site.webhookToken", value: "site-token-SECRET" });
    await ctx.db.insert("settings", { key: "autoAssign.minutes", value: "30" });
    await ctx.db.insert("apiKeys", { name: "Сайт", prefix: "hms_ab12", hash: "apikey-hash-SECRET", createdAt: at, createdBy: owner });
    await ctx.db.insert("reviewRequests", { token: "review-token-SECRET", orderId: order, createdAt: at, expiresAt: at });
    await ctx.db.insert("rateLimits", { key: "site:phone:77071234567", windowStart: Date.now(), count: 1 });
    await ctx.db.insert("oauthStates", { state: "oauth-state", provider: "olx", userId: owner, createdAt: at });
    await ctx.db.insert("notifications", { userId: owner, text: "Колокольчик", at, read: false, tone: "info" });
    return { owner, operator, client, order };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as };
}

type Snapshot = { version: number; createdAt: string; tables: Record<string, Record<string, unknown>[]> };

async function latestBackup(t: Awaited<ReturnType<typeof setup>>["t"]): Promise<{ raw: string; json: Snapshot; docs: number; size: number }> {
  return t.run(async (ctx) => {
    const row = (await ctx.db.query("backups").withIndex("by_at").order("desc").first())!;
    const raw = await (await ctx.storage.get(row.fileId))!.text();
    return { raw, json: JSON.parse(raw) as Snapshot, docs: row.docs, size: row.size };
  });
}

describe("резервная копия", () => {
  test("в копии — бизнес-данные; секретов, входа, лимитов и OAuth нет", async () => {
    const { t } = await setup();
    await t.action(internal.backup.run, {});
    const { raw, json, docs, size } = await latestBackup(t);

    expect(json.version).toBe(1);
    expect(Number.isNaN(Date.parse(json.createdAt))).toBe(false);
    expect(json.tables.clients?.[0]?.name).toBe("Айгуль Сапарова");
    expect(json.tables.orders?.[0]?.clientPrice).toBe(30000);
    expect(docs).toBe(Object.values(json.tables).reduce((s, rows) => s + rows.length, 0));
    expect(size).toBe(new TextEncoder().encode(raw).byteLength);

    const tables = Object.keys(json.tables);
    for (const skipped of ["authAccounts", "authSessions", "rateLimits", "oauthStates", "backups", "notifications", "systemStatus"]) expect(tables).not.toContain(skipped);
    expect(tables.some((x) => x.startsWith("auth"))).toBe(false);

    // Ни одно значение-секрет не попало в файл — ни как поле, ни как настройка.
    for (const secret of SECRETS) expect(raw).not.toContain(secret);
    expect(json.tables.integrations?.[0]).toMatchObject({ provider: "olx", accountName: "Home Max" });
    expect(json.tables.integrations?.[0]).not.toHaveProperty("accessToken");
    expect(json.tables.users?.find((u) => u.role === "owner")).not.toHaveProperty("telegramLinkCode");
    expect(json.tables.apiKeys?.[0]).toMatchObject({ prefix: "hms_ab12" });
    expect(json.tables.apiKeys?.[0]).not.toHaveProperty("hash");
    expect(json.tables.settings?.map((s) => s.key)).toEqual(["autoAssign.minutes"]);

    const status = await t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "backup")).unique());
    expect(status?.okAt).toBeDefined();
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((a) => a.action === "system.backupCreated")?.actorName).toBe("Система");
  });

  test(`храним ${KEEP_BACKUPS} последних: старая копия удаляется вместе с файлом`, async () => {
    const { t } = await setup();
    const old = await t.run(async (ctx) => {
      const files: Id<"_storage">[] = [];
      for (let day = 1; day <= KEEP_BACKUPS; day++) {
        const fileId = await ctx.storage.store(new Blob([`{"day":${day}}`], { type: "application/json" }));
        files.push(fileId);
        await ctx.db.insert("backups", { at: `2026-01-${String(day).padStart(2, "0")}T21:00:00.000Z`, fileId, size: 10, docs: 1 });
      }
      return files;
    });
    await t.action(internal.backup.run, {});
    const rows = await t.run((ctx) => ctx.db.query("backups").withIndex("by_at").collect());
    expect(rows).toHaveLength(KEEP_BACKUPS);
    expect(rows[0]!.at).toBe("2026-01-02T21:00:00.000Z");
    expect(rows.some((r) => r.fileId === old[0])).toBe(false);
    const stored = (id: Id<"_storage">) => t.run(async (ctx) => (await ctx.storage.get(id)) !== null);
    expect(await stored(old[0]!)).toBe(false);
    expect(await stored(old[1]!)).toBe(true);
  });

  test("сбой копии — красная отметка «Резервные копии» и запись в журнале", async () => {
    const { t, ids, as } = await setup();
    await t.mutation(internal.backup._failed, { reason: "нет места", manual: false });
    const list = await as(ids.owner).query(api.backup.list, {});
    expect(list.lastError?.text).toBe("Копия не создана: нет места");
    const status = await t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "backup")).unique());
    expect(status?.error).toBe("Копия не создана: нет места");
  });
});

describe("копия вручную и список копий — только владелец", () => {
  test("оператор не видит копии и не может их запускать", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.operator).query(api.backup.list, {})).rejects.toThrow("Нет доступа");
    await expect(as(ids.operator).mutation(api.backup.runNow, {})).rejects.toThrow("Нет доступа");
  });

  test("владелец запускает копию; повторно — не раньше чем через 10 минут", async () => {
    vi.useFakeTimers();
    vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
    const { t, ids, as } = await setup();
    await as(ids.owner).mutation(api.backup.runNow, {});
    await expect(as(ids.owner).mutation(api.backup.runNow, {})).rejects.toThrow("меньше 10 минут назад");
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const list = await as(ids.owner).query(api.backup.list, {});
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ manual: true });
    expect(list.items[0]!.docs).toBeGreaterThan(0);
    // Скачивание — по подписанной ссылке на 15 минут, с понятным именем файла (convex/files.ts).
    expect(list.items[0]!.url).toMatch(/^https:\/\/test\.convex\.site\/files\/\w+\?exp=\d+&name=homemax-backup-[\d-]+\.json&sig=[0-9a-f]{64}$/);

    vi.advanceTimersByTime(10 * 60_000 + 1);
    await as(ids.owner).mutation(api.backup.runNow, {});
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.filter((a) => a.action === "system.backupRequested")).toHaveLength(2);
  });
});
