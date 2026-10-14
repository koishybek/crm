/// <reference types="vite/client" />
// Исполнитель и подбор: районы (ТЗ п.12.3) — в правиле fitsOrder, ленте, «Новом заказе» и «Взять заказ»;
// история за 90 дней (п.12.6) и её вес в подборе; ставки мастера (п.14.5) — в ленте, при взятии и назначении, снимок.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { sanitize } from "./ai";
import { findDistrict } from "../src/data/cities";
import { fitsOrder, historyLine, payoutFor, qualityScore, rankExecutors, termsFor } from "../src/data/logic";
import type { Executor } from "../src/data/types";
import { money } from "../src/lib/format";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const DAY = 86400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const at = iso(0);
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const executor = async (name: string, e: Partial<Doc<"executors">> = {}) => {
      const id = await ctx.db.insert("executors", { tenantId: T, name, phone: `7700${Math.random().toString().slice(2, 9)}`, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 4.8, reviews: 5, cooperation: "freelance", joinedAt: at, ...e });
      const user = await ctx.db.insert("users", { name, email: `${name}@ex.kz`, role: "executor", executorId: id, tenantId: T, active: true });
      return { id, user };
    };
    const bostandyk = await executor("Бостан Районов", { districts: ["Бостандыкский"] });
    const auezov = await executor("Ауэз Районов", { districts: ["Ауэзовский"] });
    const anywhere = await executor("Город Весь");
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Секретов", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 1, lastActivityAt: at });
    const base = {
      tenantId: T,
      clientId: client,
      clientName: "Клиент Секретов",
      clientPhone: "77071234567",
      source: "olx" as const,
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит",
      city: "Алматы",
      address: "ул. Тимирязева, 42",
      deadline: iso(-DAY),
      priority: "normal" as const,
      clientPrice: 30000,
      payoutMode: "percent" as const,
      payoutValue: 50,
      payments: [],
      payoutPaid: false,
      createdAt: at,
      createdBy: operator,
      files: [],
    };
    const inBostandyk = await ctx.db.insert("orders", { ...base, number: 1001, status: "awaiting_executor", district: "Бостандыкский" });
    const noDistrict = await ctx.db.insert("orders", { ...base, number: 1002, status: "awaiting_executor" });
    const draft = await ctx.db.insert("orders", { ...base, number: 1003, status: "new", district: "Ауэзовский" });
    return { owner, operator, bostandyk, auezov, anywhere, client, inBostandyk, noDistrict, draft, base };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const order = (id: Id<"orders">) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const executor = (id: Id<"executors">) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const notes = (user: Id<"users">) => t.run(async (ctx) => (await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", user)).collect()).map((n) => n.text));
  return { t, ids, as, order, executor, notes };
}

const dto = (e: Partial<Executor> & { id: string; name: string }): Executor => ({
  tenantId: T,
  phone: "77000000000",
  city: "Алматы",
  categories: ["ac"],
  skills: [],
  available: true,
  rating: 4.8,
  reviews: 5,
  cooperation: "freelance",
  joinedAt: iso(0),
  ...e,
});

// ── Районы ───────────────────────────────────────────────────────────────────

describe("районы в правиле подбора (fitsOrder)", () => {
  const e = { available: true, city: "Алматы", categories: ["ac"], skills: [] as string[] };
  test("у мастера заданы районы и у заказа есть район — район должен совпасть (без учёта регистра)", () => {
    expect(fitsOrder({ ...e, districts: ["Бостандыкский"] }, { category: "ac", city: "Алматы", district: "бостандыкский " }).fits).toBe(true);
    const r = fitsOrder({ ...e, districts: ["Бостандыкский"] }, { category: "ac", city: "Алматы", district: "Ауэзовский" });
    expect(r.fits).toBe(false);
    expect(r.reasons).toEqual(["другой район"]);
  });
  test("у мастера районов нет или у заказа нет района — как раньше", () => {
    expect(fitsOrder(e, { category: "ac", city: "Алматы", district: "Ауэзовский" }).fits).toBe(true);
    expect(fitsOrder({ ...e, districts: ["Бостандыкский"] }, { category: "ac", city: "Алматы" }).fits).toBe(true);
  });
  test("другой город — причина «другой город», а не район", () => {
    expect(fitsOrder({ ...e, districts: ["Бостандыкский"] }, { category: "ac", city: "Астана", district: "Есильский" }).reasons).toEqual(["другой город"]);
  });
  test("кандидат из другого района — в списке с причиной «другой район»", () => {
    const ranked = rankExecutors({ category: "ac", city: "Алматы", district: "Ауэзовский" }, [dto({ id: "a", name: "А", districts: ["Бостандыкский"] }), dto({ id: "b", name: "Б" })], []);
    expect(ranked.map((c) => [c.e.id, c.fits, c.reasons])).toEqual([
      ["b", true, []],
      ["a", false, ["другой район"]],
    ]);
  });
});

describe("районы: лента, «Новый заказ», «Взять заказ»", () => {
  test("лента мастера с районами — только его район и заказы без района", async () => {
    const { ids, as } = await setup();
    const feedOf = async (u: Id<"users">) => (await as(u).query(api.worker.feed, {})).feed.map((o) => o.number).sort();
    expect(await feedOf(ids.bostandyk.user)).toEqual([1001, 1002]);
    expect(await feedOf(ids.auezov.user)).toEqual([1002]);
    expect(await feedOf(ids.anywhere.user)).toEqual([1001, 1002]);
  });

  test("публикация — «Новый заказ» только мастерам этого района и мастерам без районов", async () => {
    const { ids, as, notes } = await setup();
    const r = await as(ids.operator).mutation(api.orders.changeStatus, { id: ids.draft, to: "awaiting_executor" });
    expect(r).toEqual({ notified: 2 });
    expect((await notes(ids.auezov.user)).some((n) => n.includes("№1003") && n.includes("Ауэзовский р-н"))).toBe(true);
    expect((await notes(ids.anywhere.user)).some((n) => n.includes("№1003"))).toBe(true);
    expect((await notes(ids.bostandyk.user)).some((n) => n.includes("№1003"))).toBe(false);
  });

  test("«Взять заказ» чужого района — отказ с причиной; своего — берёт", async () => {
    const { ids, as, order } = await setup();
    await expect(as(ids.auezov.user).mutation(api.worker.take, { id: ids.inBostandyk })).rejects.toThrow("другой район");
    await as(ids.bostandyk.user).mutation(api.worker.take, { id: ids.inBostandyk });
    expect((await order(ids.inBostandyk)).executorId).toBe(ids.bostandyk.id);
  });

  test("район заказа — только из справочника города; сменили город — район сбрасывается", async () => {
    const { ids, as, order } = await setup();
    const o = await order(ids.draft);
    const info = { serviceId: o.serviceId, description: o.description, city: "Алматы", address: o.address, deadline: o.deadline, priority: o.priority };
    await expect(as(ids.operator).mutation(api.orders.updateInfo, { id: ids.draft, ...info, district: "Есильский" })).rejects.toThrow("нет в справочнике города Алматы");
    await as(ids.operator).mutation(api.orders.updateInfo, { id: ids.draft, ...info, district: "медеуский" });
    expect((await order(ids.draft)).district).toBe("Медеуский");
    await as(ids.operator).mutation(api.orders.updateInfo, { id: ids.draft, ...info, city: "Астана" });
    expect((await order(ids.draft)).district).toBeUndefined();
  });

  test("заявка с районом → заказ с тем же районом", async () => {
    const { t, ids, as } = await setup();
    const lead = await as(ids.operator).mutation(api.leads.create, { clientName: "Новый", phone: "77015556677", source: "phone", serviceId: "ac-repair", city: "Алматы", description: "Течёт кондиционер", urgency: "normal", district: "Турксибский" });
    const res = await as(ids.operator).mutation(api.leads.convert, { id: lead.id });
    expect((await t.run((ctx) => ctx.db.get(res.id)))!.district).toBe("Турксибский");
  });

  test("районы мастера — из справочника его города; справочник правит только владелец, с журналом", async () => {
    const { t, ids, as, executor } = await setup();
    const e = await executor(ids.anywhere.id);
    const fields = { name: e.name, phone: e.phone, city: e.city, categories: e.categories, skills: e.skills, cooperation: e.cooperation };
    await expect(as(ids.operator).mutation(api.executors.update, { id: e._id, ...fields, districts: ["Нет такого"] })).rejects.toThrow("нет в справочнике");
    await as(ids.operator).mutation(api.executors.update, { id: e._id, ...fields, districts: ["Медеуский", "Алмалинский"] });
    expect((await executor(e._id)).districts).toEqual(["Медеуский", "Алмалинский"]);

    await expect(as(ids.operator).mutation(api.districts.save, { list: [{ city: "Алматы", districts: ["Новый"] }] })).rejects.toThrow("Нет доступа");
    const saved = await as(ids.owner).mutation(api.districts.save, { list: [{ city: "г. Алматы", districts: ["Бостандыкский", "бостандыкский", " Новый район "] }] });
    expect(saved).toEqual([{ city: "Алматы", districts: ["Бостандыкский", "Новый район"] }]);
    expect(await as(ids.operator).query(api.districts.list, {})).toEqual(saved);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((a) => a.action === "settings.districts")?.summary).toContain("+«Новый район»");
  });
});

