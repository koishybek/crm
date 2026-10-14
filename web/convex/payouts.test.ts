/// <reference types="vite/client" />
// Реестр выплат мастерам (ТЗ п.13, п.14, п.17) и деньги в аналитике: выручка без возвратов, «Получено» по датам оплат,
// «Выплачено мастерам» по датам выплат; денежные сводки — только владельцу (аудит M-2).
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { doneWithin, paidOutWithin, receivedWithin, sums } from "../src/data/analytics";
import { money } from "../src/lib/format";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString();

async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const at = iso(now);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель Климата", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const mk = async (name: string, phone: string) => {
      const ex = await ctx.db.insert("executors", { tenantId: T, name, phone, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: ex, tenantId: T, active: true });
      return { ex, user };
    };
    const a = await mk("Асет Мастеров", "77000000001");
    const b = await mk("Берик Второй", "77000000002");
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    return { owner, operator, manager, a, b, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  let number = 5000;
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
        status: "paid",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [{ id: `p${number}`, amount: 30000, method: "kaspi", at: iso(now - DAY) }],
        payoutPaid: false,
        executorId: ids.a.ex,
        assignedAt: iso(now - 3 * DAY),
        createdAt: iso(now - 4 * DAY),
        createdBy: ids.owner,
        doneAt: iso(now - 2 * DAY),
        files: [],
        ...over,
      }),
    );
  const get = async (id: Id<"orders">) => (await t.run((ctx) => ctx.db.get(id)))!;
  const bells = (userId: Id<"users">) => t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
  return { t, ids, as, now, mkOrder, get, bells };
}

