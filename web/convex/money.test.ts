/// <reference types="vite/client" />
// Деньги и машина статусов (ТЗ п.10, п.13; E1–E7; аудит L-4): оплаты с датой и проверками, сторно и возвраты владельца,
// автоматические «Ожидает оплаты» / «Оплачен», закрытие, повторное открытие, назначение с устаревшего экрана,
// условия мастера после принятия.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { doneWithin, sums } from "../src/data/analytics";
import { debt, paidAmount } from "../src/data/logic";
import { money } from "../src/lib/format";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString();

type TgCall = { chatId: string; text: string };
let telegram: TgCall[] = [];

beforeEach(() => {
  telegram = [];
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string | number; text?: string };
        telegram.push({ chatId: String(body.chat_id), text: String(body.text ?? "") });
        return Response.json({ ok: true, result: { message_id: telegram.length } });
      }
      return new Response("not found", { status: 404 });
    }),
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
    const mk = async (name: string, phone: string, chat?: string) => {
      const ex = await ctx.db.insert("executors", { tenantId: T, name, phone, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: ex, tenantId: T, active: true, telegramChatId: chat });
      return { ex, user };
    };
    const a = await mk("Асет Мастеров", "77000000001", "555");
    const b = await mk("Берик Второй", "77000000002");
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 1, lastActivityAt: at });
    return { owner, operator, a, b, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
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
        deadline: iso(now + DAY),
        priority: "normal",
        status: "in_progress",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        executorId: ids.a.ex,
        assignedAt: iso(now - 2 * DAY),
        createdAt: iso(now - 3 * DAY),
        createdBy: ids.owner,
        files: [],
        ...over,
      }),
    );
  const get = async (id: Id<"orders">) => (await t.run((ctx) => ctx.db.get(id)))!;
  const history = (id: Id<"orders">) => t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", id)).collect());
  const bells = (userId: Id<"users">) => t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
  const journal = (action: string) => t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((r) => r.action === action));
  const paidFull = (when = now - DAY) => [{ id: "p-full", amount: 30000, method: "kaspi" as const, at: iso(when) }];
  return { t, ids, as, now, mkOrder, get, history, bells, journal, paidFull };
}

