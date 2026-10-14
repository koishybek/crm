/// <reference types="vite/client" />
// Права сотрудников поверх роли (ТЗ п.5.12) и деньги по правам (п.26.2, п.27.10): одно правило can(), заказ «глазами
// пользователя» (lib/dto.ts moneyFor) во всех запросах, проверки мутаций денег на сервере, окно «Доступ» владельца.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { exportAllowed, exportColumns } from "../src/data/exportAccess";
import { canEditPrice, permissionsOf, ROLE_PERMISSIONS } from "../src/data/permissions";
import type { Order } from "../src/data/types";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const DAY = 86400_000;
const SITE = "https://site.test";
const iso = (t: number) => new Date(t).toISOString();

beforeEach(() => {
  vi.stubEnv("FILES_SIGNING_KEY", "test-files-signing-key");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, result: { message_id: 1 } })),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const at = iso(now);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Ерлан Руководитель", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", {
      tenantId: T,
      name: "Асет Мастеров",
      phone: "77000000001",
      city: "Алматы",
      categories: ["ac"],
      skills: [],
      available: true,
      rating: 5,
      reviews: 0,
      cooperation: "freelance",
      joinedAt: at,
      rates: { mode: "percent", percent: 60 },
    });
    const exUser = await ctx.db.insert("users", { name: "Асет Мастеров", email: "77000000001", phone: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 2, activeCount: 1, lastActivityAt: at });
    return { owner, operator, manager, ex, exUser, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  let number = 7000;
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
        deadline: iso(now + DAY),
        priority: "normal",
        status: "accepted",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        acceptedPayout: 21000,
        payments: [],
        payoutPaid: false,
        executorId: ids.ex,
        assignedAt: iso(now - DAY),
        createdAt: iso(now - 2 * DAY),
        createdBy: ids.owner,
        files: [],
        ...over,
      }),
    );
  const get = async (id: Id<"orders">) => (await t.run((ctx) => ctx.db.get(id)))!;
  const journal = (action: string) => t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((r) => r.action === action));
  const grant = (userId: Id<"users">, permissions: Doc<"users">["permissions"] | null) =>
    as(ids.owner).mutation(api.permissions.set, { userId, permissions: permissions ?? null });
  return { t, now, ids, as, mkOrder, get, journal, grant };
}

/** В заказе нет выплаты мастеру (а значит, и маржи). */
function noPayout(o: Order) {
  expect(o).toMatchObject({ payoutMode: "fixed", payoutValue: 0, payoutPaid: false });
  expect([o.acceptedPayout, o.payoutPaidAt, o.payoutId, o.payoutBase, o.payoutManual]).toEqual([undefined, undefined, undefined, undefined, undefined]);
}
/** В заказе нет денег вообще. */
function noMoney(o: Order) {
  noPayout(o);
  expect([o.clientPrice, o.payments, o.refunds]).toEqual([0, [], undefined]);
}

