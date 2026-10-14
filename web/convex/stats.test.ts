/// <reference types="vite/client" />
// Предрасчёт аналитики (ТЗ §26.6, §17.10, §23.4): очередь изменений → итоги дней и месяцев, полный пересчёт, область
// руководителя без денег, свой период и фильтры, повторные клиенты, отказы мастеров и счётчик заказов в работе.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { loadOf } from "./lib/load";
import { doneWithin, receivedWithin, sums } from "../src/data/analytics";
import { cashOf, dayEnd, dayStart, moneyOf, n, repeatOf, shiftDay, todayDay } from "../src/data/dailyStats";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const DAY = 86400_000;
const HOUR = 3600_000;
const iso = (t: number) => new Date(t).toISOString();
/** Полдень по Алматы дня d (YYYY-MM-DD). */
const noon = (d: string) => dayStart(d) + 12 * HOUR;

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const at = iso(Date.now() - 400 * DAY);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель Кондиционеров", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = (name: string, phone: string, categories: string[]) =>
      ctx.db.insert("executors", { tenantId: T, name, phone, city: "Алматы", categories, skills: [], available: true, rating: 4.7, reviews: 3, cooperation: "freelance", joinedAt: at });
    const exA = await ex("Асет Новиков", "77000000001", ["ac"]);
    const exB = await ex("Берик Сантехник", "77000000002", ["plumbing"]);
    const exC = await ex("Ержан Климат", "77000000003", ["ac"]);
    const userA = await ctx.db.insert("users", { name: "Асет Новиков", email: "77000000001", role: "executor", executorId: exA, tenantId: T, active: true });
    const userC = await ctx.db.insert("users", { name: "Ержан Климат", email: "77000000003", role: "executor", executorId: exC, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    const client2 = await ctx.db.insert("clients", { tenantId: T, name: "Второй Клиент", kind: "person", phone: "77071234568", city: "Астана", source: "site", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    return { owner, operator, manager, exA, exB, exC, userA, userC, client, client2 };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });
  let number = 3000;
  const mkOrder = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: ++number,
        clientId: ids.client,
        clientName: "Клиент Тест",
        clientPhone: "77071234567",
        source: "olx",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: iso(Date.now() + DAY),
        priority: "normal",
        status: "done",
        clientPrice: 20000,
        payoutMode: "fixed",
        payoutValue: 14000,
        payments: [],
        payoutPaid: false,
        executorId: ids.exA,
        createdAt: iso(Date.now() - HOUR),
        createdBy: ids.owner,
        doneAt: iso(Date.now() - HOUR),
        files: [],
        ...over,
      }),
    );
  const mkLead = (over: Partial<Doc<"leads">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("leads", {
        tenantId: T,
        number: ++number,
        clientId: ids.client,
        clientName: "Клиент Тест",
        clientPhone: "77071234567",
        source: "olx",
        serviceId: "ac-repair",
        city: "Алматы",
        description: "Описание",
        urgency: "normal",
        status: "new",
        operatorId: ids.operator,
        createdAt: iso(Date.now() - HOUR),
        ...over,
      }),
    );
  /** Показатели уже собраны — дальше работает только очередь (без полного пересчёта). */
  const built = () => t.run((ctx) => ctx.db.insert("statsState", { builtAt: iso(Date.now()) }));
  const flush = () => t.mutation(internal.stats.flush, {});
  const queue = () => t.run((ctx) => ctx.db.query("statsDirty").collect());
  /** Полный пересчёт: крон видит, что показатели ещё не собраны, и запускает цепочку шагов. */
  const rebuild = async () => {
    vi.useFakeTimers();
    await t.mutation(internal.stats.tick, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  };
  const today = todayDay();
  const report = (who: Id<"users">, from = shiftDay(today, -1), to = shiftDay(today, 1), f: { category?: string; source?: Doc<"orders">["source"]; city?: string } = {}) =>
    as(who).query(api.stats.report, { from, to, ...f });
  return { t, ids, as, mkOrder, mkLead, built, flush, queue, rebuild, report, today };
}

