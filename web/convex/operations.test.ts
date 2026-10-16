/// <reference types="vite/client" />
// Регламенты и качество данных (gaps #11, #18, E9–E12, E24, E25, E27): недоступность и лимит заказов мастера,
// один город — одно написание, заявки каналов без «фальшивого» оператора, структурные данные заявки и срок заказа
// по срочности, серверные запреты.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { sanitize, toSummary } from "./ai";
import { cityKey, normalizeCity } from "../src/data/cities";
import { deadlineByUrgency } from "../src/data/leadRules";
import { DEFAULT_MAX_ACTIVE, fitsOrder } from "../src/data/logic";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (t: number) => new Date(t).toISOString();
const at = iso(Date.now() - 30 * DAY);

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const managerPl = await ctx.db.insert("users", { name: "Руководитель сантехники", email: "pl@test.kz", role: "manager", categories: ["plumbing"], tenantId: T, active: true });
    const mkExecutor = async (name: string, phone: string, e: Partial<Doc<"executors">> = {}) => {
      const id = await ctx.db.insert("executors", { tenantId: T, name, phone, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at, ...e });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: id, tenantId: T, active: true });
      return { id, user };
    };
    const asel = await mkExecutor("Асель Мастер", "77000000001");
    const bauyr = await mkExecutor("Бауыржан Мастер", "77000000002");
    const appl = await mkExecutor("Ерлан Техник", "77000000003", { categories: ["appliances"] });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    const other = await ctx.db.insert("clients", { tenantId: T, name: "Другой Клиент", kind: "person", phone: "77019998877", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    return { owner, operator, managerPl, asel, bauyr, appl, client, other };
  });
  let number = 1000;
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
        deadline: iso(Date.now() + 2 * DAY),
        priority: "normal",
        status: "awaiting_executor",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        createdAt: iso(Date.now() - HOUR),
        createdBy: ids.operator,
        files: [],
        ...over,
      }),
    );
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const notes = (user: Id<"users">) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("notifications")
          .withIndex("by_user", (q) => q.eq("userId", user))
          .collect()
      ).map((n) => n.text),
    );
  const get = <T extends "executors" | "orders" | "leads" | "calls">(id: Id<T>) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const journal = (action: string) => t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((a) => a.action === action));
  return { t, ids, mkOrder, as, notes, get, journal };
}

// ── Недоступность мастера ────────────────────────────────────────────────────

