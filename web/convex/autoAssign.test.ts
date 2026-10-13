/// <reference types="vite/client" />
// Автораспределение заказов («AI-подбор», ТЗ п.23): кому система отдаёт заказ, когда, что бывает при отказе
// или молчании мастера и когда кандидаты кончились.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const MIN = 60_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function setup(opts: { inFeedFor?: number } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const at = iso(0);
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const managerAc = await ctx.db.insert("users", { name: "Руководитель кондиционеров", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const managerOther = await ctx.db.insert("users", { name: "Руководитель сантехники", email: "pl@test.kz", role: "manager", categories: ["plumbing"], tenantId: T, active: true });
    const executor = async (name: string, e: Partial<Doc<"executors">> = {}, active = true) => {
      const id = await ctx.db.insert("executors", { tenantId: T, name, phone: `7700${Math.random().toString().slice(2, 9)}`, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 4.5, reviews: 3, cooperation: "freelance", joinedAt: at, ...e });
      const user = await ctx.db.insert("users", { name, email: `${name}@ex.kz`, role: "executor", executorId: id, tenantId: T, active, telegramChatId: `tg-${name}` });
      return { id, user };
    };
    const asel = await executor("Асель Свободная", { rating: 4.5 });
    const bauyr = await executor("Бауыржан Лучший", { rating: 4.9 });
    const viktor = await executor("Виктор Занятой", { rating: 5 });
    await executor("Дамир Астанинский", { rating: 5, city: "Астана" });
    await executor("Ержан Уволенный", { rating: 5 }, false);
    await executor("Фарид Выходной", { rating: 5, available: false });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 2, activeCount: 2, lastActivityAt: at });
    const base = {
      tenantId: T,
      clientId: client,
      clientName: "Клиент",
      clientPhone: "77071234567",
      source: "olx" as const,
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: iso(-86_400_000),
      priority: "normal" as const,
      clientPrice: 30000,
      payoutMode: "fixed" as const,
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      createdAt: iso(2 * 3_600_000),
      createdBy: operator,
      files: [],
    };
    // Виктор уже на заказе — при прочих равных свободные идут раньше.
    await ctx.db.insert("orders", { ...base, number: 1000, status: "in_progress", executorId: viktor.id, assignedAt: at });
    const order = await ctx.db.insert("orders", { ...base, number: 1001, status: "awaiting_executor" });
    await ctx.db.insert("history", { orderId: order, kind: "status", text: "Опубликован в ленту исполнителей", actor: { type: "user", id: operator }, at: iso(opts.inFeedFor ?? 40 * MIN) });
    return { owner, operator, managerAc, managerOther, asel, bauyr, viktor, order };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const enable = (minutes = 30) => as(ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes });
  const run = () => t.mutation(internal.autoAssign.run, {});
  const order = () => t.run(async (ctx) => (await ctx.db.get(ids.order))!);
  const notes = (user: Id<"users">) => t.run(async (ctx) => (await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", user)).collect()).map((n) => n.text));
  return { t, ids, as, enable, run, order, notes };
}

describe("настройки автораспределения", () => {
  test("по умолчанию выключено: заказ остаётся в ленте", async () => {
    const { ids, as, run, order } = await setup();
    expect(await as(ids.owner).query(api.autoAssign.settings, {})).toEqual({ enabled: false, minutes: 30 });
    expect(await run()).toEqual({ assigned: 0, returned: 0, exhausted: 0 });
    expect((await order()).status).toBe("awaiting_executor");
  });

  test("меняет только владелец, время — от 5 минут до суток, изменение — в журнале", async () => {
    const { t, ids, as } = await setup();
    await expect(as(ids.operator).mutation(api.autoAssign.configure, { enabled: true, minutes: 30 })).rejects.toThrow("Нет доступа");
    await expect(as(ids.operator).query(api.autoAssign.settings, {})).rejects.toThrow("Нет доступа");
    await expect(as(ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 3 })).rejects.toThrow("от 5 до 1440");
    await expect(as(ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 12.5 })).rejects.toThrow("от 5 до 1440");
    expect(await as(ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 45 })).toEqual({ enabled: true, minutes: 45 });
    expect(await as(ids.owner).query(api.autoAssign.settings, {})).toEqual({ enabled: true, minutes: 45 });
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((a) => a.action === "settings.autoAssign")?.summary).toContain("включено: 45 мин");
  });
});

