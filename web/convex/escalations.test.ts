/// <reference types="vite/client" />
// Эскалации и сроки реакции (ТЗ п.15, п.18; gaps #10, E8): с фиктивным временем — каждый уровень срабатывает
// один раз за эпизод, автораспределение и эскалации не шлют одно и то же дважды, рабочее время операторов.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { parseSla, SLA_DEFAULTS, slaProblem, workingMs } from "../src/data/escalations";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 14.10.2026 11:00 по Алматы (UTC+5) — рабочее время операторов. */
const BASE = Date.UTC(2026, 9, 14, 6, 0, 0);
const iso = (t: number) => new Date(t).toISOString();

let now = BASE;
const at = (t: number) => {
  now = t;
  vi.setSystemTime(new Date(t));
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(BASE);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const created = iso(BASE - 30 * DAY);
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const managerAc = await ctx.db.insert("users", { name: "Руководитель кондиционеров", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const managerPl = await ctx.db.insert("users", { name: "Руководитель сантехники", email: "pl@test.kz", role: "manager", categories: ["plumbing"], tenantId: T, active: true });
    const mkExecutor = async (name: string, phone: string, e: Partial<Doc<"executors">> = {}) => {
      const id = await ctx.db.insert("executors", { tenantId: T, name, phone, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: created, ...e });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: id, tenantId: T, active: true });
      return { id, user };
    };
    const asel = await mkExecutor("Асель Мастер", "77000000001");
    const bauyr = await mkExecutor("Бауыржан Мастер", "77000000002");
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: created, ordersCount: 0, activeCount: 0, lastActivityAt: created });
    return { owner, operator, managerAc, managerPl, asel, bauyr, client };
  });
  let number = 1000;
  /** Заказ; inFeedAt — когда он в последний раз сменил статус (попал в ленту). */
  const mkOrder = (over: Partial<Doc<"orders">> = {}, inFeedAt = now) =>
    t.run(async (ctx) => {
      const id = await ctx.db.insert("orders", {
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
        deadline: iso(now + 2 * DAY),
        priority: "normal",
        status: "awaiting_executor",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        createdAt: iso(inFeedAt - HOUR),
        createdBy: ids.operator,
        files: [],
        ...over,
      });
      await ctx.db.insert("history", { orderId: id, kind: "status", text: "Опубликован в ленту исполнителей", actor: { type: "user", id: ids.operator }, at: iso(inFeedAt) });
      return id;
    });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const pass = () => t.mutation(internal.escalations._pass, {});
  const notes = (user: Id<"users">) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", user))
          .collect()
      ).map((n) => n.text),
    );
  const order = (id: Id<"orders">) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const journal = (action: string) => t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((a) => a.action === action));
  return { t, ids, mkOrder, as, pass, notes, order, journal };
}