describe("недоступность мастера «до …» (ТЗ п.14)", () => {
  test("мастер сам: «не принимаю до» — ни ленты для взятия, ни рассылки; в срок — снова на смене, с уведомлением", async () => {
    const s = await setup();
    const until = iso(Date.now() + 2 * HOUR);
    await s.as(s.ids.asel.user).mutation(api.worker.setAvailable, { available: false, until });
    expect(await s.get(s.ids.asel.id)).toMatchObject({ available: false, unavailableUntil: until });
    // Возвращение запланировано на этот момент.
    const jobs = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(jobs.some((j) => j.name.includes("_backOnShift") && JSON.stringify(j.args).includes(until))).toBe(true);
    expect((await s.journal("executor.availability"))[0]!.summary).toContain("недоступен до");

    const feed = await s.mkOrder();
    await expect(s.as(s.ids.asel.user).mutation(api.worker.take, { id: feed })).rejects.toThrow("включите приём");
    const published = await s.mkOrder({ status: "new" });
    expect(await s.as(s.ids.operator).mutation(api.orders.changeStatus, { id: published, to: "awaiting_executor" })).toEqual({ notified: 1 });
    expect(await s.notes(s.ids.asel.user)).toEqual([]);
    // Подбор при назначении объясняет почему.
    const fit = fitsOrder(await s.get(s.ids.asel.id), { category: "ac", city: "Алматы" });
    expect(fit.reasons[0]).toMatch(/^недоступен до /);

    // Время пришло — запланированная задача возвращает на смену.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(until) + 1000));
    expect(await s.t.mutation(internal.executors._backOnShift, { id: s.ids.asel.id, until })).toBe(true);
    expect(await s.get(s.ids.asel.id)).toMatchObject({ available: true });
    expect((await s.get(s.ids.asel.id)).unavailableUntil ?? (await s.get(s.ids.asel.id)).unavailableReason).toBeUndefined();
    expect(await s.notes(s.ids.asel.user)).toEqual(["Вы снова принимаете заказы: недоступность закончилась. Новые заказы приходят сюда и в Telegram"]);
    const back = (await s.journal("executor.availability")).at(-1)!;
    expect(back).toMatchObject({ actorName: "Система" });
    // Повтор задачи (или дату сменили) — ничего не делает.
    expect(await s.t.mutation(internal.executors._backOnShift, { id: s.ids.asel.id, until })).toBe(false);
  });

  test("сотрудник ставит «недоступен до» с причиной; даты проверяются; руководитель — только в своём направлении; включили раньше — дата снимается", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const until = iso(Date.now() + 3 * DAY);
    await op.mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: false, until, reason: "Отпуск" });
    expect(await s.get(s.ids.bauyr.id)).toMatchObject({ available: false, unavailableUntil: until, unavailableReason: "Отпуск" });
    const row = (await s.journal("executor.availability"))[0]!;
    expect(row.summary).toMatch(/^Бауыржан М\. — недоступен до \d\d\.\d\d\.\d{4} \d\d:\d\d \(Отпуск\), новые заказы не приходят$/);
    expect(row.meta).toMatchObject({ available: false, until, reason: "Отпуск" });
    // Те же значения ещё раз — без записи в журнале.
    await op.mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: false, until, reason: "Отпуск" });
    expect(await s.journal("executor.availability")).toHaveLength(1);

    await expect(op.mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: false, until: iso(Date.now() - MIN) })).rejects.toThrow("в будущем");
    await expect(op.mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: false, until: iso(Date.now() + 91 * DAY) })).rejects.toThrow("не дольше 90 дней");
    await expect(op.mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: false, until: "завтра" })).rejects.toThrow("в будущем");
    await expect(s.as(s.ids.managerPl).mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: true })).rejects.toThrow("не ваше направление");

    await op.mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: true });
    const on = await s.get(s.ids.bauyr.id);
    expect(on.available).toBe(true);
    expect(on.unavailableUntil ?? on.unavailableReason).toBeUndefined();
    // DTO отдаёт дату и причину экранам.
    await op.mutation(api.executors.setAvailable, { id: s.ids.bauyr.id, available: false, until, reason: "Болеет" });
    const list = await op.query(api.executors.list, {});
    expect(list.executors.find((e) => e.id === s.ids.bauyr.id)).toMatchObject({ available: false, unavailableUntil: until, unavailableReason: "Болеет" });
  });

  test("проверка крона: срок прошёл — снова на смене; отключённого (уволен) не возвращаем, дату снимаем", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.ids.asel.id, { available: false, unavailableUntil: iso(Date.now() - MIN) });
      await ctx.db.patch(s.ids.bauyr.id, { available: false, unavailableUntil: iso(Date.now() - MIN) });
      await ctx.db.patch(s.ids.bauyr.user, { active: false });
      await ctx.db.patch(s.ids.appl.id, { available: false, unavailableUntil: iso(Date.now() + DAY) });
    });
    expect(await s.t.mutation(internal.executors._restoreShifts, {})).toBe(1);
    expect(await s.get(s.ids.asel.id)).toMatchObject({ available: true });
    const fired = await s.get(s.ids.bauyr.id);
    expect(fired.available).toBe(false);
    expect(fired.unavailableUntil).toBeUndefined();
    expect(await s.get(s.ids.appl.id)).toMatchObject({ available: false });
  });

  test("отключение доступа снимает и «недоступен до»: в назначенный день уволенный на смену не вернётся", async () => {
    const s = await setup();
    await s.as(s.ids.operator).mutation(api.executors.setAvailable, { id: s.ids.asel.id, available: false, until: iso(Date.now() + DAY) });
    await s.as(s.ids.owner).mutation(api.users.setActive, { userId: s.ids.asel.user, active: false });
    const off = await s.get(s.ids.asel.id);
    expect(off.available).toBe(false);
    expect(off.unavailableUntil).toBeUndefined();
  });
});

// ── Лимит заказов в работе ───────────────────────────────────────────────────