describe("очередь изменений → итоги дней", () => {
  test("смена статуса, оплата и возврат задним числом пересчитывают свои дни; цифры — как формулы по сырым заказам", async () => {
    const s = await setup();
    await s.built();
    const created = Date.now() - 10 * DAY;
    const id = await s.mkOrder({ status: "in_progress", doneAt: undefined, clientPrice: 30000, payoutValue: 18000, createdAt: iso(created) });
    // Вставка мимо мутаций в очередь не попадает — а любая правка через мутацию попадает.
    expect(await s.queue()).toHaveLength(0);
    await s.as(s.ids.owner).mutation(api.orders.changeStatus, { id, to: "done" });
    expect((await s.queue()).map((q) => [q.kind, q.ref])).toEqual([["order", id]]);
    await s.flush();
    expect(await s.queue()).toHaveLength(0);

    let r = await s.report(s.ids.owner);
    expect(r.money).toBe(true);
    expect(moneyOf(r.cur.t)).toMatchObject({ revenue: 30000, payouts: 18000, margin: 12000, count: 1 });
    expect(r.cur.executors).toEqual([expect.objectContaining({ id: s.ids.exA, c: expect.objectContaining({ done: 1, revenue: 30000 }) })]);

    await s.as(s.ids.owner).mutation(api.orders.addPayment, { id, amount: 30000, method: "kaspi" });
    const refundDay = shiftDay(s.today, -5);
    await s.as(s.ids.owner).mutation(api.finance.addRefund, { id, amount: 10000, method: "cash", at: iso(noon(refundDay)), reason: "Частично не сделали" });
    await s.flush();

    r = await s.report(s.ids.owner);
    expect(moneyOf(r.cur.t)).toMatchObject({ revenue: 20000, margin: 2000 });
    expect(cashOf(r.cur.t)).toEqual({ received: 30000, refunded: 0, net: 30000 });
    // Возврат задним числом — в свой день: тот день пересчитан, хотя заказ сдан сегодня.
    const back = await s.report(s.ids.owner, refundDay, refundDay);
    expect(cashOf(back.cur.t)).toEqual({ received: 0, refunded: 10000, net: -10000 });

    // Паритет с формулами по сырому срезу (metrics.analytics) за тот же период.
    const from = shiftDay(s.today, -12);
    const to = shiftDay(s.today, 1);
    const slice = await s.as(s.ids.owner).query(api.metrics.analytics, { from: iso(dayStart(from)) });
    const span = { from: dayStart(from), to: dayEnd(to) };
    const all = await s.report(s.ids.owner, from, to);
    expect(moneyOf(all.cur.t)).toEqual(sums(doneWithin(slice.orders, span)));
    expect(cashOf(all.cur.t)).toEqual(receivedWithin(slice.orders, span));
  });

  test("заявка: создание и конвертация попадают в воронку и к оператору", async () => {
    const s = await setup();
    await s.built();
    const created = await s.as(s.ids.operator).mutation(api.leads.create, {
      clientName: "Новый Клиент",
      phone: "+7 701 555 44 33",
      source: "whatsapp",
      serviceId: "ac-clean",
      city: "Алматы",
      description: "Почистить кондиционер",
      urgency: "normal",
    });
    await s.flush();
    let r = await s.report(s.ids.owner);
    expect(r.cur.t).toMatchObject({ leads: 1 });
    expect(r.cur.t.withOrder).toBeUndefined();
    await s.as(s.ids.operator).mutation(api.leads.convert, { id: created.id });
    await s.flush();
    r = await s.report(s.ids.owner);
    expect(r.cur.t).toMatchObject({ leads: 1, converted: 1, withOrder: 1, created: 1 });
    expect(r.cur.operators).toEqual([expect.objectContaining({ id: s.ids.operator, c: { leads: 1, converted: 1 } })]);
    expect(r.series.find((p) => p.period === s.today)?.t).toMatchObject({ leads: 1, created: 1 });
  });
});