describe("выплаты мастерам — реестр", () => {
  test("долг по мастерам → выплата за выбранные заказы: заказы отмечены, мастеру уведомление, запись в журнале", async () => {
    const s = await setup();
    const paid = await s.mkOrder();
    const waiting = await s.mkOrder({ status: "awaiting_payment", payments: [], payoutValue: 14000, doneAt: iso(s.now - DAY) });
    const working = await s.mkOrder({ status: "in_progress", payments: [], doneAt: undefined });
    const foreign = await s.mkOrder({ executorId: s.ids.b.ex, payoutValue: 9000 });

    const owner = s.as(s.ids.owner);
    const owed = await owner.query(api.payouts.owed, {});
    expect(owed.map((x) => [x.name, x.amount, x.orders.length])).toEqual([
      ["Асет Мастеров", 35000, 2],
      ["Берик Второй", 9000, 1],
    ]);
    expect(owed[0]!.orders.map((o) => [o.id, o.clientPaid])).toEqual([
      [paid, true],
      [waiting, false],
    ]);

    for (const who of [s.ids.operator, s.ids.manager]) {
      await expect(s.as(who).query(api.payouts.owed, {})).rejects.toThrow("Нет доступа");
      await expect(s.as(who).mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [paid], method: "kaspi" })).rejects.toThrow("Нет доступа");
    }
    await expect(owner.mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [paid, working], method: "kaspi" })).rejects.toThrow("ещё не сдан");
    await expect(owner.mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [paid, foreign], method: "kaspi" })).rejects.toThrow("другой исполнитель");
    await expect(owner.mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [], method: "kaspi" })).rejects.toThrow("Выберите заказы");

    const at = iso(s.now - DAY);
    const r = await owner.mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [paid, waiting], method: "transfer", at, note: "За неделю" });
    expect(r.amount).toBe(35000);
    const row = await s.t.run((ctx) => ctx.db.get(r.id));
    expect(row).toMatchObject({ executorId: s.ids.a.ex, amount: 35000, method: "transfer", at, by: s.ids.owner, note: "За неделю" });
    expect(row!.orderNumbers).toEqual([(await s.get(paid)).number, (await s.get(waiting)).number]);
    for (const id of [paid, waiting]) expect(await s.get(id)).toMatchObject({ payoutPaid: true, payoutPaidAt: at, payoutId: r.id });

    expect((await s.bells(s.ids.a.user)).map((n) => n.text)).toEqual([expect.stringContaining(`Выплата ${money(35000)} (Перевод на счёт) за заказы`)]);
    const journal = (await s.t.run((ctx) => ctx.db.query("audit").collect())).filter((x) => x.action === "executor.payout");
    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ entity: "executor", entityId: s.ids.a.ex, actorId: s.ids.owner });
    expect(journal[0]!.meta).toMatchObject({ amount: 35000, method: "transfer" });

    // Должен теперь только Берику; повторно за тот же заказ не выплатить; сумма выплаты зафиксирована.
    expect((await owner.query(api.payouts.owed, {})).map((x) => x.name)).toEqual(["Берик Второй"]);
    await expect(owner.mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [paid], method: "kaspi" })).rejects.toThrow("уже проведена");
    await expect(owner.mutation(api.orders.updateFinance, { id: paid, clientPrice: 30000, payoutMode: "fixed", payoutValue: 25000 })).rejects.toThrow("уже выплачено");
    await expect(owner.mutation(api.orders.updateFinance, { id: paid, clientPrice: 30000, payoutMode: "fixed", payoutValue: 21000, payoutPaid: false })).rejects.toThrow("Выплаты мастерам");

    // Мастер видит свои выплаты в «Доходе», чужие — нет; в реестре владельца — с возможностью отменить.
    const mine = await s.as(s.ids.a.user).query(api.payouts.mine, {});
    expect(mine).toEqual([{ id: r.id, at, amount: 35000, method: "transfer", orders: [expect.objectContaining({ id: paid }), expect.objectContaining({ id: waiting })] }]);
    expect(mine[0]).not.toHaveProperty("note");
    expect(await s.as(s.ids.b.user).query(api.payouts.mine, {})).toEqual([]);
    const list = await owner.query(api.payouts.list, {});
    expect(list).toEqual([expect.objectContaining({ id: r.id, executorName: "Асет Мастеров", byName: "Владелец Тест", canUndo: true })]);
  });

  test("отмена выплаты — в течение суток: заказы снова к выплате, мастеру уведомление", async () => {
    const s = await setup();
    const id = await s.mkOrder();
    const owner = s.as(s.ids.owner);
    const first = await owner.mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [id], method: "cash" });
    await owner.mutation(api.payouts.undo, { id: first.id });
    const o = await s.get(id);
    expect(o.payoutPaid).toBe(false);
    expect([o.payoutPaidAt, o.payoutId]).toEqual([undefined, undefined]);
    expect(await s.t.run((ctx) => ctx.db.get(first.id))).toBeNull();
    expect((await s.bells(s.ids.a.user)).at(-1)!.text).toContain("отменена");

    const second = await owner.mutation(api.payouts.create, { executorId: s.ids.a.ex, orderIds: [id], method: "cash" });
    await s.t.run((ctx) => ctx.db.patch(second.id, { createdAt: iso(s.now - 25 * 3600_000) }));
    await expect(owner.mutation(api.payouts.undo, { id: second.id })).rejects.toThrow("в течение суток");
    await expect(s.as(s.ids.operator).mutation(api.payouts.undo, { id: second.id })).rejects.toThrow("Нет доступа");
    expect((await s.get(id)).payoutPaid).toBe(true);
    expect((await owner.query(api.payouts.list, {}))[0]!.canUndo).toBe(false);
  });
});