describe("район из AI-разбора — только явно названный", () => {
  const list = ["Бостандыкский", "Ауэзовский", "Медеуский"];
  test("«Бостандыкский район», «р-н», «район …» — находим; улица или микрорайон — нет; два района — нет", () => {
    expect(findDistrict("ул. Тимирязева 42, Бостандыкский район", list)).toBe("Бостандыкский");
    expect(findDistrict("Медеуский р-н, Самал-2", list)).toBe("Медеуский");
    expect(findDistrict("район Ауэзовский, мкр 5", list)).toBe("Ауэзовский");
    expect(findDistrict("ул. Тимирязева 42, мкр Орбита", list)).toBeNull();
    expect(findDistrict("Бостандык", list)).toBeNull();
    expect(findDistrict("на границе: Бостандыкский район / Ауэзовский район", list)).toBeNull();
  });
  test("sanitize: район из ответа AI сверяется со справочником города", () => {
    const hint = { services: [{ id: "ac-repair", label: "Ремонт кондиционера" }], cities: ["Алматы"], districts: [{ city: "Алматы", districts: list }] };
    const base = { summary: "s", serviceId: "ac-repair", city: "Алматы", urgency: "normal", questions: [] };
    expect(sanitize({ ...base, district: "бостандыкский" }, hint).district).toBe("Бостандыкский");
    expect(sanitize({ ...base, district: "Бостандыкский район" }, hint).district).toBe("Бостандыкский");
    expect(sanitize({ ...base, district: "Есильский" }, hint).district).toBeNull();
    expect(sanitize({ ...base, district: null, address: "Медеуский р-н, ул. Достык 1" }, hint).district).toBe("Медеуский");
    expect(sanitize({ ...base, district: null, address: "ул. Достык 1" }, hint).district).toBeNull();
  });
});