describe("полный пересчёт", () => {
  test("первый запуск собирает всё по существующим данным, дни и месяцы; счётчики мастеров сверены", async () => {
    const s = await setup();
    const day = shiftDay(s.today, -40);
    for (let i = 0; i < 6; i++) {
      const lead = await s.mkLead({ status: "converted", createdAt: iso(noon(day) - HOUR) });
      const order = await s.mkOrder({ leadId: lead, createdAt: iso(noon(day)), doneAt: iso(noon(day) + HOUR), status: i % 2 ? "paid" : "done", payments: i % 2 ? [{ id: `p${i}`, amount: 20000, method: "cash", at: iso(noon(day) + 2 * HOUR) }] : [] });
      await s.t.run((ctx) => ctx.db.patch(lead, { orderId: order }));
    }
    await s.mkOrder({ status: "in_progress", doneAt: undefined, executorId: s.ids.exC });
    await s.mkLead({ status: "new", createdAt: iso(noon(s.today) - HOUR) });
    // Устаревший итог дня, за которым фактов нет (например, после восстановления копии), — пересчёт его обнуляет.
    const ghost = shiftDay(s.today, -20);
    await s.t.run((ctx) => ctx.db.insert("dailyStats", { grain: "day", period: ghost, category: "ac", source: "olx", city: "Алматы", t: { done: 5, revenue: 999 }, ex: [], op: [] }));
    await s.rebuild();
    expect(await s.t.run((ctx) => ctx.db.query("dailyStats").withIndex("by_period", (q) => q.eq("grain", "day").eq("period", ghost)).collect())).toEqual([]);
    const st = await s.as(s.ids.owner).query(api.stats.state, {});
    expect(st).toMatchObject({ rebuilding: false, pending: 0 });
    expect(st.builtAt).not.toBeNull();

    const r = await s.report(s.ids.owner, shiftDay(s.today, -60), s.today);
    expect(moneyOf(r.cur.t)).toMatchObject({ revenue: 120000, payouts: 84000, count: 6 });
    expect(r.cur.t).toMatchObject({ leads: 7, converted: 6, withOrder: 6, orderDone: 6, orderPaid: 3, received: 60000, created: 7 });
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.exC)))?.activeCount).toBe(1);
    // Месячные итоги: 12 месяцев сравнения совпадают с суммой дней.
    const months = await s.as(s.ids.owner).query(api.stats.months, {});
    expect(months).toHaveLength(12);
    expect(months.reduce((x, m) => x + n(m.t, "revenue"), 0)).toBe(120000);
    expect(months.reduce((x, m) => x + n(m.t, "leads"), 0)).toBe(7);
  });

  test("кнопка владельца: только владелец, запись в журнале, повтор во время пересчёта — отказ", async () => {
    const s = await setup();
    await expect(s.as(s.ids.operator).mutation(api.stats.rebuild, {})).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.manager).query(api.stats.state, {})).rejects.toThrow("Нет доступа");
    vi.useFakeTimers();
    await s.as(s.ids.owner).mutation(api.stats.rebuild, {});
    await expect(s.as(s.ids.owner).mutation(api.stats.rebuild, {})).rejects.toThrow("Пересчёт уже идёт");
    expect((await s.as(s.ids.owner).query(api.stats.state, {})).rebuilding).toBe(true);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await s.as(s.ids.owner).query(api.stats.state, {})).rebuilding).toBe(false);
    const journal = await s.t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.filter((a) => a.action === "system.statsRebuild")).toHaveLength(1);
  });
});