describe("заказ в ленте без исполнителя", () => {
  test("30 мин — руководителю направления, 2 ч — владельцу; каждый уровень один раз, автор журнала — «Система»", async () => {
    const s = await setup();
    const o = await s.mkOrder();
    at(BASE + 29 * MIN);
    expect((await s.pass()).feed).toBe(0);
    at(BASE + 31 * MIN);
    expect((await s.pass()).feed).toBe(1);
    expect(await s.notes(s.ids.managerAc)).toEqual(["Заказ №1001 (Ремонт кондиционера): 31 мин в ленте, никто не взял — назначьте исполнителя"]);
    expect(await s.notes(s.ids.owner)).toEqual([]);
    expect(await s.notes(s.ids.managerPl)).toEqual([]);
    expect(await s.notes(s.ids.operator)).toEqual([]);
    // Тот же уровень второй раз не срабатывает.
    at(BASE + 90 * MIN);
    expect((await s.pass()).feed).toBe(0);
    at(BASE + 2 * HOUR + MIN);
    expect((await s.pass()).feed).toBe(1);
    expect(await s.notes(s.ids.owner)).toHaveLength(1);
    expect((await s.notes(s.ids.owner))[0]).toContain("2 ч 1 мин в ленте");
    expect(await s.notes(s.ids.managerAc)).toHaveLength(1);
    at(BASE + 6 * HOUR);
    expect((await s.pass()).feed).toBe(0);

    const rows = await s.journal("order.escalated");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.actorName)).toEqual(["Система", "Система"]);
    expect(rows[0]!.summary).toContain("сообщили руководителю направления");
    expect(rows[1]!.summary).toContain("сообщили владельцу");
    const history = await s.t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", o)).collect());
    expect(history.filter((h) => h.text.startsWith("Эскалация")).map((h) => h.kind)).toEqual(["comment", "comment"]);
  });

  test("заказ снова попал в ленту — новый эпизод, уровни заново; пропущенные уровни приходят одним сообщением", async () => {
    const s = await setup();
    const o = await s.mkOrder();
    at(BASE + 31 * MIN);
    await s.pass();
    // Мастер взял и отказался — заказ снова в ленте с этого момента.
    await s.t.run((ctx) => ctx.db.insert("history", { orderId: o, kind: "status", text: "Исполнитель отказался, заказ вернулся в ленту", actor: { type: "system" }, at: iso(BASE + 50 * MIN) }));
    at(BASE + 70 * MIN);
    expect((await s.pass()).feed).toBe(0);
    at(BASE + 82 * MIN);
    expect((await s.pass()).feed).toBe(1);
    expect(await s.notes(s.ids.managerAc)).toHaveLength(2);
    // Крон не работал: заказ сразу 3 ч в ленте — руководитель и владелец узнают в одном проходе, по одному разу.
    const late = await s.mkOrder({}, BASE + 82 * MIN - 3 * HOUR);
    expect((await s.pass()).feed).toBe(1);
    const lateNo = (await s.order(late)).number;
    expect((await s.notes(s.ids.owner)).filter((x) => x.includes(`№${lateNo}`))).toHaveLength(1);
    expect(await s.notes(s.ids.managerAc)).toHaveLength(3);
  });

  test("у направления нет руководителя — первый уровень получает владелец", async () => {
    const s = await setup();
    await s.mkOrder({ serviceId: "cleaning", category: "cleaning" });
    at(BASE + 31 * MIN);
    await s.pass();
    expect(await s.notes(s.ids.owner)).toHaveLength(1);
    expect((await s.journal("order.escalated"))[0]!.summary).toContain("сообщили владельцу");
  });

  test("давняя история (заказ неделю в ленте) после запуска не засыпает уведомлениями", async () => {
    const s = await setup();
    await s.mkOrder({}, BASE - 7 * DAY);
    expect((await s.pass()).feed).toBe(0);
  });
});

describe("эскалации и автораспределение не дублируют друг друга", () => {
  test("предлагать некому: автораспределение зовёт руководителя и владельца один раз — эскалации молчат", async () => {
    const s = await setup();
    await s.as(s.ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 30 });
    // Подходящих на смене нет.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ids.asel.id, { available: false });
      await ctx.db.patch(s.ids.bauyr.id, { available: false });
    });
    await s.mkOrder();
    at(BASE + 31 * MIN);
    expect(await s.t.action(internal.escalations.run, {})).toEqual({ failed: [] });
    const text = "Заказ №1001: подходящих мастеров на смене нет — назначьте исполнителя вручную";
    expect(await s.notes(s.ids.managerAc)).toEqual([text]);
    expect(await s.notes(s.ids.owner)).toEqual([text]);
    at(BASE + 3 * HOUR);
    await s.t.action(internal.escalations.run, {});
    expect(await s.notes(s.ids.managerAc)).toHaveLength(1);
    expect(await s.notes(s.ids.owner)).toHaveLength(1);
    expect(await s.journal("order.escalated")).toHaveLength(0);
  });

  test("руководителю уже сообщили (30 мин), автораспределение ждёт час — когда кандидаты кончились, сообщение только владельцу", async () => {
    const s = await setup();
    await s.as(s.ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 60 });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ids.asel.id, { available: false });
      await ctx.db.patch(s.ids.bauyr.id, { available: false });
    });
    await s.mkOrder();
    at(BASE + 31 * MIN);
    await s.t.action(internal.escalations.run, {});
    expect(await s.notes(s.ids.managerAc)).toHaveLength(1);
    expect(await s.notes(s.ids.owner)).toHaveLength(0);
    at(BASE + 61 * MIN);
    await s.t.action(internal.escalations.run, {});
    expect(await s.notes(s.ids.managerAc)).toHaveLength(1);
    expect(await s.notes(s.ids.owner)).toEqual(["Заказ №1001: подходящих мастеров на смене нет — назначьте исполнителя вручную"]);
    at(BASE + 3 * HOUR);
    await s.t.action(internal.escalations.run, {});
    expect(await s.notes(s.ids.owner)).toHaveLength(1);
  });

  test("заказ, который автораспределение сейчас предлагает мастеру, эскалации не трогают", async () => {
    const s = await setup();
    await s.as(s.ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 30 });
    const o = await s.mkOrder();
    at(BASE + 31 * MIN);
    await s.t.action(internal.escalations.run, {});
    expect((await s.order(o)).status).toBe("assigned");
    expect(await s.notes(s.ids.managerAc)).toEqual([]);
    expect(await s.journal("order.escalated")).toHaveLength(0);
  });
});

