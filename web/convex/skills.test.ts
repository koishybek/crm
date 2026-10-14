/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { fitsOrder, rankExecutors, type FitExecutor } from "../src/data/logic";
import { normalizeSkills, textKey } from "../src/data/skills";
import type { Executor } from "../src/data/types";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const at = new Date().toISOString();
const SKILL = "Промышленный климат";

type ExecutorSeed = { name: string; phone: string; city?: string; categories?: string[]; skills?: string[]; available?: boolean; chat?: string };

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор Тест", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель Сантехники", email: "lead@test.kz", role: "manager", categories: ["plumbing"], tenantId: T, active: true });
    const mk = async (s: ExecutorSeed) => {
      const ex = await ctx.db.insert("executors", {
        tenantId: T,
        name: s.name,
        phone: s.phone,
        city: s.city ?? "Алматы",
        categories: s.categories ?? ["ac"],
        skills: s.skills ?? [],
        available: s.available ?? true,
        rating: 4.8,
        reviews: 10,
        cooperation: "freelance",
        joinedAt: at,
      });
      const user = await ctx.db.insert("users", { name: s.name, email: s.phone, phone: s.phone, role: "executor", executorId: ex, tenantId: T, active: true, telegramChatId: s.chat });
      return { ex, user };
    };
    // Навык записан «как попало»: другой регистр и лишние пробелы — сравнение должно это пережить.
    const skilled = await mk({ name: "Берик Климатов", phone: "77000000002", skills: ["  промышленный   КЛИМАТ "], chat: "502" });
    const plain = await mk({ name: "Асет Новиков", phone: "77000000001", skills: ["Монтаж сплит-систем"], chat: "501" });
    const off = await mk({ name: "Данияр Выходной", phone: "77000000003", skills: [SKILL], available: false, chat: "503" });
    const astana = await mk({ name: "Серик Астана", phone: "77000000004", city: "Астана", skills: [SKILL] });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 1, lastActivityAt: at });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Клиент Тест",
      clientPhone: "77071234567",
      source: "olx",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит VRF-система в офисе",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      priority: "normal",
      status: "new",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      createdAt: at,
      createdBy: owner,
      files: [],
      requiredSkills: [SKILL],
    });
    return { owner, operator, manager, skilled, plain, off, astana, client, order };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });
  const inbox = (userId: Id<"users">) => t.run(async (ctx) => (await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect()).map((n) => n.text));
  const order = () => t.run(async (ctx) => (await ctx.db.get(ids.order))!);
  const auditOf = (action: string) => t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((a) => a.action === action));
  const publish = () => as(ids.operator).mutation(api.orders.changeStatus, { id: ids.order, to: "awaiting_executor" });
  const info = (o: Doc<"orders">) => ({ id: o._id, serviceId: o.serviceId, description: o.description, city: o.city, address: o.address, deadline: o.deadline, priority: o.priority });
  return { t, ids, as, inbox, order, auditOf, publish, info };
}