describe("кто что видит", () => {
  test("руководитель — только свои направления и без денег; оператор — без денег; мастер — нет доступа", async () => {
    const s = await setup();
    await s.built();
    const ac = await s.mkOrder({ status: "in_progress", doneAt: undefined, clientPrice: 50000, payoutValue: 30000 });
    const pl = await s.mkOrder({ status: "in_progress", doneAt: undefined, category: "plumbing", serviceId: "plumbing", executorId: s.ids.exB, clientPrice: 40000 });
    for (const id of [ac, pl]) await s.as(s.ids.owner).mutation(api.orders.changeStatus, { id, to: "done" });
    await s.flush();

    const own = await s.report(s.ids.owner);
    expect(n(own.cur.t, "done")).toBe(2);
    expect(n(own.cur.t, "revenue")).toBe(90000);

    const m = await s.report(s.ids.manager);
    expect(m.money).toBe(false);
    expect(n(m.cur.t, "done")).toBe(1);
    const moneyKeys = ["revenue", "payouts", "accruedPaid", "repeatRevenue", "received", "refunded", "paidOut"];
    const keys = [m.cur.t, m.prev, ...m.cur.sources.map((x) => x.t), ...m.cur.categories.map((x) => x.t), ...m.cur.executors.map((e) => e.c), ...m.series.map((p) => p.t)].flatMap((c) => Object.keys(c));
    for (const k of moneyKeys) expect(keys).not.toContain(k);
    expect(m.cur.categories.map((c) => c.category)).toEqual(["ac"]);
    expect(m.executors.map((e) => e.id).sort()).toEqual([s.ids.exA, s.ids.exC].sort());
    expect(m.cur.operators).toEqual([]);
    // Чужое направление фильтром не открыть.
    expect(n((await s.report(s.ids.manager, undefined, undefined, { category: "plumbing" })).cur.t, "done")).toBe(0);
    const mm = await s.as(s.ids.manager).query(api.stats.months, {});
    expect(mm.flatMap((x) => Object.keys(x.t)).some((k) => moneyKeys.includes(k))).toBe(false);
    expect(Object.keys(await s.as(s.ids.manager).query(api.stats.totals, { from: s.today, to: s.today }))).not.toContain("revenue");

    const op = await s.report(s.ids.operator);
    expect(op.money).toBe(false);
    expect(n(op.cur.t, "done")).toBe(2);
    expect(op.cur.t.revenue).toBeUndefined();

    await expect(s.report(s.ids.userA)).rejects.toThrow("Нет доступа");
    await expect(s.t.query(api.stats.report, { from: s.today, to: s.today })).rejects.toThrow("Нужно войти");
  });
});

describe("свой период и фильтры", () => {
  test("даты проверяются; длинный период — месячными итогами и рядом по месяцам, цифры те же, что по дням", async () => {
    const s = await setup();
    await expect(s.report(s.ids.owner, "2026-13-01", "2026-12-01")).rejects.toThrow("Неверная дата");
    await expect(s.report(s.ids.owner, "2026-02-30", "2026-03-01")).rejects.toThrow("Неверная дата");
    await expect(s.report(s.ids.owner, "2026-05-02", "2026-05-01")).rejects.toThrow("Начало периода позже");
    await expect(s.report(s.ids.owner, "2025-01-01", "2026-03-01")).rejects.toThrow("не длиннее");

    const days = [-150, -95, -61, -30, -2].map((d) => shiftDay(s.today, d));
    for (const d of days) await s.mkOrder({ createdAt: iso(noon(d)), doneAt: iso(noon(d) + HOUR), clientPrice: 10000, payoutValue: 6000 });
    await s.rebuild();

    const from = shiftDay(s.today, -170);
    const long = await s.report(s.ids.owner, from, s.today);
    expect(long.grain).toBe("month");
    expect(long.series[0]!.period).toBe(from.slice(0, 7));
    expect(moneyOf(long.cur.t)).toMatchObject({ revenue: 50000, count: 5 });
    expect(long.series.reduce((x, p) => x + n(p.t, "done"), 0)).toBe(5);
    // Прошлый период той же длины — сразу перед выбранным.
    expect(long.prevTo).toBe(shiftDay(from, -1));

    const short = await s.report(s.ids.owner, shiftDay(s.today, -31), s.today);
    expect(short.grain).toBe("day");
    expect(short.series).toHaveLength(32);
    expect(n(short.cur.t, "done")).toBe(2);
    expect(n(short.prev, "done")).toBe(1);
  });

  test("фильтры по городу, источнику и направлению", async () => {
    const s = await setup();
    await s.mkOrder({});
    await s.mkOrder({ city: "Астана", source: "site", clientId: s.ids.client2 });
    await s.mkOrder({ category: "plumbing", serviceId: "plumbing", executorId: s.ids.exB, source: "site" });
    await s.rebuild();
    const done = async (f: { category?: string; source?: Doc<"orders">["source"]; city?: string }) => n((await s.report(s.ids.owner, undefined, undefined, f)).cur.t, "done");
    expect(await done({})).toBe(3);
    expect(await done({ city: "Астана" })).toBe(1);
    expect(await done({ source: "site" })).toBe(2);
    expect(await done({ category: "plumbing" })).toBe(1);
    expect(await done({ category: "ac", source: "site" })).toBe(1);
    expect(await done({ category: "ac", city: "Алматы", source: "olx" })).toBe(1);
  });
});