describe("лимит заказов в работе (ТЗ п.14, E9)", () => {
  async function busy() {
    const s = await setup();
    for (const status of ["assigned", "accepted", "in_progress"] as const) await s.mkOrder({ status, executorId: s.ids.asel.id, assignedAt: iso(Date.now() - DAY) });
    return s;
  }

  test("на лимите: лента видна с отметкой, «Взять заказ» — отказ, «Новый заказ» не приходит, автоподбор пропускает", async () => {
    const s = await busy();
    const open = await s.mkOrder();
    const feed = await s.as(s.ids.asel.user).query(api.worker.feed, {});
    expect(feed.load).toEqual({ active: 3, max: DEFAULT_MAX_ACTIVE });
    expect(feed.feed.map((o) => o.id)).toContain(open);
    await expect(s.as(s.ids.asel.user).mutation(api.worker.take, { id: open })).rejects.toThrow("У вас уже 3 заказа в работе — это ваш лимит");

    const published = await s.mkOrder({ status: "new" });
    expect(await s.as(s.ids.operator).mutation(api.orders.changeStatus, { id: published, to: "awaiting_executor" })).toEqual({ notified: 1 });
    expect(await s.notes(s.ids.asel.user)).toEqual([]);
    expect((await s.notes(s.ids.bauyr.user))[0]).toContain(`Новый заказ №`);

    // Автораспределение: свободный Бауыржан, а не Асель на лимите (у неё рейтинг выше).
    await s.t.run((ctx) => ctx.db.patch(s.ids.bauyr.id, { rating: 4 }));
    await s.as(s.ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 5 });
    await s.t.run((ctx) => ctx.db.insert("history", { orderId: open, kind: "status", text: "Опубликован в ленту", actor: { type: "system" }, at: iso(Date.now() - HOUR) }));
    await s.t.mutation(internal.autoAssign.run, {});
    expect((await s.get(open)).executorId).toBe(s.ids.bauyr.id);

    // Ручное назначение подсказывает причину.
    const detail = (await s.as(s.ids.owner).query(api.orders.detail, { id: published }))!;
    const asel = detail.executors.find((e) => e.id === s.ids.asel.id)!;
    expect(fitsOrder(asel, detail.order, 3).reasons).toContain("лимит заказов: в работе 3 из 3");
  });

  test("владелец поднимает лимит — заказ можно взять; лимит меняет только владелец, в границах, с записью в журнале", async () => {
    const s = await busy();
    const open = await s.mkOrder();
    await expect(s.as(s.ids.operator).mutation(api.executors.setMaxActive, { id: s.ids.asel.id, max: 4 })).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.owner).mutation(api.executors.setMaxActive, { id: s.ids.asel.id, max: 0 })).rejects.toThrow("от 1 до 20");
    await expect(s.as(s.ids.owner).mutation(api.executors.setMaxActive, { id: s.ids.asel.id, max: 2.5 })).rejects.toThrow("от 1 до 20");
    await s.as(s.ids.owner).mutation(api.executors.setMaxActive, { id: s.ids.asel.id, max: 4 });
    expect((await s.get(s.ids.asel.id)).maxActiveOrders).toBe(4);
    expect((await s.journal("executor.limit"))[0]!.summary).toBe("Асель М.: заказов в работе одновременно — 3 → 4");
    expect(await s.as(s.ids.asel.user).mutation(api.worker.take, { id: open })).toMatchObject({ number: expect.any(Number) });
    // null — снова по умолчанию.
    await s.as(s.ids.owner).mutation(api.executors.setMaxActive, { id: s.ids.asel.id, max: null });
    expect((await s.get(s.ids.asel.id)).maxActiveOrders).toBeUndefined();
  });
});

// ── Города ───────────────────────────────────────────────────────────────────