describe("лента и «Новый заказ» с учётом навыков", () => {
  test("мастер без требуемого навыка не видит заказ и не получает уведомление; с навыком (другой регистр, лишние пробелы) — видит и получает", async () => {
    const { ids, as, inbox, publish } = await setup();
    const res = await publish();
    expect(res).toEqual({ notified: 1 });

    expect((await as(ids.plain.user).query(api.worker.feed, {})).feed).toHaveLength(0);
    expect((await inbox(ids.plain.user)).some((x) => x.includes("Новый заказ №1001"))).toBe(false);

    const feed = await as(ids.skilled.user).query(api.worker.feed, {});
    expect(feed.feed.map((o) => o.id)).toEqual([ids.order]);
    expect(feed.feed[0]!.requiredSkills).toEqual([SKILL]);
    expect((await inbox(ids.skilled.user)).filter((x) => x.includes("Новый заказ №1001"))).toHaveLength(1);

    // Другой город — не видит и не получает, даже с навыком.
    expect((await as(ids.astana.user).query(api.worker.feed, {})).feed).toHaveLength(0);
    expect(await inbox(ids.astana.user)).toEqual([]);
  });

  test("мастер на выходном не получает уведомление и не может взять заказ, но ленту видит", async () => {
    const { ids, as, inbox, publish, order } = await setup();
    await publish();
    expect(await inbox(ids.off.user)).toEqual([]);
    expect((await as(ids.off.user).query(api.worker.feed, {})).feed.map((o) => o.id)).toEqual([ids.order]);
    await expect(as(ids.off.user).mutation(api.worker.take, { id: ids.order })).rejects.toThrow("Сначала включите приём заказов в профиле");
    expect((await order()).executorId).toBeUndefined();
  });

  test("уволенный мастер (доступ отключён) «Новый заказ» не получает — даже если подходит", async () => {
    const { t, ids, inbox, publish } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.skilled.user, { active: false }));
    expect(await publish()).toEqual({ notified: 0 });
    expect(await inbox(ids.skilled.user)).toEqual([]);
  });

  test("Telegram /feed отдаёт те же заказы, что и кабинет; на выходном — признак выходного", async () => {
    const { t, publish } = await setup();
    await publish();
    const skilled = await t.query(internal.worker._forChat, { chatId: "502", what: "feed" });
    expect(skilled.cards.map((c) => c.number)).toEqual([1001]);
    const plain = await t.query(internal.worker._forChat, { chatId: "501", what: "feed" });
    expect(plain.cards).toHaveLength(0);
    const off = await t.query(internal.worker._forChat, { chatId: "503", what: "feed" });
    expect(off.available).toBe(false); // бот ответит «Вы на выходном — включите приём», карточки не шлёт
    expect(off.cards.map((c) => c.number)).toEqual([1001]); // лента та же, что в кабинете: подходящие заказы видны
  });

  test("после снятия требования к навыку заказ из ленты приходит тем, кому он стал подходить, — и только им", async () => {
    const { ids, as, inbox, publish, order, info, auditOf } = await setup();
    await publish();
    const res = await as(ids.operator).mutation(api.orders.updateInfo, { ...info(await order()), requiredSkills: [] });
    expect(res).toEqual({ notified: 1 }); // Асет: тот же город и направление, навык больше не нужен
    expect((await inbox(ids.plain.user)).filter((x) => x.includes("Новый заказ №1001"))).toHaveLength(1);
    expect((await inbox(ids.skilled.user)).filter((x) => x.includes("Новый заказ №1001"))).toHaveLength(1); // второй раз не зовём
    expect(await inbox(ids.off.user)).toEqual([]);
    expect((await order()).requiredSkills).toBeUndefined();
    const log = await auditOf("order.skills");
    expect(log).toHaveLength(1);
    expect(log[0]!.summary).toContain("требования к навыкам сняты");
  });

  test("мастер отказался — заказ снова в ленте, остальным подходящим приходит «Снова свободен», ему — нет", async () => {
    const { t, ids, as, inbox, publish } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { requiredSkills: undefined }));
    await publish();
    await as(ids.plain.user).mutation(api.worker.take, { id: ids.order });
    await as(ids.plain.user).mutation(api.worker.act, { id: ids.order, action: "decline" });
    expect((await inbox(ids.skilled.user)).filter((x) => x.includes("Снова свободен заказ №1001"))).toHaveLength(1);
    expect((await inbox(ids.plain.user)).filter((x) => x.includes("Снова свободен"))).toHaveLength(0);
    expect((await as(ids.skilled.user).query(api.worker.feed, {})).feed).toHaveLength(1);
  });
});

describe("«Взять заказ»: сервер перепроверяет, подходит ли заказ", () => {
  test("неподходящий мастер по прямому вызову получает отказ с причиной; подходящий — берёт", async () => {
    const { ids, as, publish, order, auditOf } = await setup();
    await publish();
    await expect(as(ids.plain.user).mutation(api.worker.take, { id: ids.order })).rejects.toThrow(`не подходит (нет навыка: ${SKILL})`);
    await expect(as(ids.astana.user).mutation(api.worker.take, { id: ids.order })).rejects.toThrow("другой город");
    expect((await order()).status).toBe("awaiting_executor");

    await as(ids.skilled.user).mutation(api.worker.take, { id: ids.order });
    const o = await order();
    expect(o.status).toBe("accepted");
    expect(o.executorId).toBe(ids.skilled.ex);
    expect(await auditOf("order.taken")).toHaveLength(1);
    // Повторное нажатие тем же мастером — понятный ответ, а не «взял другой».
    await expect(as(ids.skilled.user).mutation(api.worker.take, { id: ids.order })).rejects.toThrow("уже ваш");
  });

  test("неопубликованный заказ взять нельзя, даже если он подходит", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.skilled.user).mutation(api.worker.take, { id: ids.order })).rejects.toThrow("снят с ленты");
  });

  test("из Telegram действует то же правило", async () => {
    const { t, ids, publish, order } = await setup();
    await publish();
    const refused = await t.mutation(internal.worker.takeFromTelegram, { chatId: "501", orderId: ids.order });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("нет навыка");
    const taken = await t.mutation(internal.worker.takeFromTelegram, { chatId: "502", orderId: ids.order });
    expect(taken.ok).toBe(true);
    expect((await order()).executorId).toBe(ids.skilled.ex);
  });
});