// ── История за 90 дней ───────────────────────────────────────────────────────

describe("история мастера за 90 дней (stats90)", () => {
  test("сдача работы и отказ обновляют историю; подбор показывает «вовремя …% · отказов …»", async () => {
    const { ids, as, executor } = await setup();
    await as(ids.bostandyk.user).mutation(api.worker.take, { id: ids.inBostandyk });
    await as(ids.bostandyk.user).mutation(api.worker.act, { id: ids.inBostandyk, action: "start" });
    await as(ids.bostandyk.user).mutation(api.worker.act, { id: ids.inBostandyk, action: "done" });
    let s = (await executor(ids.bostandyk.id)).stats90!;
    expect(s).toMatchObject({ done: 1, onTime: 1, refusals: 0, cancelled: 0 });

    await as(ids.bostandyk.user).mutation(api.worker.take, { id: ids.noDistrict });
    await as(ids.bostandyk.user).mutation(api.worker.act, { id: ids.noDistrict, action: "decline" });
    s = (await executor(ids.bostandyk.id)).stats90!;
    expect(s.refusals).toBe(1);
    expect(historyLine(s)).toBe("сдано 1 · отказов 1");
  });

  test("крон: окно сдвигается — отказ старше 90 дней уходит, просроченная сдача считается «не вовремя»", async () => {
    const { t, ids, executor } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.anywhere.id, { refusals: [iso(100 * DAY), iso(2 * DAY)] });
      for (let i = 0; i < 4; i++) {
        await ctx.db.insert("orders", { ...ids.base, number: 2000 + i, status: "paid", executorId: ids.anywhere.id, assignedAt: iso(10 * DAY), doneAt: iso(10 * DAY - 6 * 3_600_000), deadline: i === 0 ? iso(11 * DAY) : iso(5 * DAY) });
      }
      // Сдан 120 дней назад — вне окна.
      await ctx.db.insert("orders", { ...ids.base, number: 2010, status: "closed", executorId: ids.anywhere.id, assignedAt: iso(121 * DAY), doneAt: iso(120 * DAY) });
    });
    await t.mutation(internal.executorStats.refreshBatch, {});
    const e = await executor(ids.anywhere.id);
    expect(e.stats90).toMatchObject({ done: 4, onTime: 3, refusals: 1, avgHours: 6 });
    expect(e.refusals).toHaveLength(1);
    expect(historyLine(e.stats90)).toBe("вовремя 75% · отказов 1 · в среднем 6 ч");
  });

  test("вес в подборе: при прочих равных выше тот, кто сдаёт вовремя и не отказывается", () => {
    const stats = (onTime: number, refusals: number) => ({ done: 10, onTime, cancelled: 0, refusals, updatedAt: iso(0) });
    const good = dto({ id: "good", name: "Я", stats90: stats(10, 0) });
    const late = dto({ id: "late", name: "А", stats90: stats(5, 0) });
    const refuses = dto({ id: "refuses", name: "Б", stats90: stats(10, 2) });
    const fresh = dto({ id: "fresh", name: "В" });
    // 4,8 × 20 = 96: + 100% вовремя = 196; + 50% = 146; 100% − 2 × 15 = 166; новичок + 80% = 176.
    expect([good, late, refuses, fresh].map(qualityScore)).toEqual([196, 146, 166, 176]);
    const ranked = rankExecutors({ category: "ac", city: "Алматы" }, [late, refuses, fresh, good], []);
    expect(ranked.map((c) => c.e.id)).toEqual(["good", "fresh", "refuses", "late"]);
    // Загрузка важнее истории: свободный с плохой историей выше занятого с хорошей.
    const busy = rankExecutors({ category: "ac", city: "Алматы" }, [good, late], [{ executorId: "good", status: "in_progress" }]);
    expect(busy.map((c) => c.e.id)).toEqual(["late", "good"]);
  });

  test("автоподбор по правилам учитывает историю", async () => {
    const { t, ids, as, order } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.bostandyk.id, { districts: undefined, stats90: { done: 10, onTime: 4, cancelled: 0, refusals: 3, updatedAt: iso(0) } });
      await ctx.db.patch(ids.auezov.id, { available: false });
      await ctx.db.patch(ids.anywhere.id, { stats90: { done: 10, onTime: 10, cancelled: 0, refusals: 0, updatedAt: iso(0) } });
      await ctx.db.insert("history", { orderId: ids.noDistrict, kind: "status", text: "Опубликован", actor: { type: "system" }, at: iso(3_600_000) });
    });
    await as(ids.owner).mutation(api.autoAssign.configure, { enabled: true, minutes: 30 });
    await t.mutation(internal.autoAssign.run, {});
    expect((await order(ids.noDistrict)).executorId).toBe(ids.anywhere.id);
    const history = await t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", ids.noDistrict)).collect());
    expect(history.at(-1)!.text).toContain("Автоподбор: назначен");
    expect(history.at(-1)!.text).toContain("вовремя 100% · отказов 0");
  });
});