describe("один город — одно написание (E11)", () => {
  test("normalizeCity: справочник в любом написании, другие города — аккуратно, пусто — пусто", () => {
    for (const raw of ["Алматы", "алматы", " г. Алматы ", "г.Алматы", "Г Алматы", "город Алматы", "ALMATY", "Almaty", "almaty city", "Алма-Ата", "Алматы қ.", "Алматы қаласы"]) expect(normalizeCity(raw)).toBe("Алматы");
    expect(normalizeCity("Нур-Султан")).toBe("Астана");
    expect(normalizeCity("г. астана")).toBe("Астана");
    expect(normalizeCity("Чимкент")).toBe("Шымкент");
    expect(normalizeCity("Қарағанды")).toBe("Караганда");
    expect(normalizeCity("талдыкорган")).toBe("Талдыкорган");
    expect(normalizeCity("УСТЬ-КАМЕНОГОРСК")).toBe("Усть-Каменогорск");
    expect(normalizeCity("г. Каскелен")).toBe("Каскелен");
    expect(normalizeCity("  ")).toBe("");
    expect(normalizeCity(undefined)).toBe("");
    expect(cityKey("г. Алматы")).toBe(cityKey("almaty"));
  });

  test("подбор: старый заказ с «г. Алматы» виден мастеру из «Алматы»", () => {
    const e = { available: true, city: "Алматы", categories: ["ac"], skills: [] };
    expect(fitsOrder(e, { category: "ac", city: "г. Алматы" }).fits).toBe(true);
    expect(fitsOrder({ ...e, city: "Almaty" }, { category: "ac", city: "Алматы" }).fits).toBe(true);
    expect(fitsOrder(e, { category: "ac", city: "Астана" }).reasons).toEqual(["другой город"]);
  });

  test("сервер нормализует город в заявке, заказе, клиенте, мастере, импорте, AI-разборе и заявке с сайта; пустой — отказ", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const lead = await op.mutation(api.leads.create, { clientName: "Новый Клиент", phone: "77015550101", source: "phone", serviceId: "ac-repair", city: " г. алматы ", description: "Не холодит", urgency: "normal" });
    const l = await s.get(lead.id);
    expect(l.city).toBe("Алматы");
    expect((await s.t.run((ctx) => ctx.db.get(l.clientId)))!.city).toBe("Алматы");
    await expect(op.mutation(api.leads.create, { clientName: "Ещё", phone: "77015550102", source: "phone", serviceId: "ac-repair", city: "  ", description: "x", urgency: "normal" })).rejects.toThrow("Укажите город");
    await op.mutation(api.leads.update, { id: lead.id, city: "Нур-Султан" });
    expect((await s.get(lead.id)).city).toBe("Астана");

    const o = await s.mkOrder({ status: "new" });
    const cur = await s.get(o);
    await op.mutation(api.orders.updateInfo, { id: o, serviceId: cur.serviceId, description: cur.description, city: "Г.Шымкент", address: cur.address, deadline: cur.deadline, priority: cur.priority });
    expect((await s.get(o)).city).toBe("Шымкент");
    await expect(op.mutation(api.orders.updateInfo, { id: o, serviceId: cur.serviceId, description: cur.description, city: " ", address: cur.address, deadline: cur.deadline, priority: cur.priority })).rejects.toThrow("Укажите город");

    const ex = await s.get(s.ids.asel.id);
    await op.mutation(api.executors.update, { id: ex._id, name: ex.name, phone: ex.phone, city: "г. астана", categories: ex.categories, skills: ex.skills, cooperation: ex.cooperation });
    expect((await s.get(ex._id)).city).toBe("Астана");

    const c = await op.mutation(api.clients.create, { name: "Клиент Города", phone: "77015550103", city: "караганды", source: "olx" });
    expect((await s.t.run((ctx) => ctx.db.get(c.id)))!.city).toBe("Караганда");

    await op.mutation(api.imports.clients, { rows: [{ name: "Импорт Один", phone: "77015550104", city: "алма-ата" }, { name: "Импорт Два", phone: "77015550105" }] });
    const imported = (await s.t.run((ctx) => ctx.db.query("clients").collect())).filter((x) => x.name.startsWith("Импорт")).map((x) => x.city);
    expect(imported).toEqual(["Алматы", "Алматы"]);

    expect(sanitize({ summary: "x", city: "г. Шымкент", serviceId: "ac-repair" }, { services: [{ id: "ac-repair", label: "Ремонт" }], cities: [] }).city).toBe("Шымкент");

    const site = await s.t.mutation(internal.site._submit, { name: "С Сайта", phone: "77015550106", serviceId: "ac-repair", city: "Almaty", description: "Шумит" });
    if (!site.ok) throw new Error("заявка с сайта не принята");
    const fromSite = (await s.t.run((ctx) => ctx.db.query("leads").withIndex("by_number", (q) => q.eq("number", site.number)).unique()))!;
    expect(fromSite.city).toBe("Алматы");
  });
});

// ── Заявки каналов без «фальшивого» оператора ────────────────────────────────

