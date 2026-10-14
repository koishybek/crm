/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { audit } from "./lib/audit";
import { doneWithin, monthLabel, monthOf, operatorRows, recentMonths, sourceRows, sourceTotals, spendWithin, sums, type Span } from "../src/data/analytics";
import type { Lead, Order } from "../src/data/types";
import { money } from "../src/lib/format";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const DAY = 86400_000;
const HOUR = 3600_000;
const iso = (t: number) => new Date(t).toISOString();
/** Полночь по Алматы (UTC+5) даты y-m-d. */
const almaty = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) - 5 * HOUR;
const SEPTEMBER: Span = { from: almaty(2026, 9, 1), to: almaty(2026, 10, 1) - 1 };

async function setup() {
  const t = convexTest(schema, modules);
  const at = iso(Date.now());
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель Кондиционеров", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const exA = await ctx.db.insert("executors", { tenantId: T, name: "Асет Новиков", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const exB = await ctx.db.insert("executors", { tenantId: T, name: "Берик Сантехник", phone: "77000000002", city: "Алматы", categories: ["plumbing"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    return { owner, operator, manager, exA, exB, client };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });
  let number = 2000;
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
  return { t, ids, as, mkOrder, mkLead };
}

describe("расходы на рекламу", () => {
  test("вносит и видит только владелец: создать, обновить, обнулить; без изменений — без записи в журнале", async () => {
    const { t, ids, as } = await setup();
    const month = monthOf(Date.now());
    const items = [
      { source: "olx" as const, amount: 100000 },
      { source: "instagram" as const, amount: 50000 },
    ];
    await expect(as(ids.operator).mutation(api.analytics.setAdSpend, { month, items })).rejects.toThrow("Нет доступа");
    await expect(as(ids.manager).mutation(api.analytics.setAdSpend, { month, items })).rejects.toThrow("Нет доступа");
    await expect(as(ids.operator).query(api.analytics.adSpendMonth, { month })).rejects.toThrow("Нет доступа");
    await expect(t.mutation(api.analytics.setAdSpend, { month, items })).rejects.toThrow("Нужно войти");

    const owner = as(ids.owner);
    expect(await owner.mutation(api.analytics.setAdSpend, { month, items })).toEqual({ changed: 2 });
    expect(await owner.mutation(api.analytics.setAdSpend, { month, items: [{ source: "olx", amount: 120000 }, { source: "instagram", amount: 50000 }] })).toEqual({ changed: 1 });
    const rows = await owner.query(api.analytics.adSpendMonth, { month });
    expect(rows.map((r) => [r.source, r.amount]).sort()).toEqual([
      ["instagram", 50000],
      ["olx", 120000],
    ]);
    expect(await owner.mutation(api.analytics.setAdSpend, { month, items: [{ source: "instagram", amount: 0 }] })).toEqual({ changed: 1 });
    expect((await owner.query(api.analytics.adSpendMonth, { month })).map((r) => r.source)).toEqual(["olx"]);
    expect(await owner.mutation(api.analytics.setAdSpend, { month, items: [{ source: "olx", amount: 120000 }] })).toEqual({ changed: 0 });

    const journal = (await t.run((ctx) => ctx.db.query("audit").collect())).filter((r) => r.action === "settings.ad_spend_updated");
    expect(journal).toHaveLength(3);
    expect(journal[0]).toMatchObject({ actorId: ids.owner, entity: "settings" });
    expect(journal[1]!.summary).toContain(`OLX ${money(100000)} → ${money(120000)}`);
    expect(journal[1]!.meta).toMatchObject({ month, changes: { olx: { from: 100000, to: 120000 } } });
  });

  test("проверки: месяц, сумма, повтор источника", async () => {
    const { ids, as } = await setup();
    const owner = as(ids.owner);
    const one = (month: string, amount = 1000) => owner.mutation(api.analytics.setAdSpend, { month, items: [{ source: "olx", amount }] });
    await expect(one("2026-13")).rejects.toThrow("Неверный месяц");
    await expect(one("10.2026")).rejects.toThrow("Неверный месяц");
    await expect(one("2019-12")).rejects.toThrow("Неверный месяц");
    const future = new Date(Date.now() + 40 * DAY);
    await expect(one(monthOf(future.getTime()))).rejects.toThrow("прошедшие месяцы");
    await expect(one(monthOf(Date.now()), -5)).rejects.toThrow("не меньше нуля");
    await expect(
      owner.mutation(api.analytics.setAdSpend, {
        month: monthOf(Date.now()),
        items: [
          { source: "olx", amount: 1 },
          { source: "olx", amount: 2 },
        ],
      }),
    ).rejects.toThrow("дважды");
  });

  test("расходы за период — по дням месяца: 7 дней октября — 7/31, стык месяцев — доли обоих", () => {
    const rows = [
      { month: "2026-09", source: "olx" as const, amount: 30000 },
      { month: "2026-10", source: "olx" as const, amount: 31000 },
      { month: "2026-10", source: "instagram" as const, amount: 62000 },
    ];
    // 10–16 октября: 7 дней; последний день — неполный, но засчитывается целиком.
    const week = spendWithin(rows, { from: almaty(2026, 10, 10), to: almaty(2026, 10, 16) + 9 * HOUR });
    expect(week.olx).toBeCloseTo(7000);
    expect(week.instagram).toBeCloseTo(14000);
    // 28 сентября – 4 октября: 3 дня сентября (3/30) и 4 дня октября (4/31).
    expect(spendWithin(rows, { from: almaty(2026, 9, 28), to: almaty(2026, 10, 4) + HOUR }).olx).toBeCloseTo(3000 + 4000);
    expect(spendWithin(rows, SEPTEMBER)).toEqual({ olx: 30000 });
    expect(spendWithin(rows, { from: almaty(2026, 11, 1), to: almaty(2026, 11, 5) })).toEqual({});
    // Месяцы — по Алматы: 31 декабря 20:00 UTC — уже январь; список для редактора переходит через год.
    expect(monthOf(Date.UTC(2026, 11, 31, 20))).toBe("2027-01");
    expect(recentMonths(almaty(2027, 1, 15), 3)).toEqual(["2027-01", "2026-12", "2026-11"]);
    expect(monthLabel("2026-10")).toBe("октябрь 2026");
  });
});