describe("назначен, но мастер не подтвердил", () => {
  test("без автораспределения: руководителю, заказ — снова в ленте, подходящие мастера узнают (E8); один раз", async () => {
    const s = await setup();
    const o = await s.mkOrder({ status: "assigned", executorId: s.ids.asel.id, assignedAt: iso(BASE) });
    at(BASE + 25 * MIN);
    expect(await s.pass()).toMatchObject({ unconfirmed: 0, returned: 0 });
    at(BASE + 31 * MIN);
    expect(await s.pass()).toMatchObject({ unconfirmed: 1, returned: 1 });
    const back = await s.order(o);
    expect(back.status).toBe("awaiting_executor");
    expect(back.executorId).toBeUndefined();
    expect(await s.notes(s.ids.managerAc)).toEqual(["Заказ №1001: Асель М. не подтвердил назначение за 31 мин — заказ вернулся в ленту"]);
    expect(await s.notes(s.ids.asel.user)).toEqual(["Заказ №1001 снят с вас: вы не подтвердили его за 31 мин"]);
    expect((await s.notes(s.ids.bauyr.user))[0]).toContain("Снова свободен заказ №1001");
    // Новый эпизод в ленте только начался — эскалации «в ленте» ещё нет.
    at(BASE + 40 * MIN);
    expect(await s.pass()).toMatchObject({ feed: 0, unconfirmed: 0 });
    const row = (await s.journal("order.escalated"))[0]!;
    expect(row).toMatchObject({ actorName: "Система", entityId: o });
    expect(row.meta).toMatchObject({ kind: "unconfirmed", returned: true });
  });

  test("с автораспределением: своё назначение оно вернёт само; ручное — только сообщение руководителю", async () => {
    const s = await setup();
    await s.as(s.ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 30 });
    const auto = await s.mkOrder({ status: "assigned", executorId: s.ids.asel.id, assignedAt: iso(BASE), autoAssignedAt: iso(BASE), autoOffered: [s.ids.asel.id] });
    const manual = await s.mkOrder({ status: "assigned", executorId: s.ids.bauyr.id, assignedAt: iso(BASE) });
    at(BASE + 31 * MIN);
    expect(await s.pass()).toMatchObject({ unconfirmed: 1, returned: 0 });
    expect((await s.order(auto)).status).toBe("assigned");
    expect((await s.order(manual)).status).toBe("assigned");
    expect(await s.notes(s.ids.managerAc)).toEqual(["Заказ №1002: Бауыржан М. не подтвердил назначение за 31 мин — свяжитесь с ним или назначьте другого"]);
    at(BASE + 2 * HOUR);
    expect((await s.pass()).unconfirmed).toBe(0);
  });
});