describe("требуемые навыки заказа", () => {
  test("только из справочника направления заказа; написание — как в справочнике; история и журнал пишутся", async () => {
    const { ids, as, order, info, auditOf, t } = await setup();
    const base = info(await order());
    await expect(as(ids.operator).mutation(api.orders.updateInfo, { ...base, requiredSkills: ["Сварка труб"] })).rejects.toThrow("нет в справочнике направления «Кондиционеры»");
    // Навык другого направления (бытовая техника) к кондиционерам не подходит.
    await expect(as(ids.operator).mutation(api.orders.updateInfo, { ...base, requiredSkills: ["Холодильники"] })).rejects.toThrow("нет в справочнике");
    await expect(as(ids.operator).mutation(api.orders.updateInfo, { ...base, requiredSkills: ["x".repeat(41)] })).rejects.toThrow("длиннее 40");

    await as(ids.operator).mutation(api.orders.updateInfo, { ...base, requiredSkills: ["  заправка   ФРЕОНОМ ", "Заправка фреоном", SKILL] });
    expect((await order()).requiredSkills).toEqual(["Заправка фреоном", SKILL]);
    const history = await t.run((ctx) => ctx.db.query("history").collect());
    expect(history.some((h) => h.text === `Нужны навыки: Заправка фреоном, ${SKILL}`)).toBe(true);
    expect(await auditOf("order.skills")).toHaveLength(1);
  });

  test("без поля requiredSkills навыки не меняются; смена направления убирает навыки старого", async () => {
    const { ids, as, order, info } = await setup();
    const base = info(await order());
    await as(ids.operator).mutation(api.orders.updateInfo, { ...base, address: "ул. Абая, 2" });
    expect((await order()).requiredSkills).toEqual([SKILL]);
    await as(ids.operator).mutation(api.orders.updateInfo, { ...base, serviceId: "wm-repair" });
    const o = await order();
    expect(o.category).toBe("appliances");
    expect(o.requiredSkills).toBeUndefined();
  });

  test("навык, который владелец убрал из справочника, на заказе остаётся и не мешает правкам", async () => {
    const { ids, as, order, info } = await setup();
    await as(ids.owner).mutation(api.catalog.saveCategory, { id: "ac", label: "Кондиционеры", tone: "blue", active: true, skills: ["Монтаж сплит-систем"] });
    await as(ids.operator).mutation(api.orders.updateInfo, { ...info(await order()), priority: "urgent", requiredSkills: [SKILL] });
    expect((await order()).requiredSkills).toEqual([SKILL]);
  });

  test("правка навыков не повторяет напоминания о сроке; сдвиг срока взводит их заново", async () => {
    const { t, ids, as, order, info } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { soonNotified: true, overdueNotified: true }));
    await as(ids.operator).mutation(api.orders.updateInfo, { ...info(await order()), requiredSkills: ["Заправка фреоном"] });
    let o = await order();
    expect(o.soonNotified).toBe(true);
    expect(o.overdueNotified).toBe(true);
    await as(ids.operator).mutation(api.orders.updateInfo, { ...info(o), deadline: new Date(Date.now() + 3 * 86400_000).toISOString() });
    o = await order();
    expect(o.soonNotified).toBe(false);
    expect(o.overdueNotified).toBe(false);
  });

  test("права: исполнитель не может, руководитель — только в своём направлении", async () => {
    const { ids, as, order, info } = await setup();
    const base = { ...info(await order()), requiredSkills: [SKILL] };
    await expect(as(ids.skilled.user).mutation(api.orders.updateInfo, base)).rejects.toThrow("Нет доступа");
    await expect(as(ids.manager).mutation(api.orders.updateInfo, base)).rejects.toThrow("не ваше направление");
  });
});