describe("подбор исполнителя", () => {
  test("заказ N минут в ленте — назначен лучший подходящий свободный, с кнопками «Подтвердить / Отказаться»", async () => {
    const { t, ids, enable, run, order, notes } = await setup();
    await enable();
    expect(await run()).toEqual({ assigned: 1, returned: 0, exhausted: 0 });
    const o = await order();
    // Бауыржан: подходит, свободен, рейтинг выше Асель; Виктор занят, Дамир в другом городе,
    // Ержан уволен, Фарид на выходном.
    expect(o).toMatchObject({ status: "assigned", executorId: ids.bauyr.id, autoOffered: [ids.bauyr.id] });
    expect(o.autoAssignedAt).toBe(o.assignedAt);
    expect((await notes(ids.bauyr.user))[0]).toBe("Вам назначен заказ №1001: Ремонт кондиционера. Подтвердите в течение 30 мин — иначе заказ передадим другому мастеру");

    const sent = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const tg = sent.map((s) => s.args[0] as { chatId?: string; buttons?: { data?: string }[][] }).find((a) => a.chatId === "tg-Бауыржан Лучший");
    expect(tg?.buttons?.[0]?.map((b) => b.data)).toEqual([`act:accept:${ids.order}`, `act:decline:${ids.order}`]);

    const history = await t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", ids.order)).collect());
    expect(history.at(-1)).toMatchObject({ kind: "assigned", actor: { type: "system" } });
    expect(history.at(-1)!.text).toBe("AI-подбор: назначен Бауыржан Л. — свободен, заказов в работе: 0, рейтинг 4,9. Ждём подтверждения 30 мин");
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((a) => a.action === "order.autoAssigned")).toMatchObject({ actorName: "Система", entityId: ids.order });
  });

  test("заказ в ленте меньше N минут — ещё ждём, вдруг возьмут сами", async () => {
    const { enable, run, order } = await setup({ inFeedFor: 10 * MIN });
    await enable();
    expect(await run()).toEqual({ assigned: 0, returned: 0, exhausted: 0 });
    expect((await order()).status).toBe("awaiting_executor");
    await enable(5);
    await run();
    expect((await order()).status).toBe("assigned");
  });

  test("кому уже предлагали — пропускаем: следующий по порядку", async () => {
    const { t, ids, enable, run, order } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { autoOffered: [ids.bauyr.id] }));
    await enable();
    await run();
    // Асель свободна — раньше Виктора, хоть у него рейтинг выше: он уже на заказе.
    expect((await order()).executorId).toBe(ids.asel.id);
    expect((await order()).autoOffered).toEqual([ids.bauyr.id, ids.asel.id]);
  });
});

describe("отказ, молчание и конец списка", () => {
  test("не подтвердил за N минут — заказ снова в ленте, следующему — на следующем запуске", async () => {
    const { t, ids, enable, run, order, notes } = await setup();
    const assignedAt = iso(31 * MIN);
    await t.run((ctx) => ctx.db.patch(ids.order, { status: "assigned", executorId: ids.bauyr.id, assignedAt, autoAssignedAt: assignedAt, autoOffered: [ids.bauyr.id] }));
    await enable();
    expect(await run()).toEqual({ assigned: 0, returned: 1, exhausted: 0 });
    const back = await order();
    expect(back.status).toBe("awaiting_executor");
    expect(back.executorId).toBeUndefined();
    expect(await notes(ids.bauyr.user)).toContain("Заказ №1001 снят с вас: не подтвердили за 30 мин");
    // Остальные подходящие узнают, что заказ снова свободен.
    expect((await notes(ids.asel.user))[0]).toContain("Снова свободен заказ №1001");

    expect(await run()).toEqual({ assigned: 1, returned: 0, exhausted: 0 });
    expect((await order()).executorId).toBe(ids.asel.id);
  });

  test("назначение, которое сотрудник поменял вручную, система не снимает", async () => {
    const { t, ids, enable, run, order } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { status: "assigned", executorId: ids.asel.id, assignedAt: iso(35 * MIN), autoAssignedAt: iso(50 * MIN), autoOffered: [ids.bauyr.id] }));
    await enable();
    expect(await run()).toEqual({ assigned: 0, returned: 0, exhausted: 0 });
    expect((await order()).executorId).toBe(ids.asel.id);
  });

  test("мастер отказался — на следующем запуске заказ получает следующий", async () => {
    const { ids, as, enable, run, order } = await setup();
    await enable();
    await run();
    expect((await order()).executorId).toBe(ids.bauyr.id);
    await as(ids.bauyr.user).mutation(api.worker.act, { id: ids.order, action: "decline" });
    expect((await order()).status).toBe("awaiting_executor");
    await run();
    expect((await order())).toMatchObject({ status: "assigned", executorId: ids.asel.id, autoOffered: [ids.bauyr.id, ids.asel.id] });
  });

  test("предлагать больше некому — одно уведомление владельцу и руководителю направления", async () => {
    const { t, ids, enable, run, order, notes } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { autoOffered: [ids.bauyr.id, ids.asel.id, ids.viktor.id] }));
    await enable();
    expect(await run()).toEqual({ assigned: 0, returned: 0, exhausted: 1 });
    const text = "Заказ №1001: заказ не принял никто из подходящих мастеров (предлагали: 3) — назначьте исполнителя вручную";
    expect(await notes(ids.owner)).toEqual([text]);
    expect(await notes(ids.managerAc)).toEqual([text]);
    expect(await notes(ids.managerOther)).toEqual([]);
    expect(await notes(ids.operator)).toEqual([]);
    expect((await order()).status).toBe("awaiting_executor");

    expect(await run()).toEqual({ assigned: 0, returned: 0, exhausted: 0 });
    expect(await notes(ids.owner)).toHaveLength(1);
  });

  test("выключили — система ничего не трогает, даже просроченное подтверждение", async () => {
    const { t, ids, as, enable, run, order } = await setup();
    const assignedAt = iso(40 * MIN);
    await t.run((ctx) => ctx.db.patch(ids.order, { status: "assigned", executorId: ids.bauyr.id, assignedAt, autoAssignedAt: assignedAt, autoOffered: [ids.bauyr.id] }));
    await enable();
    await as(ids.owner).mutation(api.autoAssign.configure, { enabled: false, minutes: 30 });
    expect(await run()).toEqual({ assigned: 0, returned: 0, exhausted: 0 });
    expect((await order()).executorId).toBe(ids.bauyr.id);
  });
});