describe("просрочка — второй уровень владельцу", () => {
  test("просрочен больше суток — владельцу один раз; меньше суток и давние — нет", async () => {
    const s = await setup();
    await s.mkOrder({ status: "in_progress", executorId: s.ids.asel.id, assignedAt: iso(BASE - 3 * DAY), deadline: iso(BASE - 25 * HOUR) });
    await s.mkOrder({ status: "accepted", executorId: s.ids.bauyr.id, assignedAt: iso(BASE - 3 * DAY), deadline: iso(BASE - 23 * HOUR) });
    await s.mkOrder({ status: "in_progress", executorId: s.ids.bauyr.id, assignedAt: iso(BASE - 20 * DAY), deadline: iso(BASE - 10 * DAY) });
    await s.mkOrder({ status: "done", executorId: s.ids.bauyr.id, assignedAt: iso(BASE - 3 * DAY), deadline: iso(BASE - 30 * HOUR), doneAt: iso(BASE - DAY) });
    expect((await s.pass()).overdue).toBe(1);
    const owner = await s.notes(s.ids.owner);
    expect(owner).toHaveLength(1);
    expect(owner[0]).toMatch(/^Заказ №1001 \(Ремонт кондиционера\) просрочен на 1 дн\.: срок был 13\.10\.2026 10:00$/);
    expect(await s.notes(s.ids.managerAc)).toEqual([]);
    expect((await s.pass()).overdue).toBe(0);
    // Через сутки и второй заказ просрочен больше суток — тоже один раз.
    at(BASE + 2 * HOUR);
    expect((await s.pass()).overdue).toBe(1);
    expect(await s.notes(s.ids.owner)).toHaveLength(2);
  });
});

describe("заявка без первого действия оператора", () => {
  const lead = (s: Awaited<ReturnType<typeof setup>>, over: Partial<Doc<"leads">>) =>
    s.t.run((ctx) =>
      ctx.db.insert("leads", {
        tenantId: T,
        number: 2000 + Math.floor(Math.random() * 1000),
        clientId: s.ids.client,
        clientName: "Клиент Тест",
        clientPhone: "77071234567",
        source: "site",
        serviceId: "ac-repair",
        city: "Алматы",
        description: "Не холодит",
        urgency: "normal",
        status: "new",
        origin: "site",
        createdAt: iso(now),
        ...over,
      }),
    );

  test("15 рабочих минут — операторам, один раз; взятые, начатые и старые заявки — нет", async () => {
    const s = await setup();
    const waiting = await lead(s, { number: 2001, createdAt: iso(BASE - 16 * MIN) });
    await lead(s, { number: 2002, origin: "bot", createdAt: iso(BASE - 10 * MIN) });
    await lead(s, { number: 2003, createdAt: iso(BASE - HOUR), firstActionAt: iso(BASE - 50 * MIN), operatorId: s.ids.operator });
    // Заведена до учёта первого действия (нет origin) — не эскалируем.
    await lead(s, { number: 2004, origin: undefined, operatorId: s.ids.operator, createdAt: iso(BASE - HOUR) });
    await lead(s, { number: 2005, status: "qualifying", createdAt: iso(BASE - HOUR) });
    expect((await s.pass()).leads).toBe(1);
    expect(await s.notes(s.ids.operator)).toEqual(["Заявка №2001 (Сайт, Ремонт кондиционера): 16 мин без ответа — возьмите в работу"]);
    expect(await s.notes(s.ids.owner)).toEqual([]);
    expect((await s.pass()).leads).toBe(0);
    at(BASE + 6 * MIN);
    expect((await s.pass()).leads).toBe(1);
    expect(await s.notes(s.ids.operator)).toHaveLength(2);
    const row = (await s.journal("lead.escalated")).find((r) => r.entityId === waiting)!;
    expect(row).toMatchObject({ actorName: "Система" });
    expect(row.meta).toMatchObject({ kind: "lead", origin: "site" });
  });

  test("ночью время не идёт: заявка в 20:55 ждёт с 9:00 утра", async () => {
    const s = await setup();
    // 13.10 20:55 по Алматы = 15:55 UTC.
    await lead(s, { number: 2010, origin: "bot", createdAt: iso(Date.UTC(2026, 9, 13, 15, 55)) });
    at(Date.UTC(2026, 9, 13, 20, 0)); // 01:00 ночи
    expect((await s.pass()).leads).toBe(0);
    at(Date.UTC(2026, 9, 14, 4, 5)); // 09:05: 5 мин вечером + 5 утром
    expect((await s.pass()).leads).toBe(0);
    at(Date.UTC(2026, 9, 14, 4, 11)); // 09:11: 16 рабочих минут
    expect((await s.pass()).leads).toBe(1);
    expect((await s.notes(s.ids.operator))[0]).toContain("16 мин без ответа");
  });

  test("ответ клиенту в «Сообщениях» — первое действие: заявка из этого диалога не эскалируется", async () => {
    // Все таймеры — фиктивные: отправка ответа в Telegram (фоном) в тесте не уходит.
    vi.useFakeTimers();
    at(BASE);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    const s = await setup();
    const l = await lead(s, { number: 2030, origin: "bot", source: "telegram", createdAt: iso(BASE - 10 * MIN) });
    const conv = await s.t.run((ctx) =>
      ctx.db.insert("conversations", { tenantId: T, channel: "telegram", externalId: "777", contactName: "Клиент", clientId: s.ids.client, leadId: l, lastMessageAt: iso(BASE - 10 * MIN), lastText: "Течёт кран", lastDirection: "in", unread: 1, status: "open" }),
    );
    await s.as(s.ids.operator).mutation(api.inbox.reply, { conversationId: conv, text: "Здравствуйте! Подскажите адрес, пожалуйста" });
    expect((await s.t.run((ctx) => ctx.db.get(l)))!.firstActionAt).toBe(iso(BASE));
    at(BASE + 30 * MIN);
    expect((await s.pass()).leads).toBe(0);
  });

  test("операторов нет — узнаёт владелец", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.ids.operator, { active: false }));
    await lead(s, { number: 2020, createdAt: iso(BASE - 20 * MIN) });
    await s.pass();
    expect(await s.notes(s.ids.owner)).toHaveLength(1);
    expect(await s.notes(s.ids.operator)).toEqual([]);
  });
});