describe("деньги в аналитике", () => {
  test("выручка — без возвратов, «Получено» — по датам оплат минус сторно и возвраты, «Выплачено мастерам» — по датам выплат", async () => {
    const s = await setup();
    const from = s.now - 30 * DAY;
    const span = { from, to: s.now + DAY };
    // Выполнен и оплачен давно, но доплата пришла в периоде: в срез попадает по дате денег (moneyAt).
    await s.mkOrder({ createdAt: iso(s.now - 60 * DAY), doneAt: iso(s.now - 50 * DAY), payments: [{ id: "old", amount: 30000, method: "kaspi", at: iso(s.now - 50 * DAY) }, { id: "late", amount: 7000, method: "cash", at: iso(s.now - 5 * DAY) }], clientPrice: 37000, moneyAt: iso(s.now - 5 * DAY) });
    // Частичный возврат: выручка 30 000 − 5 000.
    await s.mkOrder({ refunds: [{ id: "r1", amount: 5000, method: "kaspi", at: iso(s.now - DAY), reason: "Скидка", by: s.ids.owner }], moneyAt: iso(s.now - DAY) });
    // Полный возврат: ни выручки, ни маржи.
    await s.mkOrder({ status: "refund", refunds: [{ id: "r2", amount: 30000, method: "kaspi", at: iso(s.now - DAY), reason: "Брак", by: s.ids.owner }], moneyAt: iso(s.now - DAY) });
    // Сторнированный платёж — не деньги.
    await s.mkOrder({ status: "awaiting_payment", payments: [{ id: "void", amount: 30000, method: "kaspi", at: iso(s.now - DAY), voidedAt: iso(s.now), voidedBy: s.ids.owner, voidReason: "Ошибка" }] });
    await s.t.run(async (ctx) => {
      const row = { tenantId: T, executorId: s.ids.a.ex, orderIds: [], orderNumbers: [], method: "kaspi" as const, by: s.ids.owner, createdAt: iso(s.now) };
      await ctx.db.insert("payouts", { ...row, amount: 14000, at: iso(s.now - 3 * DAY) });
      await ctx.db.insert("payouts", { ...row, amount: 9000, at: iso(s.now - 40 * DAY) });
    });

    const slice = await s.as(s.ids.owner).query(api.metrics.analytics, { from: iso(from) });
    expect(slice.orders).toHaveLength(4);
    const totals = sums(doneWithin(slice.orders, span));
    // В периоде выполнены: заказ с частичным возвратом (25 000) и заказ со сторно (30 000, долг); давний — выполнен раньше.
    expect(totals).toMatchObject({ revenue: 55000, payouts: 42000, margin: 13000, count: 2 });
    // Получено: 7 000 (доплата по давнему) + 30 000 + 30 000 (оплаты в периоде) − возвраты 5 000 и 30 000; сторно — не в счёт.
    expect(receivedWithin(slice.orders, span)).toEqual({ received: 67000, refunded: 35000, net: 32000 });
    expect(paidOutWithin(slice.payouts, span)).toBe(14000);
    const card = await s.as(s.ids.owner).query(api.analytics.payouts, { from: iso(from) });
    expect(card.paidOut).toEqual({ amount: 14000, count: 1 });
  });

  test("оператор и руководитель денежных сводок не получают: возвраты, выплаты и снимок выплаты из «Главной» вырезаны (M-2)", async () => {
    const s = await setup();
    await s.mkOrder({ refunds: [{ id: "r1", amount: 5000, method: "kaspi", at: iso(s.now - DAY), reason: "Скидка", by: s.ids.owner }], acceptedPayout: 21000, payoutPaid: true, payoutPaidAt: iso(s.now - DAY) });
    for (const who of [s.ids.operator, s.ids.manager]) {
      await expect(s.as(who).query(api.metrics.analytics, { from: iso(s.now - 30 * DAY) })).rejects.toThrow("Нет доступа");
      await expect(s.as(who).query(api.payouts.list, {})).rejects.toThrow("Нет доступа");
      const d = await s.as(who).query(api.metrics.dashboard, { from: iso(s.now - 30 * DAY) });
      expect(d.orders).toHaveLength(1);
      const o = d.orders[0]!;
      // Выплаты мастеру нет ни у кого из них; цену и возвраты оператор видит (ТЗ п.5.12), руководитель — нет.
      expect(o).toMatchObject({ payoutValue: 0, payoutPaid: false });
      expect([o.acceptedPayout, o.payoutPaidAt]).toEqual([undefined, undefined]);
      if (who === s.ids.manager) expect([o.clientPrice, o.payments, o.refunds]).toEqual([0, [], undefined]);
      else expect(o.refunds).toHaveLength(1);
    }
    const own = await s.as(s.ids.owner).query(api.metrics.dashboard, { from: iso(s.now - 30 * DAY) });
    expect(own.orders[0]!.refunds).toHaveLength(1);
  });
});