describe("стоимость привлечения и деньги", () => {
  test("CPL, CPO и ROMI за прошлый месяц: 30 000 ₸ на OLX, 10 заявок, 4 заказа, маржа 18 000 ₸; возврат не в счёт", async () => {
    const { ids, as, mkOrder, mkLead } = await setup();
    // Прошлый календарный месяц по Алматы — целиком: его расходы попадают в период полностью.
    const local = new Date(Date.now() + 5 * HOUR);
    const start = almaty(local.getUTCFullYear(), local.getUTCMonth(), 1);
    const span: Span = { from: start, to: almaty(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 1 };
    const month = monthOf(start);
    const day = (n: number, hour = 12) => iso(start + (n - 1) * DAY + hour * HOUR);
    for (let i = 0; i < 10; i++) {
      const orderId = i < 4 ? await mkOrder({ createdAt: day(2 + i), doneAt: i < 3 ? day(10 + i) : undefined, status: i < 3 ? "paid" : "in_progress" }) : undefined;
      await mkLead({ createdAt: day(1 + i, 10), status: orderId ? "converted" : "new", orderId });
    }
    // Возврат: выполнен в том же месяце, но деньги ушли клиенту — ни выручки, ни маржи.
    await mkOrder({ createdAt: day(3), doneAt: day(20), status: "refund" });
    // Заявка из Instagram без расходов: CPL/CPO/ROMI не считаем.
    await mkLead({ source: "instagram", createdAt: day(5) });
    await as(ids.owner).mutation(api.analytics.setAdSpend, { month, items: [{ source: "olx", amount: 30000 }] });
    // Расходы текущего месяца в прошлый не попадают.
    await as(ids.owner).mutation(api.analytics.setAdSpend, { month: monthOf(Date.now()), items: [{ source: "olx", amount: 99000 }] });

    const slice = await as(ids.owner).query(api.metrics.analytics, { from: iso(span.from) });
    expect(slice.adSpend.find((r) => r.month === month)).toMatchObject({ source: "olx", amount: 30000 });
    const rows = sourceRows(slice.leads, slice.orders, spendWithin(slice.adSpend, span), span);
    const olx = rows.find((r) => r.source === "olx")!;
    expect(olx).toMatchObject({ leads: 10, orders: 4, conversion: 0.4, done: 3, revenue: 60000, margin: 18000, avg: 20000, spend: 30000 });
    expect(olx.cpl).toBe(3000);
    expect(olx.cpo).toBe(7500);
    expect(olx.romi).toBeCloseTo(-0.4);
    expect(rows.find((r) => r.source === "instagram")).toMatchObject({ leads: 1, spend: 0, cpl: null, cpo: null, romi: null });
    const total = sourceTotals(rows);
    expect(total).toMatchObject({ leads: 11, orders: 4, spend: 30000, margin: 18000, revenue: 60000 });
    expect(total.cpl).toBeCloseTo(30000 / 11);
  });

  test("возврат не считается ни выручкой, ни маржой (E1)", () => {
    const span: Span = { from: 0, to: Date.now() };
    const base = { payoutMode: "fixed" as const, payoutValue: 14000, clientPrice: 20000, doneAt: iso(Date.now() - DAY) };
    const orders = [
      { ...base, status: "closed" as const },
      { ...base, status: "refund" as const },
      { ...base, status: "cancelled" as const },
      { ...base, status: "in_progress" as const },
    ];
    const done = doneWithin(orders, span);
    expect(done.map((o) => o.status)).toEqual(["closed"]);
    expect(sums(done)).toMatchObject({ revenue: 20000, payouts: 14000, margin: 6000, count: 1 });
  });
});

describe("работа операторов", () => {
  test("заявки сайта, бота, API и AI без оператора владельцу не засчитываются — отдельная строка «пришли сами»", async () => {
    const { t, ids, as, mkLead } = await setup();
    // Заявки людей — через обычную форму: в журнале автор-сотрудник.
    const opLead = (await as(ids.operator).mutation(api.leads.create, { clientName: "Клиент Тест", phone: "77071234567", source: "olx", serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "normal" })).id;
    await as(ids.owner).mutation(api.leads.create, { clientName: "Клиент Тест", phone: "77071234567", source: "phone", serviceId: "ac-repair", city: "Алматы", description: "Шумит", urgency: "normal" });
    // Заявка с сайта: канал пишет её на владельца, автор записи журнала — «Сайт» (так делает приём заявок из каналов).
    const site = await mkLead({ source: "site", operatorId: ids.owner });
    await t.run((ctx) => audit(ctx, "Сайт", "lead.created", "Заявка с сайта", { entityId: site }));
    // AI разобрал звонок, который никто не принимал, — заявка на владельце, автор — «AI».
    const call = (operatorId?: Id<"users">) =>
      t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550000", to: "77270000000", operatorId, status: "completed", startedAt: iso(Date.now() - HOUR), aiStatus: "pending" }));
    const AI = { summary: "Не холодит кондиционер", extracted: [], questions: [] };
    const draft = { serviceId: "ac-repair", city: "Алматы", clientName: "Гульмира" };
    await t.mutation(internal.calls._saveAi, { id: await call(), status: "done", ai: AI, draft, autoLead: true });
    // Звонок принял оператор — AI-заявка записана на него и засчитывается ему.
    await t.mutation(internal.calls._saveAi, { id: await call(ids.operator), status: "done", ai: AI, draft, autoLead: true });

    // Заявка оператора стала заказом и выполнена.
    const { id: orderId } = await as(ids.operator).mutation(api.leads.convert, { id: opLead });
    await t.run((ctx) => ctx.db.patch(orderId, { clientPrice: 30000, payoutMode: "fixed", payoutValue: 21000, status: "done", doneAt: iso(Date.now()), executorId: ids.exA }));

    const slice = await as(ids.owner).query(api.metrics.analytics, { from: iso(Date.now() - 30 * DAY) });
    expect(slice.leads).toHaveLength(5);
    expect(slice.autoLeads).toHaveLength(2);
    expect(slice.autoLeads).toContain(site);
    const span = { from: Date.now() - 30 * DAY, to: Date.now() + HOUR };
    const { rows, auto } = operatorRows(slice.leads, slice.orders, new Set(slice.autoLeads), span);
    const of = (id: Id<"users">) => rows.find((r) => r.userId === id);
    expect(of(ids.operator)).toMatchObject({ leads: 2, converted: 1, conversion: 0.5, revenue: 30000, margin: 9000 });
    expect(of(ids.operator)!.medianMs).not.toBeNull();
    expect(of(ids.owner)).toMatchObject({ leads: 1, converted: 0, revenue: 0 });
    expect(auto).toMatchObject({ leads: 2, converted: 0 });
    expect(auto!.userId).toBeUndefined();
  });

  test("медиана «заявка → заказ», деньги только по выполненным заказам из заявок оператора", () => {
    const t0 = Date.UTC(2026, 9, 1, 6);
    const lead = (id: string, orderId?: string): Lead =>
      ({ id, source: "olx", status: orderId ? "converted" : "new", createdAt: iso(t0), orderId, operatorId: "u1" }) as Lead;
    const order = (id: string, lagH: number, status: Order["status"]): Order =>
      ({ id, source: "olx", status, createdAt: iso(t0 + lagH * HOUR), doneAt: iso(t0 + 30 * HOUR), clientPrice: 10000, payoutMode: "percent", payoutValue: 70 }) as Order;
    const leads = [lead("l1", "o1"), lead("l2", "o2"), lead("l3", "o3"), lead("l4")];
    const orders = [order("o1", 1, "closed"), order("o2", 3, "refund"), order("o3", 5, "in_progress")];
    const { rows, auto } = operatorRows(leads, orders, new Set(), { from: t0 - DAY, to: t0 + 2 * DAY });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: "u1", leads: 4, converted: 3, conversion: 0.75, revenue: 10000, margin: 3000, medianMs: 3 * HOUR });
    expect(auto).toBeNull();
  });
});

