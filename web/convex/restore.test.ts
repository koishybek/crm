/// <reference types="vite/client" />
// Восстановление из резервной копии (ТЗ п.20.10, п.26.5): копия одного деплоймента → пустой другой. Новые id
// со всеми ссылками, взаимные ссылки — вторым проходом, ссылки на отсутствующие файлы убираются, секретные
// таблицы не восстанавливаются, подключения — «подключить заново». Запись — только с ALLOW_SEED=1, обзор —
// без изменений; в базе уже есть данные — это видно до записи.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { parseBackup, prepareDoc, tableOrder, type BackupData } from "./lib/restorePlan";
import { surveyRestore, writeRestore, type AdminCaller } from "./lib/restoreRun";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const at = "2026-10-10T08:00:00.000Z";

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Деплоймент-источник с типичными связями и его ночная копия. */
async function sourceBackup(): Promise<{ data: BackupData; raw: unknown }> {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    const executor = await ctx.db.insert("executors", { tenantId: T, name: "Ерлан Мастер", phone: "77010000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 4.8, reviews: 3, cooperation: "freelance", joinedAt: at });
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@homemax.kz", role: "owner", tenantId: T, active: true });
    await ctx.db.insert("users", { name: "Ерлан Мастер", email: "77010000001", role: "executor", executorId: executor, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгуль", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 0, lastActivityAt: at });
    const photo = await ctx.storage.store(new Blob(["jpeg"], { type: "image/jpeg" }));
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Айгуль",
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
      executorId: executor,
      files: [{ id: "f1", name: "фото.jpg", kind: "image", storageId: photo }],
    });
    await ctx.db.insert("history", { orderId: order, kind: "status", text: "Статус изменён", actor: { type: "user", id: owner }, at });
    await ctx.db.insert("audit", { tenantId: T, at, actorId: owner, actorName: "Владелец", action: "order.paid", entity: "order", entityId: order, summary: "Оплата" });
    await ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77071234567", to: "77273450000", status: "completed", startedAt: at, clientId: client, recordingId: await ctx.storage.store(new Blob(["mp3"])) });
    await ctx.db.insert("settings", { key: "autoAssign.minutes", value: "25" });
    await ctx.db.insert("integrations", { provider: "olx", status: "connected", accountName: "Home Max", accessToken: "SECRET" });
    await ctx.db.insert("apiKeys", { name: "Сайт", prefix: "hms_ab12", hash: "HASH", createdAt: at, createdBy: owner });
  });
  await t.action(internal.backup.run, {});
  const raw = await t.run(async (ctx) => {
    const row = (await ctx.db.query("backups").first())!;
    return JSON.parse(await (await ctx.storage.get(row.fileId))!.text()) as unknown;
  });
  return { data: parseBackup(raw), raw };
}

function target() {
  const t = convexTest(schema, modules);
  // convex-test принимает аргументы остатком (...args) — в обёртке типы аргументов уже проверены AdminCaller.
  type Loose = (fn: unknown, args: unknown) => Promise<never>;
  const caller: AdminCaller = { query: (fn, a) => (t.query as Loose)(fn, a), mutation: (fn, a) => (t.mutation as Loose)(fn, a), action: (fn, a) => (t.action as Loose)(fn, a) };
  return { t, caller };
}

