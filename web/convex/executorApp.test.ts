/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { dueLabel, monthKeyAlmaty, relLabel, shiftMonth, weekStartAlmaty, whenLabel } from "../src/data/workerTime";
import { executorStats, groupByMonth, monthIncome, payoutBalance, weeklyIncome, type EarningOrder } from "../src/data/workerStats";
import { fitsProfile, missingSkills } from "../src/data/workerMatch";

// Шаблон из документации convex-test с `!(…)` в Vite 8 ничего не находит — фильтруем вручную.
const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

type OrderDoc = Omit<Doc<"orders">, "_id" | "_creationTime">;

async function setup() {
  // Ссылки на файлы подписываются ключом и адресом Convex (convex/lib/files.ts).
  vi.stubEnv("FILES_SIGNING_KEY", "test-files-key");
  vi.stubEnv("CONVEX_SITE_URL", "https://test.convex.site");
  const t = convexTest(schema, modules);
  const at = new Date().toISOString();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const mk = async (name: string, phone: string, city: string, categories: string[], skills: string[]) => {
      const ex = await ctx.db.insert("executors", { tenantId: T, name, phone, city, categories, skills, available: true, rating: 4.8, reviews: 2, cooperation: "freelance", joinedAt: "2025-03-10T05:00:00.000Z" });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: ex, tenantId: T, active: true });
      return { ex, user };
    };
    const a = await mk("Асет Алматы", "77000000001", "Алматы", ["ac", "appliances"], ["Чистка кондиционеров"]);
    const b = await mk("Берик Алматы", "77000000002", "Алматы", ["ac"], []);
    const c = await mk("Серик Астана", "77000000003", "Астана", ["ac"], ["Чистка кондиционеров"]);
    const orphan = await ctx.db.insert("users", { name: "Без профиля", email: "77000000009", role: "executor", tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });

    const photo = await ctx.storage.store(new Blob(["jpeg"], { type: "image/jpeg" }));
    const invoice = await ctx.storage.store(new Blob(["jpeg"], { type: "image/jpeg" }));
    const pdf = await ctx.storage.store(new Blob(["pdf"], { type: "application/pdf" }));
    const ownPhoto = await ctx.storage.store(new Blob(["jpeg"], { type: "image/jpeg" }));

    const base: OrderDoc = {
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
      address: "ул. Абая, 1, кв. 5",
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      priority: "normal",
      status: "awaiting_executor",
      clientPrice: 45000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      createdAt: "2026-10-01T05:00:00.000Z",
      createdBy: owner,
      files: [],
    };
    // Фото от клиента офис показал мастеру («Показать мастеру»); счёт и договор — только команде.
    const clientFile = { id: "f-photo", name: "кондиционер.jpg", kind: "image" as const, storageId: photo, forExecutor: true };
    const invoiceFile = { id: "f-invoice", name: "счёт 45000.jpg", kind: "image" as const, storageId: invoice };
    const pdfFile = { id: "f-pdf", name: "договор.pdf", kind: "file" as const, storageId: pdf };

    // Свободный заказ с фото клиента, счётом во внутренней заметке и договором.
    const feed = await ctx.db.insert("orders", { ...base, files: [clientFile, invoiceFile, pdfFile] });
    await ctx.db.insert("messages", { orderId: feed, author: { type: "user", id: owner }, channel: "client", text: "Фото от клиента", files: [clientFile], at: "2026-10-01T05:01:00.000Z" });
    await ctx.db.insert("messages", { orderId: feed, author: { type: "user", id: operator }, channel: "internal", text: "Клиенту выставили 45 000", files: [invoiceFile, pdfFile], at: "2026-10-01T05:02:00.000Z" });
    await ctx.db.insert("history", { orderId: feed, kind: "created", text: "Заказ создан из заявки", actor: { type: "user", id: owner }, at: "2026-10-01T05:00:00.000Z" });
    await ctx.db.insert("history", { orderId: feed, kind: "status", text: "Опубликован в ленту исполнителей", actor: { type: "user", id: owner }, at: "2026-10-01T06:00:00.000Z" });
    await ctx.db.insert("history", { orderId: feed, kind: "finance", text: "Финансы: 45 000 ₸ / 21 000 ₸", actor: { type: "user", id: owner }, at: "2026-10-01T06:30:00.000Z" });

    // Требует навык — у мастера он записан иначе (регистр, пробелы).
    const skilled = await ctx.db.insert("orders", { ...base, number: 1002, serviceId: "ac-clean", requiredSkills: ["чистка  кондиционеров"], createdAt: "2026-10-02T05:00:00.000Z" });
    const plumbing = await ctx.db.insert("orders", { ...base, number: 1003, serviceId: "leak-fix", category: "plumbing" });
    const astana = await ctx.db.insert("orders", { ...base, number: 1004, city: "Астана" });
    const takenByB = await ctx.db.insert("orders", { ...base, number: 1005, status: "accepted", executorId: b.ex, assignedAt: at });
    const assignedToA = await ctx.db.insert("orders", { ...base, number: 1006, status: "assigned", executorId: a.ex, assignedAt: at, files: [clientFile, invoiceFile] });
    await ctx.db.patch(assignedToA, { files: [clientFile, invoiceFile, { id: "f-own", name: "готово.jpg", kind: "image", storageId: ownPhoto, forExecutor: true }] });
    await ctx.db.insert("messages", { orderId: assignedToA, author: { type: "user", id: operator }, channel: "internal", text: "Маржа 24 000, не говорить мастеру", files: [invoiceFile], at: "2026-10-03T05:00:00.000Z" });
    await ctx.db.insert("messages", { orderId: assignedToA, author: { type: "user", id: a.user }, channel: "executor", text: "Буду через 15 минут", files: [{ id: "f-own", name: "готово.jpg", kind: "image", storageId: ownPhoto, forExecutor: true }], at: "2026-10-03T06:00:00.000Z" });
    return { owner, operator, a, b, c, orphan, client, feed, skilled, plumbing, astana, takenByB, assignedToA };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|test-session` });
  return { t, ids, as };
}

describe("executorApp: доступ", () => {
  test("без входа, сотрудникам и без профиля мастера — отказ", async () => {
    const { t, ids, as } = await setup();
    await expect(t.query(api.executorApp.profile, {})).rejects.toThrow("Нужно войти");
    await expect(t.query(api.executorApp.order, { id: ids.feed })).rejects.toThrow("Нужно войти");
    await expect(t.query(api.executorApp.feedExtras, {})).rejects.toThrow("Нужно войти");
    for (const staff of [ids.owner, ids.operator]) {
      await expect(as(staff).query(api.executorApp.profile, {})).rejects.toThrow("Нет доступа");
      await expect(as(staff).query(api.executorApp.order, { id: ids.feed })).rejects.toThrow("Нет доступа");
      await expect(as(staff).query(api.executorApp.feedExtras, {})).rejects.toThrow("Нет доступа");
    }
    await expect(as(ids.orphan).query(api.executorApp.profile, {})).rejects.toThrow("Профиль мастера не найден");
  });

  test("отключённый мастер теряет доступ", async () => {
    const { t, ids, as } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.a.user, { active: false }));
    await expect(as(ids.a.user).query(api.executorApp.order, { id: ids.feed })).rejects.toThrow("Нужно войти");
  });
});

describe("executorApp.order: экран заказа", () => {
  test("свободный подходящий заказ — без контактов, цены клиента и файлов команды", async () => {
    const { ids, as } = await setup();
    const view = await as(ids.a.user).query(api.executorApp.order, { id: ids.feed });
    expect(view.state).toBe("available");
    if (view.state !== "available") return;
    expect(view.order.payout).toBe(21000);
    expect(view.order.address).toBeUndefined();
    expect(view.order.clientName).toBeUndefined();
    expect(view.order.clientPhone).toBeUndefined();
    expect(view.photos.map((p) => p.id)).toEqual(["f-photo"]);
    expect(view.publishedAt).toBe("2026-10-01T06:00:00.000Z");
    const raw = JSON.stringify(view);
    for (const leak of ["clientPrice", "45000", "45 000", "payments", "payoutMode", "договор", "счёт", "77071234567", "Абая"]) expect(raw).not.toContain(leak);
  });

  test("навык сравнивается без учёта регистра и пробелов; без навыка, из другого города, другое направление — недоступен", async () => {
    const { ids, as } = await setup();
    expect((await as(ids.a.user).query(api.executorApp.order, { id: ids.skilled })).state).toBe("available");
    expect(await as(ids.b.user).query(api.executorApp.order, { id: ids.skilled })).toEqual({ state: "unavailable" });
    expect(await as(ids.c.user).query(api.executorApp.order, { id: ids.feed })).toEqual({ state: "unavailable" });
    expect(await as(ids.a.user).query(api.executorApp.order, { id: ids.plumbing })).toEqual({ state: "unavailable" });
  });

  test("заказ взял другой мастер — только «taken», без подробностей", async () => {
    const { ids, as } = await setup();
    expect(await as(ids.a.user).query(api.executorApp.order, { id: ids.takenByB })).toEqual({ state: "taken" });
    // Взятый заказ своего мастера по-прежнему открывается.
    expect((await as(ids.b.user).query(api.executorApp.order, { id: ids.takenByB })).state).toBe("mine");
  });

  test("неверная ссылка и id другой таблицы — «недоступен», а не ошибка", async () => {
    const { ids, as } = await setup();
    expect(await as(ids.a.user).query(api.executorApp.order, { id: "not-an-id" })).toEqual({ state: "unavailable" });
    expect(await as(ids.a.user).query(api.executorApp.order, { id: ids.client })).toEqual({ state: "unavailable" });
  });

  test("свой заказ: контакты после подтверждения, только свои сообщения, без файлов команды", async () => {
    const { ids, as } = await setup();
    const exec = as(ids.a.user);
    const before = await exec.query(api.executorApp.order, { id: ids.assignedToA });
    expect(before.state).toBe("mine");
    if (before.state !== "mine") return;
    expect(before.order.status).toBe("assigned");
    expect(before.order.address).toBeUndefined();
    expect(before.order.clientPhone).toBeUndefined();
    expect(before.photos.map((p) => p.id)).toEqual(["f-photo"]);
    expect(before.notes).toHaveLength(1);
    expect(before.notes[0]!.text).toBe("Буду через 15 минут");
    expect(before.notes[0]!.files[0]?.url).toBeTruthy();
    expect(JSON.stringify(before)).not.toContain("Маржа");

    await exec.mutation(api.worker.act, { id: ids.assignedToA, action: "accept" });
    const after = await exec.query(api.executorApp.order, { id: ids.assignedToA });
    if (after.state !== "mine") throw new Error("ожидали свой заказ");
    expect(after.order.status).toBe("accepted");
    expect(after.order.address).toBe("ул. Абая, 1, кв. 5");
    expect(after.order.clientPhone).toBe("77071234567");
    expect(JSON.stringify(after)).not.toContain("clientPrice");
  });

  test("взял заказ — экран сразу становится «своим»; второй мастер видит «taken»", async () => {
    const { ids, as } = await setup();
    await as(ids.a.user).mutation(api.worker.take, { id: ids.feed });
    expect((await as(ids.a.user).query(api.executorApp.order, { id: ids.feed })).state).toBe("mine");
    expect(await as(ids.b.user).query(api.executorApp.order, { id: ids.feed })).toEqual({ state: "taken" });
  });
});

describe("executorApp.feedExtras: данные карточек ленты", () => {
  test("только свободные подходящие заказы; превью — фото клиента, а не вложения команды", async () => {
    const { ids, as } = await setup();
    const extras = await as(ids.a.user).query(api.executorApp.feedExtras, {});
    const byId = new Map(extras.map((x) => [x.id, x]));
    expect([...byId.keys()].sort()).toEqual([ids.feed, ids.skilled].sort());
    expect(byId.get(ids.feed)).toMatchObject({ publishedAt: "2026-10-01T06:00:00.000Z", photos: 1 });
    expect(byId.get(ids.feed)!.thumbUrl).toBeTruthy();
    expect(byId.get(ids.skilled)).toMatchObject({ publishedAt: "2026-10-02T05:00:00.000Z", photos: 0 });
    expect(byId.get(ids.skilled)!.thumbUrl).toBeUndefined();

    const astana = await as(ids.c.user).query(api.executorApp.feedExtras, {});
    expect(astana.map((x) => x.id)).toEqual([ids.astana]);
  });

  test("заказ вернулся в ленту после отказа — «опубликован» заново", async () => {
    const { t, ids, as } = await setup();
    await as(ids.a.user).mutation(api.worker.take, { id: ids.feed });
    await as(ids.a.user).mutation(api.worker.act, { id: ids.feed, action: "decline" });
    const declinedAt = (await t.run((ctx) => ctx.db.query("history").collect())).filter((h) => h.orderId === ids.feed).at(-1)!.at;
    const extras = await as(ids.b.user).query(api.executorApp.feedExtras, {});
    expect(extras.find((x) => x.id === ids.feed)?.publishedAt).toBe(declinedAt);
  });
});

describe("executorApp.profile: профиль и показатели", () => {
  test("свои данные, подписи направлений, Telegram и отзывы без данных клиента", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "test_bot");
    const { t, ids, as } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.a.user, { telegramChatId: "555" });
      await ctx.db.insert("reviews", { tenantId: T, orderId: ids.assignedToA, executorId: ids.a.ex, clientId: ids.client, rating: 5, text: "Быстро и аккуратно", via: "link", at: "2026-10-05T05:00:00.000Z" });
      await ctx.db.insert("reviews", { tenantId: T, orderId: ids.takenByB, executorId: ids.b.ex, clientId: ids.client, rating: 2, text: "Чужой отзыв", via: "link", at: "2026-10-06T05:00:00.000Z" });
    });
    const p = await as(ids.a.user).query(api.executorApp.profile, {});
    expect(p.name).toBe("Асет Алматы");
    expect(p.city).toBe("Алматы");
    expect(p.categories).toEqual([
      { id: "ac", label: "Кондиционеры", tone: "blue" },
      { id: "appliances", label: "Бытовая техника", tone: "green" },
    ]);
    expect(p.skills).toEqual(["Чистка кондиционеров"]);
    expect(p).toMatchObject({ rating: 4.8, reviewsCount: 2, available: true, cooperation: "freelance", joinedAt: "2025-03-10T05:00:00.000Z" });
    expect(p.telegram).toEqual({ enabled: true, linked: true });
    expect(p.reviews).toHaveLength(1);
    expect(p.reviews[0]).toMatchObject({ rating: 5, text: "Быстро и аккуратно", service: "Ремонт кондиционера" });
    expect(JSON.stringify(p.reviews)).not.toContain("Клиент Тест");

    const b = await as(ids.b.user).query(api.executorApp.profile, {});
    expect(b.telegram).toEqual({ enabled: true, linked: false });
    expect(b.reviews.map((r) => r.text)).toEqual(["Чужой отзыв"]);
  });

  test("показатели месяца по Алматы: заработано, к выплате, ждёт оплаты клиента, отмены и просрочки", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T07:00:00.000Z")); // четверг, 12:00 по Алматы
    const { t, ids, as } = await setup();
    await t.run(async (ctx) => {
      // Старые заказы мастера из общего набора не мешают подсчёту.
      await ctx.db.delete(ids.assignedToA);
      const base = (await ctx.db.get(ids.feed))!;
      const { _id: _i, _creationTime: _c, ...copy } = base;
      void _i;
      void _c;
      const mine = (o: Partial<OrderDoc>) => ctx.db.insert("orders", { ...copy, executorId: ids.a.ex, assignedAt: "2026-09-01T05:00:00.000Z", files: [], ...o });
      // Процент от цены клиента: 50% от 40 000 = 20 000 мастеру.
      await mine({ status: "done", clientPrice: 40000, payoutMode: "percent", payoutValue: 50, doneAt: "2026-10-02T10:00:00.000Z" });
      await mine({ status: "paid", payoutValue: 15000, doneAt: "2026-10-10T10:00:00.000Z" });
      await mine({ status: "closed", payoutValue: 10000, payoutPaid: true, doneAt: "2026-10-14T10:00:00.000Z" });
      // 30 сентября 20:00 UTC — это уже 1 октября 01:00 по Алматы.
      await mine({ status: "awaiting_payment", payoutValue: 7000, doneAt: "2026-09-30T20:00:00.000Z" });
      // 30 сентября 18:00 UTC — 23:00 по Алматы, ещё сентябрь.
      await mine({ status: "closed", payoutValue: 5000, payoutPaid: true, doneAt: "2026-09-30T18:00:00.000Z" });
      await mine({ status: "cancelled", payoutValue: 9000, cancelReason: "Клиент передумал" });
      await mine({ status: "in_progress", payoutValue: 8000, deadline: "2026-10-15T06:00:00.000Z" });
      await mine({ status: "accepted", payoutValue: 8000, deadline: "2026-10-16T06:00:00.000Z" });
      // Чужой сданный заказ в этом месяце — не наш доход.
      await ctx.db.insert("orders", { ...copy, executorId: ids.b.ex, status: "paid", payoutValue: 99999, doneAt: "2026-10-05T10:00:00.000Z", files: [] });
    });
    const p = await as(ids.a.user).query(api.executorApp.profile, {});
    expect(p.stats).toEqual({
      month: "2026-10",
      monthEarned: 20000 + 15000 + 10000 + 7000,
      monthDone: 4,
      toPay: 15000,
      awaitingClient: 20000 + 7000,
      completed: 5,
      cancelled: 1,
      active: 2,
      overdue: 1,
    });
  });
});

describe("время по Алматы", () => {
  const now = "2026-10-12T04:00:00.000Z"; // понедельник, 09:00 по Алматы

  test("срок: сегодня, завтра, вчера, дата — по Алматы, а не по поясу устройства", () => {
    expect(dueLabel("2026-10-12T09:00:00.000Z", now)).toBe("Сегодня, до 14:00");
    expect(dueLabel("2026-10-12T19:30:00.000Z", now)).toBe("Завтра, до 00:30");
    expect(dueLabel("2026-10-11T13:00:00.000Z", now)).toBe("Вчера, до 18:00");
    expect(dueLabel("2026-10-15T07:00:00.000Z", now)).toBe("15 окт., до 12:00");
    expect(dueLabel("2025-12-31T07:00:00.000Z", now)).toBe("31 дек. 2025, до 12:00");
    expect(whenLabel("2026-10-12T00:05:00.000Z", now)).toBe("Сегодня, 05:05");
  });

  test("сколько осталось и насколько просрочен", () => {
    const at = Date.parse(now);
    expect(relLabel(at + 45 * 60_000, at)).toBe("через 45 мин");
    expect(relLabel(at + (2 * 60 + 15) * 60_000, at)).toBe("через 2 ч 15 мин");
    expect(relLabel(at + 2 * 3600_000, at)).toBe("через 2 ч");
    expect(relLabel(at + 3 * 86400_000, at)).toBe("через 3 дн.");
    expect(relLabel(at - 40 * 60_000, at)).toBe("просрочен на 40 мин");
    expect(relLabel(at - 40 * 60_000, at, "feed")).toBe("срок прошёл");
  });

  test("неделя с понедельника и месяц — по Алматы", () => {
    expect(new Date(weekStartAlmaty("2026-10-15T07:00:00.000Z")).toISOString()).toBe("2026-10-11T19:00:00.000Z");
    // Воскресенье 23:59 по Алматы — ещё прошлая неделя.
    expect(new Date(weekStartAlmaty("2026-10-11T18:59:00.000Z")).toISOString()).toBe("2026-10-04T19:00:00.000Z");
    expect(monthKeyAlmaty("2026-09-30T19:00:00.000Z")).toBe("2026-10");
    expect(monthKeyAlmaty("2026-09-30T18:59:59.000Z")).toBe("2026-09");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });
});

describe("деньги мастера: формулы", () => {
  const o = (x: Partial<EarningOrder>): EarningOrder => ({ status: "done", payout: 1000, payoutPaid: false, deadline: "2026-10-20T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", ...x });
  const orders = [
    o({ payout: 10000, doneAt: "2026-10-13T05:00:00.000Z" }), // текущая неделя
    o({ status: "paid", payout: 20000, doneAt: "2026-10-05T05:00:00.000Z" }), // прошлая неделя
    o({ status: "closed", payout: 5000, payoutPaid: true, doneAt: "2026-09-29T05:00:00.000Z" }), // позапрошлая, сентябрь
    o({ status: "cancelled", payout: 7000, assignedAt: "2026-10-12T05:00:00.000Z" }),
    o({ status: "in_progress", payout: 3000 }),
  ];

  test("месяц, остатки и недели", () => {
    expect(monthIncome(orders, "2026-10")).toEqual({ month: "2026-10", earned: 30000, count: 2 });
    expect(monthIncome(orders, "2026-09")).toEqual({ month: "2026-09", earned: 5000, count: 1 });
    expect(payoutBalance(orders)).toEqual({ toPay: 20000, toPayCount: 1, awaitingClient: 10000, awaitingClientCount: 1 });
    const weeks = weeklyIncome(orders, "2026-10-15T07:00:00.000Z", 3);
    expect(weeks.map((w) => [new Date(w.start).toISOString(), w.total])).toEqual([
      ["2026-09-27T19:00:00.000Z", 5000],
      ["2026-10-04T19:00:00.000Z", 20000],
      ["2026-10-11T19:00:00.000Z", 10000],
    ]);
  });

  test("группы «Завершённых»: новые сверху, сумма без отмен", () => {
    const groups = groupByMonth(orders.filter((x) => x.status !== "in_progress"));
    expect(groups.map((g) => [g.month, g.total, g.orders.length])).toEqual([
      ["2026-10", 30000, 3],
      ["2026-09", 5000, 1],
    ]);
    expect(executorStats(orders, "2026-10-15T07:00:00.000Z")).toMatchObject({ completed: 3, cancelled: 1, active: 1, overdue: 0 });
  });

  test("подбор по профилю: город и навыки без учёта регистра", () => {
    const ex = { city: "Алматы", categories: ["ac"], skills: ["Заправка  фреоном", "Чистка кондиционеров"] };
    expect(fitsProfile(ex, { city: "алматы ", category: "ac", requiredSkills: ["заправка фреоном"] })).toBe(true);
    expect(fitsProfile(ex, { city: "Алматы", category: "plumbing" })).toBe(false);
    expect(missingSkills(ex, ["Монтаж сплит‑систем", "чистка кондиционеров"])).toEqual(["Монтаж сплит‑систем"]);
  });
});

describe("«Мои заказы» — без чтения всей истории мастера", () => {
  test("активные — все, завершённые — последние 100 по статусу", async () => {
    const { t, ids, as } = await setup();
    const before = (await as(ids.a.user).query(api.worker.mine, {})).orders.length;
    await t.run(async (ctx) => {
      const tpl = (await ctx.db.get(ids.assignedToA))!;
      const { _id, _creationTime, ...base } = tpl;
      for (let i = 0; i < 130; i++) await ctx.db.insert("orders", { ...base, number: 5000 + i, status: "paid", doneAt: new Date(Date.UTC(2026, 8, 1) + i * 3600_000).toISOString() });
    });
    const mine = (await as(ids.a.user).query(api.worker.mine, {})).orders;
    expect(mine.length).toBe(before + 100);
    // Из сданных пришли самые свежие.
    const paid = mine.filter((o) => o.number >= 5000).map((o) => o.number);
    expect(Math.min(...paid)).toBe(5030);
  });
});