describe("оплата (E3, аудит L-4)", () => {
  test("в новом заказе, в ленте, в отменённом и в возврате оплату не принимаем", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const cases: [Doc<"orders">["status"], string][] = [
      ["new", "после назначения"],
      ["awaiting_executor", "после назначения"],
      ["cancelled", "отменён"],
      ["refund", "возврат"],
    ];
    for (const [status, error] of cases) {
      const id = await s.mkOrder({ status, executorId: undefined });
      await expect(op.mutation(api.orders.addPayment, { id, amount: 5000, method: "cash" })).rejects.toThrow(error);
      expect((await s.get(id)).payments).toHaveLength(0);
    }
  });

  test("сумма — конечное число больше нуля: Infinity, NaN, ноль, минус и копейки — отказ", async () => {
    const s = await setup();
    const id = await s.mkOrder();
    const op = s.as(s.ids.operator);
    for (const amount of [Infinity, -Infinity, NaN, 0, -5000, 0.4]) {
      await expect(op.mutation(api.orders.addPayment, { id, amount, method: "kaspi" })).rejects.toThrow("больше нуля");
    }
    await expect(op.mutation(api.orders.addPayment, { id, amount: 2_000_000_000, method: "kaspi", confirmOverpay: true })).rejects.toThrow("слишком большая");
    expect((await s.get(id)).payments).toHaveLength(0);
  });

  test("дата оплаты: задним числом можно, в будущее и раньше создания заказа — нельзя; кто внёс и комментарий сохраняются", async () => {
    const s = await setup();
    const id = await s.mkOrder();
    const op = s.as(s.ids.operator);
    await expect(op.mutation(api.orders.addPayment, { id, amount: 5000, method: "cash", paidAt: iso(s.now + DAY) })).rejects.toThrow("в будущем");
    await expect(op.mutation(api.orders.addPayment, { id, amount: 5000, method: "cash", paidAt: iso(s.now - 10 * DAY) })).rejects.toThrow("раньше создания");
    await expect(op.mutation(api.orders.addPayment, { id, amount: 5000, method: "cash", paidAt: "вчера" })).rejects.toThrow("неверная дата");
    const yesterday = iso(s.now - DAY);
    await op.mutation(api.orders.addPayment, { id, amount: 5000, method: "cash", paidAt: yesterday, note: "  предоплата мастеру  " });
    const o = await s.get(id);
    expect(o.payments).toEqual([expect.objectContaining({ amount: 5000, method: "cash", at: yesterday, by: s.ids.operator, note: "предоплата мастеру" })]);
    expect(o.moneyAt).toBe(yesterday);
    expect(o.status).toBe("in_progress"); // предоплата по заказу в работе статус не меняет
    expect((await s.history(id)).at(-1)!.text).toContain("дата оплаты");
  });

  test("переплата — только с явным подтверждением", async () => {
    const s = await setup();
    const id = await s.mkOrder();
    const op = s.as(s.ids.operator);
    await expect(op.mutation(api.orders.addPayment, { id, amount: 35000, method: "kaspi" })).rejects.toThrow(`больше цены заказа на ${money(5000)}`);
    await op.mutation(api.orders.addPayment, { id, amount: 35000, method: "kaspi", confirmOverpay: true });
    expect(paidAmount(await s.get(id))).toBe(35000);
    expect((await s.journal("order.payment"))[0]!.meta).toMatchObject({ amount: 35000, overpay: 5000 });
  });

  test("оплаченный и закрытый заказ: деньги меняет только владелец", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "paid", payments: s.paidFull(), doneAt: iso(s.now - DAY) });
    const op = s.as(s.ids.operator);
    await expect(op.mutation(api.orders.addPayment, { id, amount: 1000, method: "cash", confirmOverpay: true })).rejects.toThrow("только владелец");
    await expect(op.mutation(api.orders.updateFinance, { id, clientPrice: 32000 })).rejects.toThrow("Менять деньги заказа");
    await s.as(s.ids.owner).mutation(api.orders.updateFinance, { id, clientPrice: 30000, payoutMode: "fixed", payoutValue: 20000 });
    expect((await s.get(id)).payoutValue).toBe(20000);
  });

  test("ручной «Оплачен» без денег — отказ «Сначала внесите оплату», фиктивного платежа нет (E2)", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "awaiting_payment", doneAt: iso(s.now - DAY), payments: [{ id: "p1", amount: 10000, method: "cash", at: iso(s.now - DAY) }] });
    const owner = s.as(s.ids.owner);
    await expect(owner.mutation(api.orders.changeStatus, { id, to: "paid" })).rejects.toThrow(`Сначала внесите оплату: не хватает ${money(20000)}`);
    expect((await s.get(id)).payments).toHaveLength(1);
    // Внесли остаток — «Оплачен» сам, без отдельного перехода.
    await owner.mutation(api.orders.addPayment, { id, amount: 20000, method: "kaspi" });
    const o = await s.get(id);
    expect(o.status).toBe("paid");
    expect(o.paidAt).toBeDefined();
    expect(o.payments.map((p) => p.amount)).toEqual([10000, 20000]);
    // Старый «Выполнен» с полной оплатой можно перевести вручную — без нового платежа.
    const legacy = await s.mkOrder({ status: "done", doneAt: iso(s.now - DAY), payments: s.paidFull() });
    await s.as(s.ids.operator).mutation(api.orders.changeStatus, { id: legacy, to: "paid" });
    expect(await s.get(legacy)).toMatchObject({ status: "paid", payments: [expect.objectContaining({ id: "p-full" })] });
  });
});