describe("исполнители и клиенты", () => {
  test("повторные клиенты: второй заказ клиента — повторный, доля и выручка", async () => {
    const s = await setup();
    await s.mkOrder({ createdAt: iso(Date.now() - 20 * DAY), doneAt: iso(Date.now() - 19 * DAY), clientPrice: 15000 });
    await s.mkOrder({ clientPrice: 25000 });
    await s.mkOrder({ clientId: s.ids.client2, clientPrice: 30000 });
    await s.rebuild();
    const r = await s.report(s.ids.owner, shiftDay(s.today, -2), s.today);
    expect(repeatOf(r.cur.t)).toEqual({ orders: 1, share: 0.5, revenue: 25000, revenueShare: 25000 / 55000 });
  });

  test("отказ мастера засчитывается ему, время до взятия — от публикации", async () => {
    const s = await setup();
    await s.built();
    const id = await s.mkOrder({ status: "new", doneAt: undefined, executorId: undefined, clientPrice: 20000 });
    await s.as(s.ids.owner).mutation(api.orders.changeStatus, { id, to: "awaiting_executor" });
    await s.as(s.ids.userA).mutation(api.worker.take, { id });
    await s.as(s.ids.userA).mutation(api.worker.act, { id, action: "decline" });
    await s.as(s.ids.userC).mutation(api.worker.take, { id });
    await s.as(s.ids.userC).mutation(api.worker.act, { id, action: "start" });
    await s.as(s.ids.userC).mutation(api.worker.act, { id, action: "done" });
    await s.flush();
    const r = await s.report(s.ids.owner);
    const a = r.cur.executors.find((e) => e.id === s.ids.exA)!.c;
    const c = r.cur.executors.find((e) => e.id === s.ids.exC)!.c;
    expect(a).toEqual({ refusals: 1 });
    expect(c).toMatchObject({ done: 1, takeN: 1, workN: 1 });
    expect(n(c, "takeMs")).toBeGreaterThanOrEqual(0);
  });

  test("activeCount: назначение, переназначение, отказ, отмена — счётчик равен заказам в работе; подбор читает его", async () => {
    const s = await setup();
    const owner = s.as(s.ids.owner);
    const count = async (id: Id<"executors">) => {
      const [stored, real] = await s.t.run(async (ctx) => [(await ctx.db.get(id))?.activeCount, await loadOf(ctx, id)] as const);
      expect(stored ?? 0).toBe(real);
      return real;
    };
    const o1 = await s.mkOrder({ status: "awaiting_executor", doneAt: undefined, executorId: undefined });
    const o2 = await s.mkOrder({ status: "awaiting_executor", doneAt: undefined, executorId: undefined });
    await owner.mutation(api.orders.assign, { id: o1, executorId: s.ids.exA });
    expect(await count(s.ids.exA)).toBe(1);
    await owner.mutation(api.orders.assign, { id: o1, executorId: s.ids.exC });
    expect([await count(s.ids.exA), await count(s.ids.exC)]).toEqual([0, 1]);
    await s.as(s.ids.userA).mutation(api.worker.take, { id: o2 });
    expect(await count(s.ids.exA)).toBe(1);
    await s.as(s.ids.userA).mutation(api.worker.act, { id: o2, action: "decline" });
    expect(await count(s.ids.exA)).toBe(0);
    await owner.mutation(api.orders.changeStatus, { id: o1, to: "cancelled", reason: "Клиент передумал" });
    expect(await count(s.ids.exC)).toBe(0);

    // Мастер на лимите (счётчик) «Новый заказ» не получает — подбор не перебирает заказы, а читает activeCount.
    await s.t.run((ctx) => ctx.db.patch(s.ids.exA, { maxActiveOrders: 1, activeCount: 1 }));
    const o3 = await s.mkOrder({ status: "new", doneAt: undefined, executorId: undefined });
    const res = await owner.mutation(api.orders.changeStatus, { id: o3, to: "awaiting_executor" });
    expect(res?.notified).toBe(1);
    const notes = await s.t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.filter((x) => x.text.startsWith("Новый заказ")).map((x) => x.userId)).toEqual([s.ids.userC]);
  });
});
