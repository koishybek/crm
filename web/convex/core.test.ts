/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

// Шаблон из документации convex-test с `!(…)` в Vite 8 ничего не находит — фильтруем вручную.
const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const at = new Date().toISOString();

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор Тест", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const mk = async (name: string, phone: string, city: string) => {
      const ex = await ctx.db.insert("executors", { tenantId: T, name, phone, city, categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: ex, tenantId: T, active: true });
      return { ex, user };
    };
    const a = await mk("Асет Алматы", "77000000001", "Алматы");
    const b = await mk("Берик Алматы", "77000000002", "Алматы");
    const c = await mk("Серик Астана", "77000000003", "Астана");
    const client = await ctx.db.insert("clients", {
      tenantId: T,
      name: "Клиент Тест",
      kind: "person",
      phone: "77071234567",
      city: "Алматы",
      source: "olx",
      tags: [],
      createdAt: at,
      ordersCount: 0,
      activeCount: 0,
      lastActivityAt: at,
    });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Клиент Тест",
      clientPhone: "77071234567",
      source: "olx",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      priority: "normal",
      status: "awaiting_executor",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      createdAt: at,
      createdBy: owner,
      files: [],
    });
    return { owner, operator, a, b, c, client, order };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|test-session` });
  return { t, ids, as };
}

describe("доступ по ролям", () => {
  test("исполнитель не может читать CRM и менять финансы", async () => {
    const { ids, as } = await setup();
    const exec = as(ids.a.user);
    await expect(exec.query(api.orders.board, {})).rejects.toThrow("Нет доступа");
    await expect(exec.query(api.clients.list, {})).rejects.toThrow("Нет доступа");
    await expect(exec.mutation(api.orders.updateFinance, { id: ids.order, clientPrice: 1, payoutMode: "fixed", payoutValue: 1, payoutPaid: false })).rejects.toThrow("Нет доступа");
  });

  test("без входа — ничего", async () => {
    const { t } = await setup();
    await expect(t.query(api.orders.board, {})).rejects.toThrow("Нужно войти");
    expect(await t.query(api.users.me, {})).toBeNull();
  });

  test("оператору аналитика закрыта, владельцу открыта", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.operator).query(api.metrics.analytics, { from: at })).rejects.toThrow("Нет доступа");
    const slice = await as(ids.owner).query(api.metrics.analytics, { from: new Date(0).toISOString() });
    expect(slice.orders).toHaveLength(1);
  });

  test("отключённый пользователь теряет доступ", async () => {
    const { ids, as } = await setup();
    await as(ids.owner).mutation(api.users.setActive, { userId: ids.operator, active: false });
    await expect(as(ids.operator).query(api.orders.board, {})).rejects.toThrow("Нужно войти");
  });
});

describe("лента исполнителя", () => {
  test("видит заказ своего города без цены клиента; чужой город — не видит", async () => {
    const { ids, as } = await setup();
    const feed = await as(ids.a.user).query(api.worker.feed, {});
    expect(feed.feed).toHaveLength(1);
    const card = feed.feed[0]!;
    expect(card.payout).toBe(21000);
    expect(card).not.toHaveProperty("clientPrice");
    expect(card.clientPhone).toBeUndefined();
    expect(card.address).toBeUndefined();
    const astana = await as(ids.c.user).query(api.worker.feed, {});
    expect(astana.feed).toHaveLength(0);
  });

  test("«Взять заказ»: второй исполнитель получает отказ", async () => {
    const { t, ids, as } = await setup();
    await as(ids.a.user).mutation(api.worker.take, { id: ids.order });
    await expect(as(ids.b.user).mutation(api.worker.take, { id: ids.order })).rejects.toThrow("уже взял другой исполнитель");
    const o = await t.run((ctx) => ctx.db.get(ids.order));
    expect(o?.executorId).toBe(ids.a.ex);
    expect(o?.status).toBe("accepted");
  });

  test("одновременные «Взять заказ» — побеждает ровно один", async () => {
    const { t, ids, as } = await setup();
    const results = await Promise.allSettled([as(ids.a.user).mutation(api.worker.take, { id: ids.order }), as(ids.b.user).mutation(api.worker.take, { id: ids.order })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const o = await t.run((ctx) => ctx.db.get(ids.order));
    expect([ids.a.ex, ids.b.ex]).toContain(o?.executorId);
  });

  test("исполнитель из другого города не может взять заказ по прямому id", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.c.user).mutation(api.worker.take, { id: ids.order })).rejects.toThrow("не подходит");
  });

  test("после подтверждения исполнитель видит адрес и телефон клиента", async () => {
    const { ids, as } = await setup();
    await as(ids.a.user).mutation(api.worker.take, { id: ids.order });
    const d = await as(ids.a.user).query(api.worker.order, { id: ids.order });
    expect(d?.order.address).toBe("ул. Абая, 1");
    expect(d?.order.clientPhone).toBe("77071234567");
    expect(await as(ids.b.user).query(api.worker.order, { id: ids.order })).toBeNull();
  });
});

describe("заказ: деньги и статусы", () => {
  test("выплата больше цены клиента — отказ", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.owner).mutation(api.orders.updateFinance, { id: ids.order, clientPrice: 10000, payoutMode: "fixed", payoutValue: 15000, payoutPaid: false })).rejects.toThrow("маржа уйдёт в минус");
  });

  test("недопустимый переход статуса — отказ", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.owner).mutation(api.orders.changeStatus, { id: ids.order, to: "closed" })).rejects.toThrow("нельзя перейти");
  });

  test("опубликовать без цены нельзя", async () => {
    const { t, ids, as } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { status: "new", clientPrice: 0 }));
    await expect(as(ids.owner).mutation(api.orders.changeStatus, { id: ids.order, to: "awaiting_executor" })).rejects.toThrow("укажите цену");
  });

  test("полная оплата выполненного заказа переводит его в «Оплачен»", async () => {
    const { t, ids, as } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { status: "done", executorId: ids.a.ex }));
    await as(ids.owner).mutation(api.orders.addPayment, { id: ids.order, amount: 30000, method: "kaspi" });
    const o = await t.run((ctx) => ctx.db.get(ids.order));
    expect(o?.status).toBe("paid");
  });
});

describe("заявки", () => {
  test("заявка с номером существующего клиента не создаёт дубль, номер переходит в заказ", async () => {
    const { t, ids, as } = await setup();
    const lead = await as(ids.operator).mutation(api.leads.create, {
      clientName: "Кто-то другой",
      phone: "+7 (707) 123-45-67",
      source: "whatsapp",
      serviceId: "ac-clean",
      city: "Алматы",
      description: "Чистка",
      urgency: "normal",
    });
    const clients = await t.run((ctx) => ctx.db.query("clients").collect());
    expect(clients).toHaveLength(1);
    const order = await as(ids.operator).mutation(api.leads.convert, { id: lead.id });
    expect(order.number).toBe(lead.number);
    const o = await t.run((ctx) => ctx.db.get(order.id));
    expect(o?.clientId).toBe(ids.client);
  });
});

describe("руководитель направления", () => {
  async function withManager() {
    const s = await setup();
    const extra = await s.t.run(async (ctx) => {
      const manager = await ctx.db.insert("users", { name: "Руководитель Климат", email: "lead@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
      const plumber = await ctx.db.insert("executors", { tenantId: T, name: "Сантехник", phone: "77000000009", city: "Алматы", categories: ["plumbing"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
      const base = (await ctx.db.get(s.ids.order))!;
      const { _id: _x, _creationTime: _y, ...copy } = base;
      void _x;
      void _y;
      const foreign = await ctx.db.insert("orders", { ...copy, number: 1002, serviceId: "leak-fix", category: "plumbing" });
      return { manager, plumber, foreign };
    });
    return { ...s, extra };
  }

  test("видит только заказы и исполнителей своих направлений", async () => {
    const { ids, as, extra } = await withManager();
    const m = as(extra.manager);
    const board = await m.query(api.orders.board, {});
    expect(board.map((o) => o.id)).toEqual([ids.order]);
    expect(await m.query(api.orders.detail, { id: extra.foreign })).toBeNull();
    const ex = await m.query(api.executors.list, {});
    expect(ex.executors.some((e) => e.id === extra.plumber)).toBe(false);
  });

  test("не может менять чужое направление и не видит клиентов", async () => {
    const { as, extra } = await withManager();
    const m = as(extra.manager);
    await expect(m.mutation(api.orders.changeStatus, { id: extra.foreign, to: "new" })).rejects.toThrow("не ваше направление");
    await expect(m.query(api.clients.list, {})).rejects.toThrow("Нет доступа");
  });
});

describe("справочник услуг", () => {
  test("правит только владелец; новая услуга сразу доступна в заявках", async () => {
    const { ids, as } = await setup();
    const svc = { category: "it", label: "Настройка сервера", icon: "monitor", priceMin: 50000, priceMax: 90000, payoutPct: 60, examples: [], active: true };
    await expect(as(ids.operator).mutation(api.catalog.saveService, svc)).rejects.toThrow("Нет доступа");
    const key = await as(ids.owner).mutation(api.catalog.saveService, svc);
    const list = await as(ids.operator).query(api.catalog.list, {});
    expect(list?.services.find((s) => s.id === key)?.label).toBe("Настройка сервера");
    expect(list?.services.length).toBeGreaterThan(20); // значения по умолчанию перенеслись в базу
    const lead = await as(ids.operator).mutation(api.leads.create, { clientName: "ИТ Клиент", phone: "77079990011", source: "site", serviceId: key, city: "Алматы", description: "Поднять сервер", urgency: "normal" });
    expect(lead.number).toBeGreaterThan(0);
  });

  test("заявка с несуществующей услугой — отказ", async () => {
    const { ids, as } = await setup();
    await expect(
      as(ids.operator).mutation(api.leads.create, { clientName: "Х", phone: "77079990012", source: "site", serviceId: "nope", city: "Алматы", description: "x", urgency: "normal" }),
    ).rejects.toThrow("нет в справочнике");
  });
});