describe("машина статусов (ТЗ п.10)", () => {
  test("сдача работы: долг — «Ожидает оплаты», оплачено всё — «Оплачен»; переходы в истории структурно", async () => {
    const s = await setup();
    const unpaid = await s.mkOrder();
    const prepaid = await s.mkOrder({ payments: s.paidFull() });
    const byStaff = await s.mkOrder({ status: "awaiting_client" });
    const exec = s.as(s.ids.a.user);
    await exec.mutation(api.worker.act, { id: unpaid, action: "done" });
    await exec.mutation(api.worker.act, { id: prepaid, action: "done" });
    await s.as(s.ids.operator).mutation(api.orders.changeStatus, { id: byStaff, to: "done" });

    expect(await s.get(unpaid)).toMatchObject({ status: "awaiting_payment", doneAt: expect.any(String) });
    expect(await s.get(prepaid)).toMatchObject({ status: "paid", paidAt: expect.any(String) });
    expect((await s.get(byStaff)).status).toBe("awaiting_payment");
    const moves = (await s.history(unpaid)).filter((h) => h.from || h.to).map((h) => [h.from, h.to]);
    expect(moves).toEqual([
      ["in_progress", "done"],
      ["done", "awaiting_payment"],
    ]);
    // В журнале — одна запись на действие мастера, с итоговым статусом.
    const rows = (await s.journal("order.status")).filter((r) => r.entityId === unpaid);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toMatchObject({ from: "in_progress", to: "done", then: "awaiting_payment" });
    // Вернуть в работу из «Ожидает оплаты» можно — и снова сдать.
    await s.as(s.ids.operator).mutation(api.orders.changeStatus, { id: unpaid, to: "in_progress" });
    await exec.mutation(api.worker.act, { id: unpaid, action: "done" });
    expect((await s.get(unpaid)).status).toBe("awaiting_payment");
  });

  test("цену поменяли после оплаты — «Оплачен» ↔ «Ожидает оплаты» пересчитывается (E4)", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "paid", doneAt: iso(s.now - DAY), paidAt: iso(s.now - DAY), payments: s.paidFull() });
    const owner = s.as(s.ids.owner);
    await owner.mutation(api.orders.updateFinance, { id, clientPrice: 35000, payoutMode: "fixed", payoutValue: 21000 });
    let o = await s.get(id);
    expect(o.status).toBe("awaiting_payment");
    expect(o.paidAt).toBeUndefined();
    expect(debt(o)).toBe(5000);
    expect((await s.journal("order.finance")).at(-1)!.meta).toMatchObject({ status: { from: "paid", to: "awaiting_payment" } });
    await owner.mutation(api.orders.updateFinance, { id, clientPrice: 30000, payoutMode: "fixed", payoutValue: 21000 });
    o = await s.get(id);
    expect(o.status).toBe("paid");
  });

  test("сторно — только владелец: платёж остаётся с причиной, долг и статус пересчитаны", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "paid", doneAt: iso(s.now - DAY), payments: s.paidFull() });
    await expect(s.as(s.ids.operator).mutation(api.finance.voidPayment, { id, paymentId: "p-full", reason: "Ошибка" })).rejects.toThrow("Нет доступа");
    const owner = s.as(s.ids.owner);
    await expect(owner.mutation(api.finance.voidPayment, { id, paymentId: "p-full", reason: " " })).rejects.toThrow("укажите причину");
    await owner.mutation(api.finance.voidPayment, { id, paymentId: "p-full", reason: "Внесли дважды по ошибке" });
    const o = await s.get(id);
    expect(o.payments).toEqual([expect.objectContaining({ id: "p-full", amount: 30000, voidedBy: s.ids.owner, voidReason: "Внесли дважды по ошибке", voidedAt: expect.any(String) })]);
    expect(paidAmount(o)).toBe(0);
    expect(debt(o)).toBe(30000);
    expect(o.status).toBe("awaiting_payment");
    await expect(owner.mutation(api.finance.voidPayment, { id, paymentId: "p-full", reason: "Ещё раз" })).rejects.toThrow("уже сторнирован");
    expect((await s.journal("order.paymentVoided"))[0]!.meta).toMatchObject({ amount: 30000, paid: 0, status: { from: "paid", to: "awaiting_payment" } });
  });

  test("возврат — только владелец: частичный уменьшает выручку, полный — статус «Возврат» и выручки нет (E1)", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "paid", doneAt: iso(s.now - DAY), payments: s.paidFull() });
    const span = { from: s.now - 7 * DAY, to: s.now + DAY };
    await expect(s.as(s.ids.operator).mutation(api.finance.addRefund, { id, amount: 5000, method: "kaspi", reason: "Скидка за задержку" })).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.owner).mutation(api.orders.changeStatus, { id, to: "refund" })).rejects.toThrow("Возврат оформляется");
    const owner = s.as(s.ids.owner);
    await owner.mutation(api.finance.addRefund, { id, amount: 5000, method: "kaspi", reason: "Скидка за задержку" });
    let o = await s.get(id);
    expect(o.status).toBe("paid"); // частичный возврат статус не меняет
    expect(o.refunds).toEqual([expect.objectContaining({ amount: 5000, method: "kaspi", reason: "Скидка за задержку", by: s.ids.owner })]);
    expect(debt(o)).toBe(0);
    expect(sums(doneWithin([o], span))).toMatchObject({ revenue: 25000, payouts: 21000, margin: 4000 });

    await expect(owner.mutation(api.finance.addRefund, { id, amount: 30000, method: "kaspi", reason: "Брак" })).rejects.toThrow(`не больше полученного: ${money(25000)}`);
    await owner.mutation(api.finance.addRefund, { id, amount: 25000, method: "kaspi", reason: "Брак работы" });
    o = await s.get(id);
    expect(o.status).toBe("refund");
    expect(sums(doneWithin([o], span))).toMatchObject({ revenue: 0, count: 0 });
    expect((await s.history(id)).at(-1)).toMatchObject({ kind: "status", from: "paid", to: "refund" });
    expect((await s.journal("order.refund")).map((r) => r.meta)).toEqual([expect.objectContaining({ full: false }), expect.objectContaining({ full: true, status: { from: "paid", to: "refund" } })]);
    expect((await s.bells(s.ids.a.user)).some((n) => n.text.includes("оформлен возврат"))).toBe(true);
    // Возврат переплаты выручку не уменьшает.
    const over = await s.mkOrder({ status: "paid", doneAt: iso(s.now - DAY), payments: [{ id: "p-over", amount: 35000, method: "cash", at: iso(s.now - DAY) }] });
    await owner.mutation(api.finance.addRefund, { id: over, amount: 5000, method: "cash", reason: "Вернули переплату" });
    expect(sums(doneWithin([await s.get(over)], span)).revenue).toBe(30000);
  });

  test("отменённый заказ, открытый заново, — снова ничей (E5)", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "accepted", acceptedPayout: 21000 });
    const owner = s.as(s.ids.owner);
    await owner.mutation(api.orders.changeStatus, { id, to: "cancelled", reason: "Клиент передумал" });
    expect((await s.get(id)).executorId).toBe(s.ids.a.ex); // у мастера отмена видна в «Завершённых»
    await owner.mutation(api.orders.changeStatus, { id, to: "new" });
    const o = await s.get(id);
    expect(o.status).toBe("new");
    expect([o.executorId, o.assignedAt, o.acceptedPayout, o.cancelReason]).toEqual([undefined, undefined, undefined, undefined]);
    const mine = await s.as(s.ids.a.user).query(api.worker.mine, {});
    expect(mine.orders.map((x) => x.id)).not.toContain(id);
  });

  test("закрыть с долгом или без выплаты исполнителю — только владелец и с причиной", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "paid", doneAt: iso(s.now - DAY), payments: s.paidFull() });
    await expect(s.as(s.ids.operator).mutation(api.orders.changeStatus, { id, to: "closed" })).rejects.toThrow("только владелец");
    const owner = s.as(s.ids.owner);
    await expect(owner.mutation(api.orders.changeStatus, { id, to: "closed" })).rejects.toThrow("Укажите причину");
    await owner.mutation(api.orders.changeStatus, { id, to: "closed", reason: "Мастер получил наличными на месте" });
    expect((await s.get(id)).status).toBe("closed");
    expect((await s.history(id)).at(-1)!.text).toContain("Мастер получил наличными на месте");
    expect((await s.journal("order.status")).at(-1)!.meta).toMatchObject({ to: "closed", forced: [`выплата исполнителю ${money(21000)} не проведена`] });
    // Деньги закрыты — закрыть может и оператор.
    const clean = await s.mkOrder({ status: "paid", doneAt: iso(s.now - DAY), payments: s.paidFull(), payoutPaid: true });
    await s.as(s.ids.operator).mutation(api.orders.changeStatus, { id: clean, to: "closed" });
    expect((await s.get(clean)).status).toBe("closed");
    // Долг списан владельцем.
    const owing = await s.mkOrder({ status: "awaiting_payment", doneAt: iso(s.now - DAY), payoutPaid: true });
    await owner.mutation(api.orders.changeStatus, { id: owing, to: "closed", reason: "Долг списан по договорённости" });
    expect((await s.get(owing)).status).toBe("closed");
  });

  test("назначение с устаревшего экрана не перебивает мастера, который только что взял заказ (E6)", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "awaiting_executor", executorId: undefined, assignedAt: undefined });
    await s.as(s.ids.a.user).mutation(api.worker.take, { id });
    const owner = s.as(s.ids.owner);
    await expect(owner.mutation(api.orders.assign, { id, executorId: s.ids.b.ex, expectedStatus: "awaiting_executor", expectedExecutorId: null })).rejects.toThrow("Заказ уже у исполнителя Асет М.");
    expect((await s.get(id)).executorId).toBe(s.ids.a.ex);
    await expect(owner.mutation(api.orders.assign, { id, executorId: s.ids.b.ex, expectedStatus: "awaiting_executor", expectedExecutorId: s.ids.a.ex })).rejects.toThrow("уже в статусе «Принят исполнителем»");
    // Сотрудник увидел актуальную карточку и всё же передаёт заказ — можно.
    await owner.mutation(api.orders.assign, { id, executorId: s.ids.b.ex, expectedStatus: "accepted", expectedExecutorId: s.ids.a.ex });
    const o = await s.get(id);
    expect(o).toMatchObject({ executorId: s.ids.b.ex, status: "assigned" });
    expect(o.acceptedPayout).toBeUndefined();
    expect((await s.history(id)).at(-1)).toMatchObject({ kind: "assigned", from: "accepted", to: "assigned" });
  });
});