describe("кто завёл и кто ведёт заявку (E12)", () => {
  const AI = { summary: "Не холодит кондиционер", extracted: [], questions: [] };

  test("бот, сайт и AI без оператора: заявка ничья, пока её не взяли; не записывается на владельца", async () => {
    const s = await setup();
    const bot = await s.t.mutation(internal.bot._createLead, { chatId: "555", phone: "+7 701 555 01 11", name: "Айгуль", description: "Течёт кран" });
    if (!bot.ok) throw new Error("заявка бота не создана");
    const fromBot = (await s.t.run((ctx) => ctx.db.query("leads").withIndex("by_number", (q) => q.eq("number", bot.number)).unique()))!;
    expect(fromBot).toMatchObject({ origin: "bot", status: "new" });
    expect(fromBot.operatorId).toBeUndefined();
    expect(fromBot.firstActionAt).toBeUndefined();
    // Наружу — пустая строка: экраны показывают «ждёт оператора».
    expect((await s.as(s.ids.operator).query(api.leads.get, { id: fromBot._id }))!.lead).toMatchObject({ operatorId: "", origin: "bot" });

    // AI по звонку, который никто не принимал, — тоже ничья.
    const call = await s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550120", to: "77273450000", status: "completed", startedAt: iso(Date.now()), aiStatus: "pending" }));
    await s.t.mutation(internal.calls._saveAi, { id: call, status: "done", ai: AI, draft: { serviceId: "ac-repair", city: "алматы", address: "мкр. Самал-2, 58", when: "завтра после 18:00", budget: 15000 }, autoLead: true });
    const fromCall = (await s.get(call)).leadId!;
    expect(await s.get(fromCall)).toMatchObject({ origin: "ai", city: "Алматы", address: "мкр. Самал-2, 58", preferredTime: "завтра после 18:00", budget: 15000 });
    expect((await s.get(fromCall)).operatorId).toBeUndefined();
    expect((await s.get(fromCall)).comment).toBeUndefined();

    // Звонок принял оператор — заявка его, и первое действие уже было (разговор).
    const answered = await s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550121", to: "77273450000", operatorId: s.ids.operator, status: "completed", startedAt: iso(Date.now()), aiStatus: "pending" }));
    await s.t.mutation(internal.calls._saveAi, { id: answered, status: "done", ai: AI, draft: { serviceId: "ac-repair" }, autoLead: true });
    const own = await s.get((await s.get(answered)).leadId!);
    expect(own).toMatchObject({ origin: "ai", operatorId: s.ids.operator });
    expect(own.firstActionAt).toBeDefined();

    // Аналитика: ничьи заявки — в строке «пришли сами», не у владельца.
    const slice = await s.as(s.ids.owner).query(api.metrics.analytics, { from: iso(Date.now() - DAY) });
    expect(slice.autoLeads).toEqual(expect.arrayContaining([fromBot._id, fromCall]));
    expect(slice.autoLeads).not.toContain(own._id);
  });

  test("«Взять в работу»: заявка ваша, этап «Квалификация», первое действие отмечено; чужую не перехватить", async () => {
    const s = await setup();
    const site = await s.t.mutation(internal.site._submit, { name: "С Сайта", phone: "77015550130", serviceId: "ac-repair", description: "Шумит" });
    if (!site.ok) throw new Error("заявка с сайта не принята");
    const id = (await s.t.run((ctx) => ctx.db.query("leads").withIndex("by_number", (q) => q.eq("number", site.number)).unique()))!._id;
    expect((await s.get(id)).origin).toBe("site");

    await s.as(s.ids.operator).mutation(api.leads.take, { id });
    const taken = await s.get(id);
    expect(taken).toMatchObject({ operatorId: s.ids.operator, status: "qualifying" });
    expect(taken.firstActionAt).toBeDefined();
    const row = (await s.journal("lead.taken"))[0]!;
    expect(row).toMatchObject({ actorId: s.ids.operator, entityId: id });
    expect(row.summary).toContain("взята в работу");
    // Повторное нажатие — ничего; другой сотрудник — отказ.
    await s.as(s.ids.operator).mutation(api.leads.take, { id });
    expect(await s.journal("lead.taken")).toHaveLength(1);
    await expect(s.as(s.ids.owner).mutation(api.leads.take, { id })).rejects.toThrow("Заявку уже ведёт Мадина О.");

    // Заявку из канала, которую никто не взял, получает тот, кто её квалифицирует или закрывает; правка полей — нет.
    const bot = await s.t.mutation(internal.bot._createLead, { chatId: "556", phone: "77015550131", description: "Розетка искрит" });
    if (!bot.ok) throw new Error("заявка бота не создана");
    const botId = (await s.t.run((ctx) => ctx.db.query("leads").withIndex("by_number", (q) => q.eq("number", bot.number)).unique()))!._id;
    await s.as(s.ids.owner).mutation(api.leads.update, { id: botId, description: "Розетка искрит на кухне" });
    expect((await s.get(botId)).operatorId).toBeUndefined();
    expect((await s.get(botId)).firstActionAt).toBeDefined();
    await s.as(s.ids.owner).mutation(api.leads.setStatus, { id: botId, status: "waiting" });
    expect((await s.get(botId)).operatorId).toBe(s.ids.owner);

    // Заявку оператора ведёт он сам, первое действие — само заведение.
    const manual = await s.as(s.ids.operator).mutation(api.leads.create, { clientName: "Клиент Тест", phone: "77071234567", source: "olx", serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "normal" });
    expect(await s.get(manual.id)).toMatchObject({ origin: "operator", operatorId: s.ids.operator });
    expect((await s.get(manual.id)).firstActionAt).toBe((await s.get(manual.id)).createdAt);
  });
});