// ── Ставки ───────────────────────────────────────────────────────────────────

describe("ставки исполнителя", () => {
  const o = { serviceId: "ac-repair", clientPrice: 30000, payoutMode: "percent" as const, payoutValue: 50 };
  test("одно правило: ставка на услугу → общая ставка мастера → ставка услуги; ручная правка заказа важнее", () => {
    expect(termsFor(undefined, o)).toEqual({ payoutMode: "percent", payoutValue: 50 });
    expect(termsFor({ mode: "service" }, o)).toEqual({ payoutMode: "percent", payoutValue: 50 });
    expect(payoutFor({ mode: "percent", percent: 60 }, o)).toBe(18000);
    expect(payoutFor({ mode: "fixed", fixed: 12000 }, o)).toBe(12000);
    expect(payoutFor({ mode: "percent", percent: 60, perService: { "ac-repair": { fixed: 20000 } } }, o)).toBe(20000);
    expect(payoutFor({ mode: "percent", percent: 60, perService: { "ac-clean": { fixed: 20000 } } }, o)).toBe(18000);
    expect(payoutFor({ mode: "percent", percent: 60 }, { ...o, payoutManual: true })).toBe(15000);
    // База — условия заказа до ставки прежнего мастера.
    expect(payoutFor(undefined, { ...o, payoutMode: "fixed", payoutValue: 9000, payoutBase: { payoutMode: "percent", payoutValue: 50 } })).toBe(15000);
  });

  test("лента и «Новый заказ» — сумма по ставке мастера; «Взять заказ» фиксирует её снимком; отказ возвращает условия заказа", async () => {
    const { t, ids, as, order, notes } = await setup();
    await as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "percent", percent: 60 } });
    const feed = (await as(ids.anywhere.user).query(api.worker.feed, {})).feed.find((x) => x.number === 1002)!;
    expect(feed.payout).toBe(18000);
    expect((await as(ids.bostandyk.user).query(api.worker.feed, {})).feed.find((x) => x.number === 1002)!.payout).toBe(15000);

    await t.run((ctx) => ctx.db.patch(ids.draft, { district: undefined }));
    await as(ids.operator).mutation(api.orders.changeStatus, { id: ids.draft, to: "awaiting_executor" });
    expect((await notes(ids.anywhere.user)).find((n) => n.includes("№1003"))).toContain(`Оплата исполнителю ${money(18000)}`);
    expect((await notes(ids.auezov.user)).find((n) => n.includes("№1003"))).toContain(`Оплата исполнителю ${money(15000)}`);

    await as(ids.anywhere.user).mutation(api.worker.take, { id: ids.noDistrict });
    expect(await order(ids.noDistrict)).toMatchObject({ payoutMode: "percent", payoutValue: 60, acceptedPayout: 18000, payoutBase: { payoutMode: "percent", payoutValue: 50 } });
    // Ставку потом поменяли — взятый заказ не меняется (снимок).
    await as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "fixed", fixed: 5000 } });
    expect((await order(ids.noDistrict)).acceptedPayout).toBe(18000);

    await as(ids.anywhere.user).mutation(api.worker.act, { id: ids.noDistrict, action: "decline" });
    const back = await order(ids.noDistrict);
    expect(back).toMatchObject({ status: "awaiting_executor", payoutMode: "percent", payoutValue: 50 });
    expect(back.payoutBase).toBeUndefined();
    expect(back.acceptedPayout).toBeUndefined();
  });

  test("ручное назначение — по ставке назначенного; ставка больше цены — отказ с объяснением", async () => {
    const { ids, as, order } = await setup();
    await as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "service", perService: { "ac-repair": { fixed: 21000 } } } });
    await as(ids.operator).mutation(api.orders.assign, { id: ids.draft, executorId: ids.anywhere.id });
    expect(await order(ids.draft)).toMatchObject({ payoutMode: "fixed", payoutValue: 21000, status: "assigned" });
    // Переназначили — ставка нового, база прежняя.
    await as(ids.operator).mutation(api.orders.assign, { id: ids.draft, executorId: ids.auezov.id });
    expect(await order(ids.draft)).toMatchObject({ payoutMode: "percent", payoutValue: 50 });

    await as(ids.owner).mutation(api.executorRates.set, { id: ids.bostandyk.id, rates: { mode: "fixed", fixed: 45000 } });
    await expect(as(ids.operator).mutation(api.orders.assign, { id: ids.inBostandyk, executorId: ids.bostandyk.id })).rejects.toThrow("больше цены клиента");
  });

  test("ручная правка выплаты в заказе важнее ставки мастера", async () => {
    const { ids, as, order } = await setup();
    await as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "percent", percent: 70 } });
    await as(ids.operator).mutation(api.orders.updateFinance, { id: ids.noDistrict, clientPrice: 30000, payoutMode: "fixed", payoutValue: 10000 });
    expect((await order(ids.noDistrict)).payoutManual).toBe(true);
    await as(ids.anywhere.user).mutation(api.worker.take, { id: ids.noDistrict });
    expect(await order(ids.noDistrict)).toMatchObject({ payoutMode: "fixed", payoutValue: 10000, acceptedPayout: 10000 });
  });

  test("ставки меняет только владелец; проверка значений; каждое изменение — в журнал", async () => {
    const { t, ids, as, executor } = await setup();
    await expect(as(ids.operator).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "percent", percent: 60 } })).rejects.toThrow("Нет доступа");
    await expect(as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "percent" } })).rejects.toThrow("Укажите процент");
    await expect(as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "percent", percent: 140 } })).rejects.toThrow("от 0 до 100");
    await expect(as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "service", perService: { "no-such": { fixed: 1000 } } } })).rejects.toThrow("Такой услуги нет");
    await as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: { mode: "percent", percent: 55, perService: { "ac-repair": { fixed: 12000 } } } });
    expect((await executor(ids.anywhere.id)).rates).toEqual({ mode: "percent", percent: 55, perService: { "ac-repair": { fixed: 12000 } } });
    await as(ids.owner).mutation(api.executorRates.set, { id: ids.anywhere.id, rates: null });
    expect((await executor(ids.anywhere.id)).rates).toBeUndefined();
    const journal = (await t.run((ctx) => ctx.db.query("audit").collect())).filter((a) => a.action === "executor.rates");
    expect(journal.map((a) => a.summary)).toEqual([
      `Город В.: ставки — ставка услуги → свой процент 55%; Ремонт кондиционера — ${money(12000)}`,
      `Город В.: ставки — свой процент 55%; Ремонт кондиционера — ${money(12000)} → ставка услуги`,
    ]);
  });
});