describe("справочник навыков", () => {
  test("сохранение чистит пробелы и убирает повторы без учёта регистра; остальные направления получают навыки по умолчанию", async () => {
    const { ids, as, auditOf } = await setup();
    await as(ids.owner).mutation(api.catalog.saveCategory, {
      id: "ac",
      label: "  Кондиционеры ",
      tone: "blue",
      active: true,
      skills: ["  Монтаж   сплит-систем ", "монтаж сплит-систем", "Чистка", "", "ЧИСТКА "],
    });
    const list = await as(ids.operator).query(api.catalog.list, {});
    const ac = list!.categories.find((c) => c.id === "ac")!;
    expect(ac.label).toBe("Кондиционеры");
    expect(ac.skills).toEqual(["Монтаж сплит-систем", "Чистка"]);
    expect(list!.categories.find((c) => c.id === "plumbing")!.skills!.length).toBeGreaterThanOrEqual(4);
    const log = await auditOf("catalog.category");
    expect(log).toHaveLength(1);
    expect(log[0]!.summary).toContain("−«Заправка фреоном»");
  });

  test("лимиты и права: длинный навык, больше 30 навыков, не владелец — отказ", async () => {
    const { ids, as } = await setup();
    const save = (who: Id<"users">, skills: string[]) => as(who).mutation(api.catalog.saveCategory, { id: "ac", label: "Кондиционеры", tone: "blue", active: true, skills });
    await expect(save(ids.owner, ["y".repeat(41)])).rejects.toThrow("длиннее 40");
    await expect(save(ids.owner, Array.from({ length: 31 }, (_, i) => `Навык ${i}`))).rejects.toThrow("Не больше 30");
    await expect(save(ids.operator, ["Чистка"])).rejects.toThrow("Нет доступа");
  });

  test("направления, сохранённые до появления навыков, показывают навыки по умолчанию; пустой список владельца остаётся пустым", async () => {
    const { t, ids, as } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("categories", { key: "ac", label: "Кондиционеры", tone: "blue", order: 0, active: true });
      await ctx.db.insert("categories", { key: "plumbing", label: "Сантехника", tone: "sky", order: 1, active: true, skills: [] });
    });
    const list = await as(ids.operator).query(api.catalog.list, {});
    expect(list!.categories.find((c) => c.id === "ac")!.skills).toContain("Заправка фреоном");
    expect(list!.categories.find((c) => c.id === "plumbing")!.skills).toEqual([]);
  });
});