// ── Структурные данные заявки и срок заказа ──────────────────────────────────

describe("данные обращения в заявке и срок заказа по срочности (ТЗ п.8.3, E27)", () => {
  test("срок по срочности, по Алматы: срочно — через 4 ч, высокая — завтра к 12:00, обычная — послезавтра к 12:00", () => {
    // 14.10.2026 22:30 по Алматы — уже «завтра» по UTC-дате не путает.
    const now = Date.UTC(2026, 9, 14, 17, 30);
    expect(deadlineByUrgency("urgent", now)).toBe(iso(now + 4 * HOUR));
    expect(deadlineByUrgency("high", now)).toBe("2026-10-15T07:00:00.000Z");
    expect(deadlineByUrgency("normal", now)).toBe("2026-10-16T07:00:00.000Z");
    // 00:30 по Алматы 15.10 (19:30 UTC 14.10): «завтра» — 16.10.
    expect(deadlineByUrgency("high", Date.UTC(2026, 9, 14, 19, 30))).toBe("2026-10-16T07:00:00.000Z");
  });

  test("AI-черновик: адрес, удобное время и бюджет — в черновике сотрудника, описание — только суть", () => {
    const { draft } = toSummary({ summary: "Не холодит", serviceId: "ac-repair", city: "Алматы", address: "Абая 10", when: "завтра после 18:00", budget: 15000, urgency: "high", clientName: null, questions: [] }, () => "Ремонт");
    expect(draft).toMatchObject({ description: "Не холодит", address: "Абая 10", when: "завтра после 18:00", budget: 15000 });
  });

  test("заявка → заказ: адрес из заявки, срок по срочности, удобное время — подсказкой в истории; бюджет в цену не попадает", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 14, 6, 0)));
    const s = await setup();
    const op = s.as(s.ids.operator);
    const lead = await op.mutation(api.leads.create, {
      clientName: "Аружан",
      phone: "77015550140",
      source: "whatsapp",
      serviceId: "ac-repair",
      city: "Алматы",
      description: "Не холодит",
      urgency: "high",
      address: "мкр. Самал-2, д. 58",
      preferredTime: "завтра после 18:00",
      budget: 15000,
    });
    expect(await s.get(lead.id)).toMatchObject({ address: "мкр. Самал-2, д. 58", preferredTime: "завтра после 18:00", budget: 15000 });
    await expect(op.mutation(api.leads.create, { clientName: "Х", phone: "77015550141", source: "olx", serviceId: "ac-repair", city: "Алматы", description: "x", urgency: "normal", budget: -5 })).rejects.toThrow("не меньше нуля");

    const order = await op.mutation(api.leads.convert, { id: lead.id });
    const o = await s.get(order.id);
    expect(o).toMatchObject({ address: "мкр. Самал-2, д. 58", deadline: "2026-10-15T07:00:00.000Z", clientPrice: 0 });
    const history = await s.t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", order.id)).collect());
    expect(history[0]!.text).toBe("Заказ создан из заявки, срок 15.10.2026 12:00. Клиенту удобно: завтра после 18:00");

    // Срочная — через 4 часа; срок можно передать явно.
    const urgent = await op.mutation(api.leads.create, { clientName: "Срочный", phone: "77015550142", source: "phone", serviceId: "leak-fix", city: "Алматы", description: "Течёт", urgency: "urgent" });
    expect((await s.get((await op.mutation(api.leads.convert, { id: urgent.id })).id)).deadline).toBe(iso(Date.UTC(2026, 9, 14, 10, 0)));
    const manual = await op.mutation(api.leads.create, { clientName: "Обычный", phone: "77015550143", source: "phone", serviceId: "leak-fix", city: "Алматы", description: "Капает", urgency: "normal" });
    const set = await op.mutation(api.leads.convert, { id: manual.id, deadline: "2026-10-20T13:00:00.000Z" });
    expect((await s.get(set.id)).deadline).toBe("2026-10-20T13:00:00.000Z");
    await expect(op.mutation(api.leads.convert, { id: (await op.mutation(api.leads.create, { clientName: "Битый", phone: "77015550144", source: "phone", serviceId: "leak-fix", city: "Алматы", description: "x", urgency: "normal" })).id, deadline: "когда-нибудь" })).rejects.toThrow("Неверная дата");
  });

  test("удаление данных клиента стирает и адрес с удобным временем в его заявках", async () => {
    const s = await setup();
    const lead = await s.as(s.ids.operator).mutation(api.leads.create, { clientName: "Стираемый", phone: "77015550150", source: "olx", serviceId: "ac-repair", city: "Алматы", description: "x", urgency: "normal", address: "Абая 1", preferredTime: "утром" });
    await s.as(s.ids.operator).mutation(api.leads.setStatus, { id: lead.id, status: "rejected", reason: "Дорого" });
    const clientId = (await s.get(lead.id)).clientId;
    await s.as(s.ids.owner).mutation(api.clients.anonymize, { clientId, confirmPhone: "77015550150" });
    const l = await s.get(lead.id);
    expect(l.address).toBeUndefined();
    expect(l.preferredTime).toBeUndefined();
  });
});