describe("восстановление в пустой деплоймент", () => {
  test("обзор ничего не меняет: порядок таблиц, что не восстанавливается, каких файлов нет", async () => {
    const { data } = await sourceBackup();
    const { t, caller } = target();
    const s = await surveyRestore(caller, data);
    const order = s.order.map((o) => o.table);
    expect(order.indexOf("executors")).toBeLessThan(order.indexOf("users"));
    expect(order.indexOf("clients")).toBeLessThan(order.indexOf("orders"));
    expect(order.indexOf("orders")).toBeLessThan(order.indexOf("history"));
    expect(s.notRestored.map((n) => n.table)).toEqual(["apiKeys"]);
    expect(s.merged.map((m) => m.table).sort()).toEqual(["integrations", "settings"]);
    expect(s.files).toEqual({ total: 2, present: 0 });
    expect(s.occupied).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("orders").collect())).toEqual([]);
  });

  test("без ALLOW_SEED=1 запись отказывает", async () => {
    const { data } = await sourceBackup();
    const { caller } = target();
    await expect(writeRestore(caller, data, await surveyRestore(caller, data))).rejects.toThrow("ALLOW_SEED");
  });

  test("все связи на месте с новыми id; ссылки на отсутствующие файлы убраны; подключения — заново; итог в журнале", async () => {
    vi.stubEnv("ALLOW_SEED", "1");
    const { data } = await sourceBackup();
    const { t, caller } = target();
    const r = await writeRestore(caller, data, await surveyRestore(caller, data));
    expect(r.docs).toBe(8);

    const db = await t.run(async (ctx) => ({
      users: await ctx.db.query("users").collect(),
      executors: await ctx.db.query("executors").collect(),
      clients: await ctx.db.query("clients").collect(),
      orders: await ctx.db.query("orders").collect(),
      history: await ctx.db.query("history").collect(),
      audit: await ctx.db.query("audit").collect(),
      calls: await ctx.db.query("calls").collect(),
      settings: await ctx.db.query("settings").collect(),
      integrations: await ctx.db.query("integrations").collect(),
      apiKeys: await ctx.db.query("apiKeys").collect(),
    }));
    const order = db.orders[0]!;
    const owner = db.users.find((u) => u.role === "owner")!;
    expect(order.clientId).toBe(db.clients[0]!._id);
    expect(order.executorId).toBe(db.executors[0]!._id);
    expect(order.createdBy).toBe(owner._id);
    expect(db.users.find((u) => u.role === "executor")?.executorId).toBe(db.executors[0]!._id);
    expect(db.history[0]).toMatchObject({ orderId: order._id, actor: { type: "user", id: owner._id } });
    expect(db.audit.find((a) => a.action === "order.paid")).toMatchObject({ entityId: order._id, actorId: owner._id });
    // Файлов в этом хранилище нет — ссылки убраны, сама запись о файле осталась.
    expect(order.files).toEqual([{ id: "f1", name: "фото.jpg", kind: "image" }]);
    expect(db.calls[0]?.recordingId).toBeUndefined();
    expect(db.calls[0]?.clientId).toBe(db.clients[0]!._id);
    expect(db.settings).toEqual([expect.objectContaining({ key: "autoAssign.minutes", value: "25" })]);
    expect(db.integrations[0]).toMatchObject({ provider: "olx", status: "disconnected", accountName: "Home Max" });
    expect(db.integrations[0]?.accessToken).toBeUndefined();
    expect(db.apiKeys).toEqual([]);
    expect(db.audit.find((a) => a.action === "system.restored")?.summary).toContain("8 записей, файлов не найдено: 2");

    // Повторно: база уже не пустая — это видно до записи.
    expect((await surveyRestore(caller, data)).occupied).toEqual(expect.arrayContaining(["users", "orders", "clients"]));
  });

  test("вход владельца: только владелец из копии и пароль по правилам владельца", async () => {
    vi.stubEnv("ALLOW_SEED", "1");
    const { data } = await sourceBackup();
    const { t, caller } = target();
    await writeRestore(caller, data, await surveyRestore(caller, data));
    await expect(t.action(internal.restore.ownerLogin, { login: "77010000001", password: "Очень-длинный-пароль-1" })).rejects.toThrow("Владельца с таким логином");
    await expect(t.action(internal.restore.ownerLogin, { login: "owner@homemax.kz", password: "короткий" })).rejects.toThrow();
  });
});

describe("план восстановления", () => {
  test("взаимные ссылки таблиц: поле со ссылкой на ещё не вставленный документ откладывается", () => {
    const data: BackupData = {
      version: 2,
      createdAt: at,
      files: [],
      tables: { a: [{ _id: "a1", _creationTime: 1, b: "b1", name: "A" }], b: [{ _id: "b1", _creationTime: 1, a: "a1" }] },
    };
    const order = tableOrder(data, ["a", "b"]);
    expect(order).toHaveLength(2);
    const ids = new Map([
      ["a1", "a"],
      ["b1", "b"],
    ]);
    const first = prepareDoc(data.tables[order[0]!]![0]!, new Map(), ids, new Set());
    expect(Object.keys(first.deferred)).toHaveLength(1);
    expect(first.fields).not.toHaveProperty("_id");
    expect(first.fields).not.toHaveProperty("_creationTime");
    const second = prepareDoc(data.tables[order[1]!]![0]!, new Map([[order[0] === "a" ? "a1" : "b1", "new-1"]]), ids, new Set());
    expect(second.deferred).toEqual({});
    expect(Object.values(second.fields)).toContain("new-1");
  });

  test("копия версии 1 (без описи) — опись собирается по документам; чужой файл — понятная ошибка", () => {
    const v1 = parseBackup({ version: 1, createdAt: at, tables: { calls: [{ _id: "c1", recordingId: "s1" }] } });
    expect(v1.files).toEqual([{ storageId: "s1", table: "calls", docId: "c1", about: "Запись звонка" }]);
    expect(() => parseBackup({ hello: 1 })).toThrow("не файл резервной копии");
    expect(() => parseBackup({ version: 9, tables: {} })).toThrow("не поддерживается");
    expect(() => parseBackup({ version: 2, tables: { orders: [{ number: 1 }] } })).toThrow("повреждена");
  });
});
