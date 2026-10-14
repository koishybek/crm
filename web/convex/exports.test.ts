/// <reference types="vite/client" />
// Выгрузки CSV владельца (ТЗ п.26.9): только владелец, за период, постранично (больше одной страницы), защита от формул,
// UTF-8 с BOM, файл — по подписанной ссылке и только сутки, каждая выгрузка — в журнале без персональных данных.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { EXPORT_HEADERS } from "./lib/exportRows";
import { EXPORT_TTL_MS, exportFileName, exportRange } from "../src/data/exports";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const SITE = "https://test.convex.site";
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function setup() {
  vi.stubEnv("FILES_SIGNING_KEY", "test-files-signing-key");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: ["Фреон"], available: true, rating: 4.8, reviews: 3, cooperation: "freelance", joinedAt: "2026-01-15T00:00:00.000Z" });
    const exUser = await ctx.db.insert("users", { name: "Асет Мастеров", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const ex2 = await ctx.db.insert("executors", { tenantId: T, name: "Берик Без Входа", phone: "77000000002", city: "Астана", categories: ["plumbing"], skills: [], available: false, rating: 5, reviews: 0, cooperation: "staff", joinedAt: "2026-02-01T00:00:00.000Z" });
    const client = await ctx.db.insert("clients", { tenantId: T, name: '=HYPERLINK("https://evil.kz";"Жми")', kind: "person", phone: "77071112233", city: "Алматы", source: "olx", tags: [], createdAt: iso(now), ordersCount: 0, activeCount: 0, lastActivityAt: iso(now) });
    return { owner, operator, manager, ex, exUser, ex2, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  let number = 9000;
  const mkOrder = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: ++number,
        clientId: ids.client,
        clientName: '=HYPERLINK("https://evil.kz";"Жми")',
        clientPhone: "77071112233",
        source: "olx",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: iso(now - 4 * DAY),
        priority: "normal",
        status: "awaiting_payment",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 20000,
        payments: [],
        payoutPaid: false,
        executorId: ids.ex,
        createdAt: iso(now - 5 * DAY),
        createdBy: ids.owner,
        doneAt: iso(now - 4 * DAY),
        files: [],
        ...over,
      }),
    );
  const range = { from: iso(now - 10 * DAY), to: iso(now) };
  /** Скачать выгрузку по ссылке и разобрать CSV (ячейки в кавычках, «;», CRLF). */
  const download = async (url: string) => {
    expect(url.startsWith(`${SITE}/files/`)).toBe(true);
    const res = await t.fetch(url.slice(SITE.length));
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    const rows = text
      .replace(/^﻿/, "")
      .split("\r\n")
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"')));
    return { res, bytes, text, rows };
  };
  return { t, now, ids, as, mkOrder, range, download };
}