// ── Серверные запреты ────────────────────────────────────────────────────────

describe("целостность данных на сервере (E24, E25, E10)", () => {
  test("заявку, ставшую заказом или закрытую отказом, сервер не правит; закрытую отказом — не превращает в заказ", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const a = await op.mutation(api.leads.create, { clientName: "Клиент Тест", phone: "77071234567", source: "olx", serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "normal" });
    await op.mutation(api.leads.convert, { id: a.id });
    await expect(op.mutation(api.leads.update, { id: a.id, description: "Другое" })).rejects.toThrow("уже создан заказ");
    await expect(op.mutation(api.leads.take, { id: a.id })).rejects.toThrow("уже создан заказ");

    const b = await op.mutation(api.leads.create, { clientName: "Клиент Тест", phone: "77071234567", source: "olx", serviceId: "ac-repair", city: "Алматы", description: "Шумит", urgency: "normal" });
    await op.mutation(api.leads.setStatus, { id: b.id, status: "rejected", reason: "Дорого" });
    await expect(op.mutation(api.leads.update, { id: b.id, urgency: "urgent" })).rejects.toThrow("закрыта отказом");
    await expect(op.mutation(api.leads.convert, { id: b.id })).rejects.toThrow("закрыта отказом");
    // Вернули в работу — снова можно.
    await op.mutation(api.leads.setStatus, { id: b.id, status: "qualifying" });
    await op.mutation(api.leads.update, { id: b.id, urgency: "urgent" });
    expect((await s.get(b.id)).urgency).toBe("urgent");
  });

  test("привязка звонка: проверяются обе стороны, звонок другого клиента не переезжает к чужой заявке; привязка — в журнале", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const lead = await op.mutation(api.leads.create, { clientName: "Клиент Тест", phone: "77071234567", source: "phone", serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "normal" });
    const foreign = await s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77019998877", to: "77273450000", clientId: s.ids.other, clientName: "Другой Клиент", status: "completed", startedAt: iso(Date.now()), aiStatus: "none" }));
    await expect(op.mutation(api.calls.linkLead, { id: foreign, leadId: lead.id })).rejects.toThrow("звонок другого клиента");
    expect((await s.get(foreign)).leadId).toBeUndefined();

    const own = await s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77071234567", to: "77273450000", clientId: s.ids.client, status: "completed", startedAt: iso(Date.now()), aiStatus: "none" }));
    await op.mutation(api.calls.linkLead, { id: own, leadId: lead.id });
    expect((await s.get(lead.id)).callId).toBe(own);
    expect(await s.journal("call.linked")).toHaveLength(1);
    // Второй звонок к той же заявке — отказ.
    const second = await s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77071234567", to: "77273450000", clientId: s.ids.client, status: "completed", startedAt: iso(Date.now()), aiStatus: "none" }));
    await expect(op.mutation(api.calls.linkLead, { id: second, leadId: lead.id })).rejects.toThrow("другой звонок");
  });

  test("услугу перенесли в другое направление — её активные заказы переходят вместе с ней, мастера нового направления узнают", async () => {
    const s = await setup();
    const owner = s.as(s.ids.owner);
    const inFeed = await s.mkOrder({ requiredSkills: ["Ремонт кондиционеров"] });
    const inWork = await s.mkOrder({ status: "in_progress", executorId: s.ids.asel.id, assignedAt: iso(Date.now() - DAY) });
    const done = await s.mkOrder({ status: "done", executorId: s.ids.asel.id, doneAt: iso(Date.now() - DAY) });
    const other = await s.mkOrder({ serviceId: "ac-clean" });
    const svc = (await owner.query(api.catalog.list, {}))!.services.find((x) => x.id === "ac-repair")!;
    if (!("price" in svc)) throw new Error("владельцу нужны цены услуги");
    await owner.mutation(api.catalog.saveService, { id: "ac-repair", category: "appliances", label: svc.label, icon: svc.icon, priceMin: svc.price[0], priceMax: svc.price[1], payoutPct: svc.payoutPct, examples: svc.examples, active: true });

    expect(await s.get(inFeed)).toMatchObject({ category: "appliances" });
    // Навыка «Ремонт кондиционеров» в новом направлении нет — требование снято.
    expect((await s.get(inFeed)).requiredSkills).toBeUndefined();
    expect((await s.get(inWork)).category).toBe("appliances");
    expect((await s.get(done)).category).toBe("ac");
    expect((await s.get(other)).category).toBe("ac");
    const history = await s.t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", inWork)).collect());
    expect(history.at(-1)!.text).toBe("Направление заказа: «Кондиционеры» → «Бытовая техника» — услугу перенесли в справочнике");
    expect((await s.journal("catalog.service"))[0]!.summary).toContain("активных заказов перенесено: 2");

    // Фоном — «Новый заказ» мастерам нового направления.
    expect(await s.t.mutation(internal.worker._announceMoved, { ids: [inFeed], fromCategory: "ac" })).toBe(1);
    expect((await s.notes(s.ids.appl.user))[0]).toContain("Новый заказ №");
    expect(await s.notes(s.ids.bauyr.user)).toEqual([]);
  });
});