describe("права по ролям (src/data/permissions.ts)", () => {
  test("умолчания: владелец — всё, оператор — деньги клиента, оплата, клиенты, звонки, сообщения; руководитель — аналитика своих направлений; мастер — ничего", () => {
    expect(permissionsOf({ role: "owner", permissions: [] })).toHaveLength(10);
    expect(permissionsOf({ role: "operator" })).toEqual(["money.view", "payments.add", "clients.view", "calls.view", "inbox.view"]);
    expect(permissionsOf({ role: "manager" })).toEqual(["analytics.view"]);
    expect(permissionsOf({ role: "executor", permissions: ["money.view"] })).toEqual([]);
    expect(ROLE_PERMISSIONS.operator).not.toContain("money.payouts");
    expect(ROLE_PERMISSIONS.operator).not.toContain("money.edit");
  });

  test("зависимости и роли: право без базового не действует, выгрузки руководителю не выдаются", () => {
    expect(permissionsOf({ role: "operator", permissions: ["money.payouts", "money.edit", "catalog.edit"] })).toEqual([]);
    expect(permissionsOf({ role: "operator", permissions: ["money.view", "money.payouts", "catalog.edit"] })).toEqual(["money.view", "money.payouts", "catalog.edit"]);
    expect(permissionsOf({ role: "manager", permissions: ["data.export", "clients.view"] })).toEqual(["clients.view"]);
  });

  test("цена до принятия мастером — с правом на деньги, после — только с правом «Менять деньги заказа»", () => {
    const op = { role: "operator" as const };
    expect(["new", "awaiting_executor", "assigned"].every((s) => canEditPrice(op, s as Order["status"]))).toBe(true);
    expect(canEditPrice(op, "accepted")).toBe(false);
    expect(canEditPrice({ role: "manager" }, "new")).toBe(false);
    expect(canEditPrice({ role: "operator", permissions: ["money.view", "money.edit"] }, "done")).toBe(true);
  });

  test("выгрузки: только с правом и данными; колонки с деньгами — по правам", () => {
    const op = { role: "operator" as const, permissions: [...ROLE_PERMISSIONS.operator, "data.export" as const] };
    expect(exportAllowed({ role: "operator" }, "orders")).toBe(false);
    expect(exportAllowed(op, "orders")).toBe(true);
    expect(exportAllowed(op, "payouts")).toBe(false);
    expect(exportAllowed(op, "audit")).toBe(false);
    expect(exportAllowed({ role: "owner" }, "audit")).toBe(true);
    const headers = ["Заказ", "Цена клиента", "Выплата исполнителю", "Маржа", "Оплачено"];
    expect(exportColumns(op, "orders", headers)).toEqual([0, 1, 4]);
    expect(exportColumns({ role: "owner" }, "orders", headers)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe("деньги по правам во всех запросах (ТЗ п.26.2, п.27.10)", () => {
  async function seeded() {
    const s = await setup();
    const accepted = await s.mkOrder();
    const done = await s.mkOrder({
      status: "awaiting_payment",
      doneAt: iso(s.now - DAY),
      payments: [{ id: "p1", amount: 10000, method: "kaspi", at: iso(s.now - DAY) }],
      refunds: [{ id: "r1", amount: 1000, method: "kaspi", at: iso(s.now - DAY), reason: "Скидка", by: s.ids.owner }],
      payoutPaid: true,
      payoutPaidAt: iso(s.now - DAY),
      payoutManual: true,
    });
    const lead = await s.t.run(async (ctx) => {
      await ctx.db.insert("history", { orderId: done, kind: "finance", text: "Финансы: 30 000 ₸ / 21 000 ₸ → 30 000 ₸ / 20 000 ₸", actor: { type: "user", id: s.ids.owner }, at: iso(s.now - DAY) });
      await ctx.db.insert("history", { orderId: done, kind: "payment", text: "Внесена оплата 10 000 ₸ (Kaspi)", actor: { type: "user", id: s.ids.owner }, at: iso(s.now - DAY) });
      await ctx.db.insert("history", { orderId: done, kind: "status", text: "Ожидает оплаты: долг клиента 20 000 ₸", actor: { type: "system" }, at: iso(s.now - DAY), from: "done", to: "awaiting_payment" });
      return ctx.db.insert("leads", {
        tenantId: T,
        number: 7002,
        clientId: s.ids.client,
        clientName: "Клиент Тест",
        clientPhone: "77071234567",
        source: "olx",
        serviceId: "ac-repair",
        city: "Алматы",
        description: "Не холодит",
        urgency: "normal",
        status: "converted",
        operatorId: s.ids.operator,
        createdAt: iso(s.now - 3 * DAY),
        orderId: done,
      });
    });
    return { ...s, accepted, done, lead };
  }

  /** Все заказы, которые пользователь получает из запросов сотрудника. */
  async function everyOrder(s: Awaited<ReturnType<typeof seeded>>, who: Id<"users">, opts: { clients: boolean }): Promise<Order[]> {
    const q = s.as(who);
    const out: Order[] = [];
    out.push(...(await q.query(api.orders.board, {})));
    out.push(...(await q.query(api.orders.active, {})));
    out.push((await q.query(api.orders.detail, { id: s.done }))!.order);
    out.push(...(await q.query(api.orders.list, { paginationOpts: { numItems: 50, cursor: null } })).page);
    out.push(...(await q.query(api.leads.list, {})).orders);
    out.push((await q.query(api.leads.get, { id: s.lead }))!.order!);
    out.push(...(await q.query(api.executors.detail, { id: s.ids.ex }))!.orders);
    out.push(...(await q.query(api.metrics.dashboard, { from: iso(s.now - 30 * DAY) })).orders);
    if (opts.clients) out.push(...(await q.query(api.clients.detail, { id: s.ids.client }))!.orders);
    expect(out.length).toBeGreaterThan(8);
    return out;
  }

  test("оператор не получает выплату мастеру и маржу ни из одного запроса, цену и оплаты — получает", async () => {
    const s = await seeded();
    const orders = await everyOrder(s, s.ids.operator, { clients: true });
    for (const o of orders) noPayout(o);
    expect(orders.find((o) => o.id === s.done)).toMatchObject({ clientPrice: 30000, payments: [{ id: "p1" }] });
    const d = (await s.as(s.ids.operator).query(api.orders.detail, { id: s.done }))!;
    // История: правка «цена / выплата» скрыта, оплата видна.
    expect(d.history.map((h) => h.kind)).not.toContain("finance");
    expect(d.history.map((h) => h.kind)).toContain("payment");
    // Ставки мастера — данные о выплатах.
    for (const e of [...d.executors, ...(await s.as(s.ids.operator).query(api.executors.list, {})).executors, ...(await s.as(s.ids.operator).query(api.users.team, {}))!.executors]) {
      expect(e.rates).toBeUndefined();
    }
    expect((await s.as(s.ids.operator).query(api.executors.detail, { id: s.ids.ex }))!.executor.rates).toBeUndefined();
    // Справочник: цены услуг есть, доли мастера нет.
    expect(JSON.stringify(await s.as(s.ids.operator).query(api.catalog.list, {}))).not.toMatch(/payoutPct/);
    // Сводки выплат и реестр закрыты, долги клиентов — открыты.
    await expect(s.as(s.ids.operator).query(api.payouts.owed, {})).rejects.toThrow("Выплаты мастерам и маржа");
    await expect(s.as(s.ids.operator).query(api.payouts.list, {})).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.operator).query(api.analytics.payouts, { from: iso(s.now - DAY) })).rejects.toThrow("Нет доступа");
    expect((await s.as(s.ids.operator).query(api.receivables.list, {})).count).toBe(1);
    // Владелец видит всё.
    const own = (await s.as(s.ids.owner).query(api.orders.detail, { id: s.done }))!;
    expect(own.order).toMatchObject({ payoutValue: 21000, payoutPaid: true, payoutManual: true });
    expect(own.history.map((h) => h.kind)).toContain("finance");
    expect(own.executors.find((e) => e.id === s.ids.ex)?.rates).toEqual({ mode: "percent", percent: 60 });
  });

  test("руководитель не получает денег вообще: ни цены, ни оплат, ни выплат, ни долга в истории", async () => {
    const s = await seeded();
    for (const o of await everyOrder(s, s.ids.manager, { clients: false })) noMoney(o);
    const d = (await s.as(s.ids.manager).query(api.orders.detail, { id: s.done }))!;
    expect(d.history.map((h) => h.kind)).toEqual(["status"]);
    expect(d.history[0]!.text).toBe("Статус изменён на «Ожидает оплаты»");
    expect(JSON.stringify(d)).not.toMatch(/20 000|10 000|21 000/);
    const catalog = (await s.as(s.ids.manager).query(api.catalog.list, {}))!;
    expect(JSON.stringify(catalog)).not.toMatch(/price|payoutPct/);
    await expect(s.as(s.ids.manager).query(api.receivables.list, {})).rejects.toThrow("Цена клиента и оплаты");
    await expect(s.as(s.ids.manager).query(api.clients.detail, { id: s.ids.client })).rejects.toThrow("Клиентская база");
  });

  test("право выдали — данные приходят сразу; забрали — уходят", async () => {
    const s = await seeded();
    await s.grant(s.ids.operator, ["money.view", "payments.add", "money.payouts", "clients.view", "calls.view", "inbox.view"]);
    const o = (await s.as(s.ids.operator).query(api.orders.detail, { id: s.done }))!;
    expect(o.order).toMatchObject({ payoutValue: 21000, payoutPaid: true });
    expect(o.history.map((h) => h.kind)).toContain("finance");
    expect((await s.as(s.ids.operator).query(api.payouts.owed, {}))).toEqual([]);
    await s.grant(s.ids.operator, ["clients.view"]);
    noMoney((await s.as(s.ids.operator).query(api.orders.detail, { id: s.done }))!.order);
    await expect(s.as(s.ids.operator).query(api.receivables.list, {})).rejects.toThrow("Нет доступа");
  });
});

describe("мутации денег проверяют права на сервере", () => {
  test("оператор: цену до принятия — можно, выплату — нет; после принятия — ни цену, ни выплату; оплату — можно", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const fresh = await s.mkOrder({ status: "new", executorId: undefined, acceptedPayout: undefined, payoutMode: "percent", payoutValue: 70, clientPrice: 0 });
    await op.mutation(api.orders.updateFinance, { id: fresh, clientPrice: 40000 });
    expect(await s.get(fresh)).toMatchObject({ clientPrice: 40000, payoutMode: "percent", payoutValue: 70 });
    await expect(op.mutation(api.orders.updateFinance, { id: fresh, clientPrice: 40000, payoutMode: "fixed", payoutValue: 10000 })).rejects.toThrow("Выплаты мастерам и маржа");
    // Цена ниже суммы мастера — без раскрытия самой суммы.
    const fixed = await s.mkOrder({ status: "new", executorId: undefined, acceptedPayout: undefined });
    await expect(op.mutation(api.orders.updateFinance, { id: fixed, clientPrice: 15000 })).rejects.toThrow("Цена ниже суммы исполнителю");

    const accepted = await s.mkOrder();
    await expect(op.mutation(api.orders.updateFinance, { id: accepted, clientPrice: 35000 })).rejects.toThrow("Менять деньги заказа");
    const working = await s.mkOrder({ status: "in_progress" });
    await op.mutation(api.orders.addPayment, { id: working, amount: 5000, method: "cash" });
    expect((await s.get(working)).payments).toHaveLength(1);

    const paid = await s.mkOrder({ status: "done", doneAt: iso(s.now - DAY), payments: [{ id: "p1", amount: 30000, method: "kaspi", at: iso(s.now - DAY) }] });
    await expect(op.mutation(api.finance.voidPayment, { id: paid, paymentId: "p1", reason: "ошибка" })).rejects.toThrow("Менять деньги заказа");
    await expect(op.mutation(api.finance.addRefund, { id: paid, amount: 1000, method: "kaspi", reason: "скидка" })).rejects.toThrow("Менять деньги заказа");
    await expect(op.mutation(api.payouts.create, { executorId: s.ids.ex, orderIds: [paid], method: "kaspi" })).rejects.toThrow("Нет доступа");
    await expect(op.mutation(api.analytics.setAdSpend, { month: new Date().toISOString().slice(0, 7), items: [] })).rejects.toThrow("Нет доступа");
  });

  test("руководитель: ни цены, ни оплаты, ни возврата; без права «Вносить оплату» оператору оплата закрыта", async () => {
    const s = await setup();
    const mg = s.as(s.ids.manager);
    const fresh = await s.mkOrder({ status: "new", executorId: undefined, acceptedPayout: undefined });
    await expect(mg.mutation(api.orders.updateFinance, { id: fresh, clientPrice: 1 })).rejects.toThrow("Цена клиента и оплаты");
    const working = await s.mkOrder({ status: "in_progress" });
    await expect(mg.mutation(api.orders.addPayment, { id: working, amount: 5000, method: "cash" })).rejects.toThrow("Вносить оплату");
    await s.grant(s.ids.operator, ["money.view", "clients.view"]);
    await expect(s.as(s.ids.operator).mutation(api.orders.addPayment, { id: working, amount: 5000, method: "cash" })).rejects.toThrow("Вносить оплату");
    expect((await s.get(working)).payments).toEqual([]);
  });

  test("после выдачи «Менять деньги заказа» и «Выплаты мастерам» — правка после принятия, сторно, возврат и выплата работают", async () => {
    const s = await setup();
    await s.grant(s.ids.operator, ["money.view", "payments.add", "money.payouts", "money.edit"]);
    const op = s.as(s.ids.operator);
    const accepted = await s.mkOrder();
    await op.mutation(api.orders.updateFinance, { id: accepted, clientPrice: 35000, payoutMode: "fixed", payoutValue: 22000 });
    expect(await s.get(accepted)).toMatchObject({ clientPrice: 35000, payoutValue: 22000 });

    const done = await s.mkOrder({
      status: "done",
      doneAt: iso(s.now - DAY),
      payments: [
        { id: "p1", amount: 30000, method: "kaspi", at: iso(s.now - DAY) },
        { id: "p2", amount: 500, method: "cash", at: iso(s.now - DAY) },
      ],
    });
    await op.mutation(api.finance.voidPayment, { id: done, paymentId: "p2", reason: "дубль" });
    await op.mutation(api.finance.addRefund, { id: done, amount: 1000, method: "kaspi", reason: "скидка" });
    const r = await op.mutation(api.payouts.create, { executorId: s.ids.ex, orderIds: [done], method: "kaspi" });
    expect(r.amount).toBe(21000);
    expect((await s.get(done)).payoutPaid).toBe(true);
  });
});

describe("окно «Доступ»: владелец задаёт права (permissions.set)", () => {
  test("только владелец; себе, владельцу и мастеру — нельзя; зависимости и роли проверяются", async () => {
    const s = await setup();
    await expect(s.as(s.ids.operator).mutation(api.permissions.set, { userId: s.ids.manager, permissions: ["money.view"] })).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.owner).mutation(api.permissions.set, { userId: s.ids.owner, permissions: [] })).rejects.toThrow("Свои права");
    await expect(s.as(s.ids.owner).mutation(api.permissions.set, { userId: s.ids.exUser, permissions: [] })).rejects.toThrow("свой кабинет");
    await expect(s.as(s.ids.owner).mutation(api.permissions.set, { userId: s.ids.operator, permissions: ["money.payouts"] })).rejects.toThrow("только вместе с «Цена клиента и оплаты»");
    await expect(s.as(s.ids.owner).mutation(api.permissions.set, { userId: s.ids.manager, permissions: ["data.export"] })).rejects.toThrow("не выдаётся");
  });

  test("изменение — в базе, журнале и колокольчике; совпало с умолчаниями — не храним; смена роли — права роли", async () => {
    const s = await setup();
    await s.grant(s.ids.manager, ["money.view", "clients.view", "analytics.view"]);
    const u = await s.t.run((ctx) => ctx.db.get(s.ids.manager));
    expect(u!.permissions).toEqual(["money.view", "clients.view", "analytics.view"]);
    const [entry] = await s.journal("user.permissions");
    expect(entry!.summary).toContain("выданы «Цена клиента и оплаты», «Клиентская база»");
    expect(entry!.meta).toMatchObject({ role: "manager", from: ["analytics.view"], to: ["money.view", "clients.view", "analytics.view"], custom: true });
    const bells = await s.t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", s.ids.manager)).collect());
    expect(bells.at(-1)!.text).toContain("Владелец изменил ваши права");
    // Руководитель с клиентской базой видит клиентов, но заказы — только своих направлений.
    expect(await s.as(s.ids.manager).query(api.clients.list, {})).toHaveLength(1);
    const me = await s.as(s.ids.manager).query(api.users.me, {});
    expect(me!.permissions).toEqual(["money.view", "clients.view", "analytics.view"]);
    expect(me!.customPermissions).toBe(true);

    // Вернули умолчания роли — в базе ничего, повтор — без записи в журнал.
    await s.grant(s.ids.manager, ["analytics.view"]);
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.manager)))!.permissions).toBeUndefined();
    await s.grant(s.ids.manager, null);
    expect(await s.journal("user.permissions")).toHaveLength(2);

    // Смена роли сбрасывает заданные права.
    await s.grant(s.ids.operator, ["money.view"]);
    await s.as(s.ids.owner).mutation(api.users.updateAccess, { userId: s.ids.operator, role: "manager", categories: ["ac"] });
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.operator)))!.permissions).toBeUndefined();
  });

  test("руководитель с правами на деньги и аналитику: суммы своих направлений, сводки компании — нет", async () => {
    const s = await setup();
    await s.mkOrder({ status: "awaiting_payment", doneAt: iso(s.now - DAY) });
    await s.mkOrder({ status: "awaiting_payment", doneAt: iso(s.now - DAY), category: "plumbing", serviceId: "leak-fix" });
    await s.t.run((ctx) => ctx.db.insert("payouts", { tenantId: T, executorId: s.ids.ex, orderIds: [], orderNumbers: [], amount: 5000, method: "kaspi", at: iso(s.now - DAY), by: s.ids.owner, createdAt: iso(s.now - DAY) }));
    await s.grant(s.ids.manager, ["money.view", "money.payouts", "analytics.view"]);
    const mg = s.as(s.ids.manager);
    const debts = await mg.query(api.receivables.list, {});
    expect(debts.debtors.map((d) => d.number)).toHaveLength(1);
    const a = await mg.query(api.metrics.analytics, { from: iso(s.now - 30 * DAY) });
    expect(a.orders.map((o) => o.category)).toEqual(["ac"]);
    expect(a.orders[0]).toMatchObject({ clientPrice: 30000, payoutValue: 21000 });
    expect([a.payouts, a.adSpend]).toEqual([[], []]);
    await expect(mg.query(api.payouts.list, {})).rejects.toThrow("Нет доступа");
    // Владелец получает реестр выплат в аналитике.
    expect((await s.as(s.ids.owner).query(api.metrics.analytics, { from: iso(s.now - 30 * DAY) })).payouts).toHaveLength(1);
  });

  test("сняли у оператора клиентскую базу, звонки и сообщения — разделы закрыты на сервере", async () => {
    const s = await setup();
    await s.grant(s.ids.operator, ["money.view"]);
    const op = s.as(s.ids.operator);
    await expect(op.query(api.clients.list, {})).rejects.toThrow("Клиентская база");
    await expect(op.query(api.calls.list, {})).rejects.toThrow("Звонки и записи");
    await expect(op.query(api.inbox.list, { filter: "all", paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow("Сообщения клиентов");
    expect(await op.query(api.inbox.unreadCount, {})).toBeNull();
    // Поиск в шапке — без клиентов.
    expect(await op.query(api.search.global, { q: "Клиент" })).toEqual([]);
  });

  test("выгрузка по праву: оператор с «Выгрузка в Excel» получает заказы без выплаты и маржи, выплаты и журнал — нет", async () => {
    const s = await setup();
    await s.mkOrder({ status: "awaiting_payment", doneAt: iso(s.now - DAY), createdAt: iso(s.now - DAY) });
    const range = { from: iso(s.now - 10 * DAY), to: iso(s.now) };
    await expect(s.as(s.ids.operator).action(api.exports.create, { kind: "orders", ...range })).rejects.toThrow("Нет доступа");
    await s.grant(s.ids.operator, [...ROLE_PERMISSIONS.operator, "data.export"]);
    const r = await s.as(s.ids.operator).action(api.exports.create, { kind: "orders", ...range });
    const res = await s.t.fetch(r.url.slice(SITE.length));
    const text = await res.text();
    const header = text.replace(/^﻿/, "").split("\r\n")[0]!;
    expect(header).toContain("Цена клиента");
    expect(header).toContain("Долг клиента");
    expect(header).not.toMatch(/Выплата исполнителю|Маржа|Выплата мастеру проведена/);
    expect(text).not.toContain("21000");
    for (const kind of ["payouts", "audit"] as const) await expect(s.as(s.ids.operator).action(api.exports.create, { kind, ...range })).rejects.toThrow("Нет доступа");
  });
});