describe("навыки исполнителя", () => {
  test("сохраняются без повторов, совпавшие со справочником — в его написании, свои — как ввели", async () => {
    const { ids, as, t, auditOf } = await setup();
    await as(ids.operator).mutation(api.executors.update, {
      id: ids.plain.ex,
      name: "Асет Новиков",
      phone: "77000000001",
      city: "Алматы",
      categories: ["ac"],
      skills: ["  мытье   окон", "Мытьё окон", "Пайка плат", " "],
      cooperation: "freelance",
    });
    const ex = await t.run((ctx) => ctx.db.get(ids.plain.ex));
    expect(ex?.skills).toEqual(["Мытьё окон", "Пайка плат"]);
    expect(await auditOf("executor.updated")).toHaveLength(1);
    await expect(
      as(ids.operator).mutation(api.executors.update, { id: ids.plain.ex, name: "Асет", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: ["z".repeat(41)], cooperation: "freelance" }),
    ).rejects.toThrow("длиннее 40");
  });

  test("руководитель не может открыть мастеру чужое направление", async () => {
    const { t, ids, as } = await setup();
    const plumber = await t.run((ctx) =>
      ctx.db.insert("executors", { tenantId: T, name: "Марат Сантехник", phone: "77000000009", city: "Алматы", categories: ["plumbing"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at }),
    );
    const edit = (categories: string[]) => as(ids.manager).mutation(api.executors.update, { id: plumber, name: "Марат Сантехник", phone: "77000000009", city: "Алматы", categories, skills: [], cooperation: "freelance" });
    await expect(edit(["plumbing", "ac"])).rejects.toThrow("только специализации своего направления");
    await edit(["plumbing"]);
  });
});

describe("ручное назначение", () => {
  test("неподходящего назначить можно — причина пишется в историю; мастера на выходном назначает только владелец", async () => {
    const { t, ids, as, order, auditOf } = await setup();
    await as(ids.operator).mutation(api.orders.assign, { id: ids.order, executorId: ids.plain.ex });
    const history = await t.run((ctx) => ctx.db.query("history").collect());
    expect(history.some((h) => h.text.includes(`вне подбора: нет навыка: ${SKILL}`))).toBe(true);
    expect((await auditOf("order.assigned"))[0]!.meta).toMatchObject({ fits: false });

    await expect(as(ids.operator).mutation(api.orders.assign, { id: ids.order, executorId: ids.off.ex })).rejects.toThrow("только владелец");
    await as(ids.owner).mutation(api.orders.assign, { id: ids.order, executorId: ids.off.ex });
    expect((await order()).executorId).toBe(ids.off.ex);
    await expect(as(ids.owner).mutation(api.orders.assign, { id: ids.order, executorId: ids.off.ex })).rejects.toThrow("уже назначен");
  });

  test("руководитель не может назначить исполнителя другого направления", async () => {
    const { t, ids, as } = await setup();
    const plumbingOrder = await t.run(async (ctx) => {
      const base = (await ctx.db.get(ids.order))!;
      const { _id, _creationTime, ...copy } = base;
      void _id;
      void _creationTime;
      return ctx.db.insert("orders", { ...copy, number: 1002, serviceId: "leak-fix", category: "plumbing", requiredSkills: undefined });
    });
    await expect(as(ids.manager).mutation(api.orders.assign, { id: plumbingOrder, executorId: ids.plain.ex })).rejects.toThrow("другого направления");
  });
});

describe("правило подбора (чистая функция)", () => {
  const base: FitExecutor = { available: true, city: "Алматы", categories: ["cleaning"], skills: ["Мытье окон", "Химчистка мебели"] };
  const order = { category: "cleaning", city: " алматы ", requiredSkills: ["Мытьё  окон"] };

  test("регистр, пробелы, «ё/е» и вид дефиса не важны", () => {
    expect(fitsOrder(base, order).fits).toBe(true);
    expect(textKey("Сети и Wi‑Fi")).toBe(textKey("сети и wi-fi"));
    expect(fitsOrder({ ...base, skills: ["Сети и Wi-Fi"] }, { ...order, requiredSkills: ["Сети и Wi‑Fi"] }).fits).toBe(true);
  });

  test("все причины отказа перечислены", () => {
    const r = fitsOrder({ ...base, available: false, city: "Астана", categories: ["ac"], skills: [] }, { ...order, requiredSkills: ["Мытьё окон", "Химчистка ковров"] });
    expect(r.fits).toBe(false);
    expect(r.reasons).toEqual(["выходной", "другой город", "другая специализация", "нет навыков: Мытьё окон, Химчистка ковров"]);
    expect(r.matched).toBe(0);
  });

  test("подбор: сначала подходящие, свободные раньше занятых, затем рейтинг; неподходящие — ниже, но в списке", () => {
    const ex = (id: string, over: Partial<Executor>): Executor => ({ id, tenantId: T, name: id, phone: "", city: "Алматы", categories: ["cleaning"], skills: ["Мытьё окон"], available: true, rating: 4.5, reviews: 0, cooperation: "freelance", joinedAt: at, ...over });
    const list = [ex("busy", { rating: 5 }), ex("noskill", { skills: [] }), ex("free", { rating: 4.1 }), ex("other-city", { city: "Астана" }), ex("off", { available: false })];
    const ranked = rankExecutors({ category: "cleaning", city: "Алматы", requiredSkills: ["Мытьё окон"] }, list, [{ executorId: "busy", status: "in_progress" }]);
    expect(ranked.map((c) => c.e.id).slice(0, 2)).toEqual(["free", "busy"]);
    expect(ranked.slice(2).every((c) => !c.fits && c.reasons.length > 0)).toBe(true);
    expect(ranked.find((c) => c.e.id === "noskill")!.reasons).toEqual(["нет навыка: Мытьё окон"]);
  });

  test("нормализация списка: пустые и повторы убираются, лимиты проверяются", () => {
    expect(normalizeSkills([" А ", "а", "", "Б"], 5)).toEqual({ ok: true, skills: ["А", "Б"] });
    expect(normalizeSkills(["А", "Б", "В"], 2).ok).toBe(false);
  });
});