describe("выплаты исполнителям", () => {
  test("начислено и выплачено за период, долг сейчас по мастерам; возвраты, отмены и переоткрытые не в счёт", async () => {
    const { t, ids, as, mkOrder } = await setup();
    const now = Date.now();
    await mkOrder({ payoutValue: 21000, payoutPaid: true, status: "closed" });
    await mkOrder({ payoutValue: 14000, status: "awaiting_payment" });
    await mkOrder({ payoutValue: 10000, status: "closed", doneAt: iso(now - 200 * DAY), executorId: ids.exB });
    await mkOrder({ payoutValue: 9000, status: "paid", doneAt: iso(now - 100 * DAY), payoutPaid: true });
    await mkOrder({ payoutValue: 5000, status: "refund" });
    await mkOrder({ payoutValue: 7000, status: "in_progress" }); // переоткрыт: doneAt остался, но работа не сдана
    await mkOrder({ payoutValue: 3000, status: "cancelled", doneAt: undefined });
    // Начислено за период — из предрасчёта (convex/stats.ts): заказы вставлены мимо мутаций, собираем показатели целиком.
    vi.useFakeTimers();
    await t.mutation(internal.stats.tick, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();

    const p = await as(ids.owner).query(api.analytics.payouts, { from: iso(now - 7 * DAY) });
    expect(p.period).toEqual({ accrued: 35000, paid: 21000, unpaid: 14000, orders: 2 });
    expect(p.owed).toMatchObject({ total: 24000, orders: 2 });
    expect(p.owed.executors).toEqual([
      { id: ids.exA, name: "Асет Новиков", amount: 14000, orders: 1 },
      { id: ids.exB, name: "Берик Сантехник", amount: 10000, orders: 1 },
    ]);
  });
});

describe("деньги компании — только владельцу", () => {
  test("оператор и руководитель не получают денежных сводок: аналитика, выплаты и расходы закрыты, «Главная» — без сумм", async () => {
    const { ids, as, mkOrder, mkLead } = await setup();
    await mkOrder({ payments: [{ id: "p1", amount: 20000, method: "kaspi", at: iso(Date.now()) }], payoutPaid: true });
    await mkOrder({ category: "plumbing", serviceId: "leak-fix", executorId: ids.exB });
    // Заявка полугодовой давности: «Главной» не владельца она не нужна.
    await mkLead({ createdAt: iso(Date.now() - 200 * DAY) });
    const from = iso(Date.now() - 400 * DAY);

    for (const user of [ids.operator, ids.manager]) {
      const who = as(user);
      await expect(who.query(api.metrics.analytics, { from })).rejects.toThrow("Нет доступа");
      await expect(who.query(api.analytics.payouts, { from })).rejects.toThrow("Нет доступа");
      await expect(who.query(api.analytics.adSpendMonth, { month: monthOf(Date.now()) })).rejects.toThrow("Нет доступа");
      const d = await who.query(api.metrics.dashboard, { from });
      expect(d.orders.length).toBeGreaterThan(0);
      for (const o of d.orders) expect(o).toMatchObject({ clientPrice: 0, payoutValue: 0, payments: [], payoutPaid: false });
      expect(d.leads).toHaveLength(0);
    }
    // Руководитель видит только своё направление.
    expect((await as(ids.manager).query(api.metrics.dashboard, { from })).orders.map((o) => o.category)).toEqual(["ac"]);

    const own = await as(ids.owner).query(api.metrics.dashboard, { from });
    expect(own.orders.map((o) => o.clientPrice)).toEqual([20000, 20000]);
    expect(own.orders[0]!.payments).toHaveLength(1);
    expect(own.leads).toHaveLength(1);
    await expect(as(ids.owner).query(api.metrics.dashboard, { from: "вчера" })).rejects.toThrow("Неверная дата");
  });
});