describe("пропущенный звонок без перезвона", () => {
  const call = (s: Awaited<ReturnType<typeof setup>>, c: Partial<Doc<"calls">>) =>
    s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550001", to: "77273450000", status: "missed", startedAt: iso(now), aiStatus: "none", ...c }));

  test("30 рабочих минут — операторам, один раз; перезвонили — тишина; по номеру — только последний пропущенный", async () => {
    const s = await setup();
    const missed = await call(s, { from: "77015550001", clientName: "Айгуль", startedAt: iso(BASE - 31 * MIN) });
    await call(s, { from: "77015550002", startedAt: iso(BASE - 40 * MIN) });
    await call(s, { direction: "out", from: "77273450000", to: "77015550002", status: "completed", startedAt: iso(BASE - 20 * MIN), operatorId: s.ids.operator });
    await call(s, { from: "77015550003", startedAt: iso(BASE - 50 * MIN) });
    await call(s, { from: "77015550003", startedAt: iso(BASE - 35 * MIN) });
    // Клиент сам перезвонил, и его приняли.
    await call(s, { from: "77015550004", startedAt: iso(BASE - 45 * MIN) });
    await call(s, { from: "77015550004", status: "completed", startedAt: iso(BASE - 30 * MIN), duration: 60 });
    expect((await s.pass()).callbacks).toBe(2);
    const texts = await s.notes(s.ids.operator);
    expect(texts).toContain("Пропущенный звонок: Айгуль — 31 мин без перезвона. Перезвоните");
    expect(texts.filter((x) => x.includes("+7 701 555 00 03"))).toEqual(["Пропущенный звонок: +7 701 555 00 03 — 35 мин без перезвона. Перезвоните"]);
    expect((await s.pass()).callbacks).toBe(0);
    const row = (await s.journal("call.escalated")).find((r) => r.entityId === missed)!;
    // В журнале — номер только последними цифрами.
    expect(row.summary).toContain("…0001");
    expect(row.summary).not.toContain("77015550001");
  });
});