describe("выгрузки CSV", () => {
  test("заказы за период: только владелец, BOM, формулы обезврежены, деньги по формулам заказа, ссылка подписана", async () => {
    const s = await setup();
    const paid = await s.mkOrder({
      status: "paid",
      payments: [
        { id: "p1", amount: 30000, method: "kaspi", at: iso(s.now - 3 * DAY) },
        { id: "p2", amount: 5000, method: "cash", at: iso(s.now - 3 * DAY), voidedAt: iso(s.now - 2 * DAY), voidReason: "дубль" },
      ],
      refunds: [{ id: "r1", amount: 4000, method: "kaspi", at: iso(s.now - DAY), reason: "скидка", by: s.ids.owner }],
      payoutPaid: true,
      payoutPaidAt: iso(s.now - DAY),
    });
    const owed = await s.mkOrder({ payments: [{ id: "p3", amount: 10000, method: "card", at: iso(s.now - 2 * DAY) }] });
    // Вне периода — не попадает.
    await s.mkOrder({ createdAt: iso(s.now - 40 * DAY) });

    for (const who of [s.ids.operator, s.ids.manager, s.ids.exUser]) await expect(s.as(who).action(api.exports.create, { kind: "orders", ...s.range })).rejects.toThrow("Нет доступа");
    await expect(s.t.action(api.exports.create, { kind: "orders", ...s.range })).rejects.toThrow("Нужно войти");

    const r = await s.as(s.ids.owner).action(api.exports.create, { kind: "orders", ...s.range });
    expect(r).toMatchObject({ rows: 2, truncated: false, name: exportFileName("orders", s.range) });
    expect(r.url).toMatch(/\/files\/[^?]+\?exp=\d+&name=zakazy-.+\.csv&sig=[0-9a-f]{64}$/);
    const file = await s.download(r.url);
    expect([...file.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(file.res.headers.get("content-disposition")).toContain(`attachment; filename="${r.name}"`);
    expect(file.res.headers.get("cache-control")).toContain("private");
    expect(file.rows[0]).toEqual(EXPORT_HEADERS.orders);
    expect(file.rows).toHaveLength(3);
    const col = (name: string) => EXPORT_HEADERS.orders.indexOf(name);
    const [first, second] = [file.rows[1]!, file.rows[2]!];
    // Имя клиента с формулой открывается как текст.
    expect(first[col("Клиент")]).toBe(`'=HYPERLINK("https://evil.kz";"Жми")`);
    expect(file.text).not.toMatch(/;"=HYPERLINK/);
    const numbers = await s.t.run(async (ctx) => [(await ctx.db.get(paid))!.number, (await ctx.db.get(owed))!.number]);
    expect([first[col("Заказ")], second[col("Заказ")]]).toEqual(numbers.map(String));
    // Оплачено — без сторно, возврат отдельно; маржа = цена − выплата; долг — по debt().
    expect([first[col("Цена клиента")], first[col("Выплата исполнителю")], first[col("Маржа")], first[col("Оплачено")], first[col("Возвращено")], first[col("Долг клиента")]]).toEqual(["30000", "20000", "10000", "30000", "4000", "0"]);
    expect(first[col("Статус")]).toBe("Оплачен");
    expect(first[col("Выплата мастеру проведена")]).not.toBe("");
    expect([second[col("Оплачено")], second[col("Долг клиента")]]).toEqual(["10000", "20000"]);

    // Без подписи и с испорченной подписью — 403.
    const path = r.url.slice(SITE.length);
    expect((await s.t.fetch(path.split("?")[0]!)).status).toBe(403);
    expect((await s.t.fetch(path.replace(/sig=./, (m) => (m.endsWith("0") ? "sig=1" : "sig=0")))).status).toBe(403);

    // Выгрузка в журнале — что и за какой период, без персональных данных; файл живёт сутки.
    const rows = await s.t.run(async (ctx) => ({ audit: (await ctx.db.query("audit").collect()).filter((a) => a.action === "export.created"), exports: await ctx.db.query("exports").collect() }));
    expect(rows.audit).toHaveLength(1);
    expect(rows.audit[0]).toMatchObject({ entity: "export", actorId: s.ids.owner, meta: { kind: "orders", rows: 2, from: s.range.from, to: s.range.to } });
    expect(JSON.stringify(rows.audit[0])).not.toMatch(/HYPERLINK|77071112233|evil/);
    expect(rows.exports).toHaveLength(1);
    expect(Date.parse(rows.exports[0]!.expiresAt) - Date.parse(rows.exports[0]!.at)).toBeGreaterThanOrEqual(EXPORT_TTL_MS - 1000);
  });

  test("постранично: в файл попадают все записи периода, а не одна страница", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 230; i++) {
        await ctx.db.insert("leads", {
          tenantId: T,
          number: 100 + i,
          clientId: s.ids.client,
          clientName: "Клиент",
          clientPhone: "77071112233",
          source: i % 2 ? "phone" : "site",
          serviceId: "ac-repair",
          city: "Алматы",
          description: `Заявка ${i}`,
          urgency: "normal",
          status: "new",
          operatorId: s.ids.operator,
          createdAt: iso(s.now - 9 * DAY + i * 60_000),
        });
      }
    });
    const r = await s.as(s.ids.owner).action(api.exports.create, { kind: "leads", ...s.range });
    expect(r.rows).toBe(230);
    const file = await s.download(r.url);
    expect(file.rows).toHaveLength(231);
    expect(file.rows[1]![0]).toBe("100");
    expect(file.rows[230]![0]).toBe("329");
    expect(file.rows[1]![EXPORT_HEADERS.leads.indexOf("Оператор")]).toBe("Мадина Оператор");
  });

  test("оплаты и возвраты — по датам денег, со сторно; выплаты мастерам; исполнители с работой за период", async () => {
    const s = await setup();
    await s.mkOrder({
      createdAt: iso(s.now - 60 * DAY),
      doneAt: iso(s.now - 50 * DAY),
      status: "paid",
      // Оплата до периода не попадает, доплата и сторно в периоде — попадают.
      payments: [
        { id: "old", amount: 20000, method: "kaspi", at: iso(s.now - 50 * DAY) },
        { id: "late", amount: 10000, method: "cash", at: iso(s.now - 3 * DAY), note: "доплата", by: s.ids.operator },
        { id: "bad", amount: 7000, method: "card", at: iso(s.now - 2 * DAY), by: s.ids.operator, voidedAt: iso(s.now - DAY), voidedBy: s.ids.owner, voidReason: "ошибка" },
      ],
      refunds: [{ id: "back", amount: 3000, method: "kaspi", at: iso(s.now - DAY), reason: "скидка", by: s.ids.owner }],
      moneyAt: iso(s.now - DAY),
    });
    await s.mkOrder({ doneAt: iso(s.now - 2 * DAY), payoutValue: 15000 });
    await s.t.run((ctx) => ctx.db.insert("payouts", { tenantId: T, executorId: s.ids.ex, orderIds: [], orderNumbers: [9001, 9002], amount: 12000, method: "transfer", at: iso(s.now - DAY), by: s.ids.owner, note: "за неделю", createdAt: iso(s.now - DAY) }));

    const pay = await s.download((await s.as(s.ids.owner).action(api.exports.create, { kind: "payments", ...s.range })).url);
    const p = (name: string) => EXPORT_HEADERS.payments.indexOf(name);
    expect(pay.rows.slice(1).map((r) => [r[p("Операция")], r[p("Сумма")], r[p("Кто внёс")], r[p("Причина сторно")]])).toEqual([
      ["Оплата", "10000", "Мадина Оператор", ""],
      ["Оплата", "7000", "Мадина Оператор", "ошибка"],
      ["Возврат", "-3000", "Владелец", ""],
    ]);

    const payouts = await s.download((await s.as(s.ids.owner).action(api.exports.create, { kind: "payouts", ...s.range })).url);
    expect(payouts.rows[1]).toEqual([expect.any(String), "Асет Мастеров", "12000", "Перевод на счёт", "№9001, №9002", "за неделю", "Владелец", expect.any(String)]);

    const execs = await s.download((await s.as(s.ids.owner).action(api.exports.create, { kind: "executors", ...s.range })).url);
    expect(execs.rows[0]).toEqual(EXPORT_HEADERS.executors);
    // Все исполнители по алфавиту; у Асета в периоде — 1 сданный заказ (второй сдан 50 дней назад), начислено 15 000, выплачено 12 000.
    expect(execs.rows.slice(1).map((r) => [r[0], r[5], r[8], r[9], r[10], r[11], r[12], r[13]])).toEqual([
      ["Асет Мастеров", "на смене", "Фриланс", "15.01.2026", "есть", "1", "15000", "12000"],
      ["Берик Без Входа", "выходной", "В штате", "01.02.2026", "нет входа", "0", "0", "0"],
    ]);
  });

  test("журнал — с фильтрами экрана; звонки; уборка удаляет выгрузки старше суток вместе с файлом", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      const row = (over: Partial<Doc<"audit">>) => ctx.db.insert("audit", { tenantId: T, at: iso(s.now - DAY), actorName: "Мадина Оператор", actorId: s.ids.operator, actorRole: "operator", action: "order.status", entity: "order", summary: "Заказ №1: статус", ...over });
      await row({});
      await row({ entity: "client", action: "client.updated", summary: "Клиент Ёлкин: теги" });
      await row({ actorId: undefined, actorRole: undefined, actorName: "Система", summary: "Заказ №2: просрочен срок" });
      await ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77071112233", to: "77270000000", clientName: "Клиент", status: "completed", startedAt: iso(s.now - DAY), duration: 61, aiStatus: "done", ai: { summary: "+7 перезвонить", extracted: [], questions: [] } });
    });
    const audit = await s.download((await s.as(s.ids.owner).action(api.exports.create, { kind: "audit", ...s.range, entity: "order" })).url);
    expect(audit.rows.slice(1).map((r) => [r[1], r[2], r[4]])).toEqual([
      ["Мадина Оператор", "Оператор", "Заказ №1: статус"],
      ["Система", "автоматически", "Заказ №2: просрочен срок"],
    ]);
    const system = await s.download((await s.as(s.ids.owner).action(api.exports.create, { kind: "audit", ...s.range, actorId: "system", q: "ПРОСРОЧЕН" })).url);
    expect(system.rows.slice(1).map((r) => r[4])).toEqual(["Заказ №2: просрочен срок"]);
    const filtered = await s.t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((a) => a.action === "export.created").map((a) => a.meta as Record<string, unknown>));
    expect(filtered.map((m) => m.filtered)).toEqual([true, true]);
    expect(JSON.stringify(filtered)).not.toContain("ПРОСРОЧЕН");

    const calls = await s.download((await s.as(s.ids.owner).action(api.exports.create, { kind: "calls", ...s.range })).url);
    // Резюме, начинающееся с «+», — тоже текст, а не формула.
    expect(calls.rows[1]).toEqual([expect.any(String), "Входящий", "Завершён", "77071112233", "Клиент", "", "61", "", "", "'+7 перезвонить"]);

    // Через сутки уборка удаляет и строки выгрузок, и файлы.
    const files = await s.t.run(async (ctx) => (await ctx.db.query("exports").collect()).map((x) => x.fileId));
    expect(files).toHaveLength(3);
    vi.useFakeTimers();
    vi.setSystemTime(s.now + EXPORT_TTL_MS + 60_000);
    expect(await s.t.mutation(internal.exports.cleanup, {})).toEqual({ removed: 3 });
    expect(await s.t.run(async (ctx) => [await ctx.db.query("exports").collect(), await Promise.all(files.map((id) => ctx.storage.get(id)))])).toEqual([[], [null, null, null]]);
  });

  test("период и лимит: неверные даты — отказ, не чаще 30 выгрузок в час", async () => {
    const s = await setup();
    const owner = s.as(s.ids.owner);
    await expect(owner.action(api.exports.create, { kind: "orders", from: "вчера", to: s.range.to })).rejects.toThrow("Неверная дата");
    await expect(owner.action(api.exports.create, { kind: "orders", from: s.range.to, to: s.range.from })).rejects.toThrow("Начало периода позже конца");
    await s.t.run((ctx) => ctx.db.insert("rateLimits", { key: `export:${s.ids.owner}`, windowStart: Date.now(), count: 30 }));
    await expect(owner.action(api.exports.create, { kind: "orders", ...s.range })).rejects.toThrow("Слишком много выгрузок");
    expect(await s.t.run((ctx) => ctx.db.query("exports").collect())).toEqual([]);
  });

  test("период выгрузки по Алматы: месяцы, дни и свои даты", () => {
    const now = Date.parse("2026-03-10T20:30:00.000Z"); // 11 марта, 01:30 по Алматы
    expect(exportRange("month", now)).toEqual({ from: "2026-02-28T19:00:00.000Z", to: "2026-03-10T20:30:00.000Z" });
    expect(exportRange("prevMonth", now)).toEqual({ from: "2026-01-31T19:00:00.000Z", to: "2026-02-28T18:59:59.999Z" });
    expect(exportRange("30d", now)?.from).toBe("2026-02-09T19:00:00.000Z");
    expect(exportRange("year", now)?.from).toBe("2025-12-31T19:00:00.000Z");
    expect(exportRange("prevMonth", Date.parse("2026-01-05T06:00:00.000Z"))).toEqual({ from: "2025-11-30T19:00:00.000Z", to: "2025-12-31T18:59:59.999Z" });
    expect(exportRange("custom", now, { from: "2026-03-01", to: "2026-03-05" })).toEqual({ from: "2026-02-28T19:00:00.000Z", to: "2026-03-05T18:59:59.999Z" });
    expect(exportRange("custom", now, { from: "2026-03-05", to: "2026-03-01" })).toBeNull();
    expect(exportRange("custom", now, { from: "", to: "2026-03-01" })).toBeNull();
    expect(exportFileName("payments", { from: "2026-02-28T19:00:00.000Z", to: "2026-03-05T18:59:59.999Z" })).toBe("oplaty-2026-03-01_2026-03-05.csv");
  });
});