describe("условия мастера после принятия (E7)", () => {
  test("выплата фиксируется, когда мастер взял или подтвердил заказ; отказ её снимает", async () => {
    const s = await setup();
    const feed = await s.mkOrder({ status: "awaiting_executor", executorId: undefined, assignedAt: undefined });
    const exec = s.as(s.ids.a.user);
    await exec.mutation(api.worker.take, { id: feed });
    expect((await s.get(feed)).acceptedPayout).toBe(21000);
    const assigned = await s.mkOrder({ status: "assigned", payoutMode: "percent", payoutValue: 70 });
    await exec.mutation(api.worker.act, { id: assigned, action: "accept" });
    expect((await s.get(assigned)).acceptedPayout).toBe(21000);
    await exec.mutation(api.worker.act, { id: assigned, action: "decline" });
    const back = await s.get(assigned);
    expect(back.status).toBe("awaiting_executor");
    expect([back.executorId, back.acceptedPayout]).toEqual([undefined, undefined]);
  });

  test("выплату поменяли после принятия — мастеру колокольчик и Telegram «было → стало», след в истории и журнале", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "accepted", acceptedPayout: 21000 });
    await s.as(s.ids.owner).mutation(api.orders.updateFinance, { id, clientPrice: 30000, payoutMode: "fixed", payoutValue: 18000 });
    const text = `Выплата по заказу №${(await s.get(id)).number} изменена: ${money(21000)} → ${money(18000)}`;
    expect((await s.bells(s.ids.a.user)).map((n) => n.text)).toEqual([text]);
    await s.t.finishAllScheduledFunctions(() => {});
    // Отложенные отправки других тестов могут догнать этот — ищем своё сообщение.
    expect(telegram).toContainEqual({ chatId: "555", text: text });
    expect((await s.history(id)).at(-1)!.text).toContain("исполнитель уведомлён");
    expect((await s.journal("order.finance"))[0]!.meta).toMatchObject({ executorNotified: true, acceptedPayout: 21000 });
    // Поменялась только цена клиента, выплата та же — мастера не дёргаем.
    await s.as(s.ids.owner).mutation(api.orders.updateFinance, { id, clientPrice: 32000, payoutMode: "fixed", payoutValue: 18000 });
    expect(await s.bells(s.ids.a.user)).toHaveLength(1);
  });

  test("срок, адрес и описание после принятия — мастеру с разницей; неподтверждённому — нет", async () => {
    const s = await setup();
    const id = await s.mkOrder({ status: "accepted" });
    const o = await s.get(id);
    await s.as(s.ids.operator).mutation(api.orders.updateInfo, {
      id,
      serviceId: o.serviceId,
      description: "Не холодит, течёт вода",
      city: o.city,
      address: "ул. Абая, 5",
      deadline: "2026-12-01T13:00:00.000Z",
      priority: o.priority,
    });
    const [bell] = await s.bells(s.ids.a.user);
    expect(bell!.text).toContain(`Заказ №${o.number} изменён`);
    expect(bell!.text).toContain("срок");
    expect(bell!.text).toContain("01.12.2026 18:00");
    expect(bell!.text).toContain("адрес «ул. Абая, 1» → «ул. Абая, 5»");
    expect(bell!.text).toContain("описание изменено");
    expect((await s.journal("order.info"))[0]!.meta).toMatchObject({ executorNotified: true });

    const unconfirmed = await s.mkOrder({ status: "assigned", executorId: s.ids.b.ex });
    const u = await s.get(unconfirmed);
    await s.as(s.ids.operator).mutation(api.orders.updateInfo, { id: unconfirmed, serviceId: u.serviceId, description: u.description, city: u.city, address: "ул. Абая, 9", deadline: u.deadline, priority: u.priority });
    expect(await s.bells(s.ids.b.user)).toHaveLength(0);
  });
});