// ── Колл-трекинг: источник по номеру, на который позвонили ───────────────────

describe("источник звонка по номеру линии (OLX)", () => {
  const AI = { summary: "Не холодит кондиционер", extracted: [], questions: [] };

  test("звонок на номер из объявлений OLX — заявка и клиент «OLX»; остальные — «Телефон»; список задаёт только владелец", async () => {
    const s = await setup();
    await expect(s.as(s.ids.operator).mutation(api.pbx.setLines, { lines: [{ number: "8 727 345 00 01", source: "olx" }] })).rejects.toThrow();
    await s.as(s.ids.owner).mutation(api.pbx.setLines, { lines: [{ number: "8 727 345 00 01", source: "olx" }] });
    expect((await s.as(s.ids.owner).query(api.pbx.settings, {})).lines).toEqual([{ number: "77273450001", source: "olx" }]);

    const olxCall = await s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550130", to: "77273450001", status: "completed", startedAt: iso(Date.now()), aiStatus: "pending" }));
    await s.t.mutation(internal.calls._saveAi, { id: olxCall, status: "done", ai: AI, draft: { serviceId: "ac-repair" }, autoLead: true });
    const lead = await s.get((await s.get(olxCall)).leadId!);
    expect(lead.source).toBe("olx");
    expect((await s.get(lead.clientId)).source).toBe("olx");

    const other = await s.t.run((ctx) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550131", to: "77273459999", status: "completed", startedAt: iso(Date.now()), aiStatus: "pending" }));
    await s.t.mutation(internal.calls._saveAi, { id: other, status: "done", ai: AI, draft: { serviceId: "ac-repair" }, autoLead: true });
    expect((await s.get((await s.get(other)).leadId!)).source).toBe("phone");

    await expect(s.as(s.ids.owner).mutation(api.pbx.setLines, { lines: [{ number: "12", source: "olx" }] })).rejects.toThrow(/от 7 до 15 цифр/);
  });
});