describe("настройки сроков реакции", () => {
  test("видит и меняет только владелец; проверки; правка — в журнале; новые пороги действуют сразу", async () => {
    const s = await setup();
    expect(await s.as(s.ids.owner).query(api.escalations.settings, {})).toEqual(SLA_DEFAULTS);
    await expect(s.as(s.ids.operator).query(api.escalations.settings, {})).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.managerAc).mutation(api.escalations.configure, SLA_DEFAULTS)).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.owner).mutation(api.escalations.configure, { ...SLA_DEFAULTS, feedOwnerMin: 20 })).rejects.toThrow("позже, чем руководителю");
    await expect(s.as(s.ids.owner).mutation(api.escalations.configure, { ...SLA_DEFAULTS, leadMin: 2 })).rejects.toThrow("от 5 до 480");
    await expect(s.as(s.ids.owner).mutation(api.escalations.configure, { ...SLA_DEFAULTS, dayStart: 21, dayEnd: 9 })).rejects.toThrow("Конец рабочего дня");
    expect(await s.as(s.ids.owner).mutation(api.escalations.configure, SLA_DEFAULTS)).toEqual(SLA_DEFAULTS);
    expect(await s.journal("settings.escalations")).toHaveLength(0);

    await s.as(s.ids.owner).mutation(api.escalations.configure, { ...SLA_DEFAULTS, feedMin: 10 });
    const row = (await s.journal("settings.escalations"))[0]!;
    expect(row.summary).toContain("заказ в ленте без исполнителя — руководителю: 30 мин → 10 мин");
    await s.mkOrder();
    at(BASE + 11 * MIN);
    expect((await s.pass()).feed).toBe(1);
  });

  test("сохранённое значение испорчено — пороги по умолчанию; правила проверки", () => {
    expect(parseSla(undefined)).toEqual(SLA_DEFAULTS);
    expect(parseSla("не json")).toEqual(SLA_DEFAULTS);
    expect(parseSla(JSON.stringify({ ...SLA_DEFAULTS, feedMin: 45, leadMin: -1 }))).toEqual({ ...SLA_DEFAULTS, feedMin: 45 });
    expect(slaProblem({ ...SLA_DEFAULTS, feedMin: 12.5 })).toContain("целое число");
    expect(slaProblem(SLA_DEFAULTS)).toBeNull();
  });

  test("рабочее время по Алматы: вечер, ночь и утро", () => {
    const day = Date.UTC(2026, 9, 13, 0, 0) - 5 * HOUR; // полночь 13.10 по Алматы
    expect(workingMs(day + 20 * HOUR + 55 * MIN, day + DAY + 9 * HOUR + 5 * MIN, 9, 21)).toBe(10 * MIN);
    expect(workingMs(day + 10 * HOUR, day + 11 * HOUR, 9, 21)).toBe(HOUR);
    expect(workingMs(day + 22 * HOUR, day + DAY + 8 * HOUR, 9, 21)).toBe(0);
    expect(workingMs(day + 12 * HOUR, day + 2 * DAY + 12 * HOUR, 9, 21)).toBe(24 * HOUR);
    expect(workingMs(day + 12 * HOUR, day + 11 * HOUR, 9, 21)).toBe(0);
  });
});

describe("крон «регламенты»", () => {
  test("один запуск: автораспределение, возвращение на смену и эскалации; отметка в «Состоянии системы»", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.patch(s.ids.asel.id, { available: false, unavailableUntil: iso(BASE - MIN), unavailableReason: "Отпуск" }));
    await s.mkOrder({ serviceId: "cleaning", category: "cleaning" }, BASE - 40 * MIN);
    expect(await s.t.action(internal.escalations.run, {})).toEqual({ failed: [] });
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.asel.id)))!).toMatchObject({ available: true });
    expect(await s.notes(s.ids.owner)).toHaveLength(1);
    const mark = await s.t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "escalations")).unique());
    expect(mark?.okNote).toBe("Эскалаций за проход: 1");
  });
});
