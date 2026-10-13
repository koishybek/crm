/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { bayesianRating } from "../src/data/reviews";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const at = new Date().toISOString();
const DAY = 86400_000;
const CLIENT = { name: "Айгерим Сапарова", phone: "77071234567", address: "ул. Абая, 15, кв. 7" };

beforeEach(() => {
  vi.stubEnv("APP_URL", "https://app.test/");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const acManager = await ctx.db.insert("users", { name: "Руководитель Кондиционеров", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const plumbingManager = await ctx.db.insert("users", { name: "Руководитель Сантехники", email: "pl@test.kz", role: "manager", categories: ["plumbing"], tenantId: T, active: true });
    // Рейтинг из прошлой жизни (демо-данные): без отзывов его не трогаем.
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Новиков", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 4.9, reviews: 132, cooperation: "freelance", joinedAt: at });
    const exUser = await ctx.db.insert("users", { name: "Асет Новиков", email: "77000000001", phone: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const other = await ctx.db.insert("executors", { tenantId: T, name: "Берик Другой", phone: "77000000002", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const client = await ctx.db.insert("clients", { tenantId: T, name: CLIENT.name, kind: "person", phone: CLIENT.phone, city: "Алматы", address: CLIENT.address, source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 0, lastActivityAt: at });
    return { owner, operator, acManager, plumbingManager, ex, exUser, other, client };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });
  let number = 1000;
  const mkOrder = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: ++number,
        clientId: ids.client,
        clientName: CLIENT.name,
        clientPhone: CLIENT.phone,
        source: "olx",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит кондиционер",
        city: "Алматы",
        address: CLIENT.address,
        deadline: new Date(Date.now() + DAY).toISOString(),
        priority: "normal",
        status: "done",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        executorId: ids.ex,
        createdAt: at,
        createdBy: ids.owner,
        doneAt: new Date(Date.now() - 3600_000).toISOString(),
        files: [],
        ...over,
      }),
    );
  const executor = (id: Id<"executors"> = ids.ex) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const reviews = () => t.run((ctx) => ctx.db.query("reviews").collect());
  const auditRows = (action: string) => t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((r) => r.action === action));
  const notes = (userId: Id<"users">) => t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect());
  /** Токен из ссылки «…/otzyv/<токен>». */
  const linkFor = async (orderId: Id<"orders">) => {
    const { url } = await as(ids.operator).mutation(api.reviews.requestLink, { orderId });
    return { url, token: url.split("/otzyv/")[1]! };
  };
  return { t, ids, as, mkOrder, executor, reviews, auditRows, notes, linkFor };
}

describe("оценка по ссылке", () => {
  test("действующая ссылка → отзыв «по ссылке», рейтинг мастера пересчитан, ссылка погашена, журнал от «Сайт»", async () => {
    const { t, ids, mkOrder, executor, reviews, auditRows, linkFor } = await setup();
    const order = await mkOrder();
    const { url, token } = await linkFor(order);
    expect(url).toMatch(/^https:\/\/app\.test\/otzyv\/[A-Za-z0-9_-]{32}$/);

    const info = await t.query(api.reviews.byToken, { token });
    expect(info.state).toBe("ok");
    expect(info.order).toMatchObject({ number: 1001, service: "Ремонт кондиционера", executor: "Асет" });

    expect(await t.mutation(api.reviews.submitByToken, { token, rating: 5, text: "  Мастер пришёл вовремя, всё починил  " })).toEqual({ ok: true });
    const [r] = await reviews();
    expect(r).toMatchObject({ orderId: order, executorId: ids.ex, clientId: ids.client, rating: 5, via: "link", text: "Мастер пришёл вовремя, всё починил" });
    expect(r!.authorId).toBeUndefined();
    // Демо-рейтинг 4.9 (132) сменился настоящим: (4.5·5 + 5) / 6 = 4.58 → 4.6, отзывов — 1.
    expect(await executor()).toMatchObject({ rating: 4.6, reviews: 1 });
    expect((await t.run((ctx) => ctx.db.query("reviewRequests").collect()))[0]!.usedAt).toBeDefined();

    const [row] = await auditRows("review.created");
    expect(row).toMatchObject({ actorName: "Сайт", entity: "review", entityId: order });
    expect(row!.actorId).toBeUndefined();
    expect(row!.summary).toContain("5★ по ссылке");
    // Текст клиента и токен в журнал не попадают.
    expect(JSON.stringify(row)).not.toContain("вовремя");
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("audit").collect()))).not.toContain(token);
    const history = await t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", order)).collect());
    expect(history.map((h) => h.text)).toContain("Оценка клиента: 5★ (по ссылке)");
    expect(history.at(-1)!.actor).toEqual({ type: "client", id: ids.client });
  });

  test("повторная отправка по той же ссылке — отказ, второго отзыва нет; новую ссылку не выдаём", async () => {
    const { t, as, ids, mkOrder, reviews, linkFor } = await setup();
    const order = await mkOrder();
    const { token } = await linkFor(order);
    await t.mutation(api.reviews.submitByToken, { token, rating: 4 });
    expect(await t.mutation(api.reviews.submitByToken, { token, rating: 1 })).toMatchObject({ ok: false, state: "used" });
    expect((await t.query(api.reviews.byToken, { token })).state).toBe("used");
    expect(await reviews()).toHaveLength(1);
    expect((await reviews())[0]!.rating).toBe(4);
    await expect(as(ids.operator).mutation(api.reviews.requestLink, { orderId: order })).rejects.toThrow("уже оценил");
  });

  test("просроченная ссылка — отказ, отзыв не создаётся", async () => {
    const { t, mkOrder, reviews, executor } = await setup();
    const order = await mkOrder();
    const token = "A".repeat(31) + "b";
    await t.run((ctx) => ctx.db.insert("reviewRequests", { token, orderId: order, createdAt: new Date(Date.now() - 15 * DAY).toISOString(), expiresAt: new Date(Date.now() - DAY).toISOString() }));
    expect((await t.query(api.reviews.byToken, { token })).state).toBe("expired");
    expect(await t.mutation(api.reviews.submitByToken, { token, rating: 5 })).toMatchObject({ ok: false, state: "expired" });
    expect(await reviews()).toHaveLength(0);
    expect(await executor()).toMatchObject({ rating: 4.9, reviews: 132 });
  });

  test("неизвестный или кривой токен — «invalid» без каких-либо данных и без записей в базе", async () => {
    const { t } = await setup();
    for (const token of ["Z".repeat(32), "../../etc/passwd", "", "x".repeat(5000)]) {
      expect(await t.query(api.reviews.byToken, { token })).toEqual({ state: "invalid" });
      expect(await t.mutation(api.reviews.submitByToken, { token, rating: 5 })).toMatchObject({ ok: false, state: "invalid" });
    }
    // Перебор несуществующих ссылок не раздувает таблицу лимитов.
    expect(await t.run((ctx) => ctx.db.query("rateLimits").collect())).toHaveLength(0);
  });

  test("публичная страница не выдаёт личных данных: только номер, услуга, имя мастера, дата", async () => {
    const { t, mkOrder, linkFor } = await setup();
    const { token } = await linkFor(await mkOrder());
    const info = await t.query(api.reviews.byToken, { token });
    expect(Object.keys(info.order!).sort()).toEqual(["doneAt", "executor", "number", "service"]);
    const json = JSON.stringify(info);
    for (const secret of [CLIENT.name, "Айгерим", CLIENT.phone, CLIENT.address, "Новиков", "30000", "21000", "Не холодит"]) expect(json).not.toContain(secret);
  });

  test("лимит попыток по одной ссылке: после 10 неудачных — «попробуйте через час»", async () => {
    const { t, mkOrder, reviews, linkFor } = await setup();
    const { token } = await linkFor(await mkOrder());
    for (let i = 0; i < 10; i++) expect(await t.mutation(api.reviews.submitByToken, { token, rating: 0 })).toMatchObject({ ok: false, state: "input" });
    expect(await t.mutation(api.reviews.submitByToken, { token, rating: 5 })).toMatchObject({ ok: false, state: "limited" });
    expect(await reviews()).toHaveLength(0);
  });

  test("ссылка: повторный запрос — та же ссылка и одна запись в журнале; только сотрудник и только выполненный заказ", async () => {
    const { t, as, ids, mkOrder, auditRows } = await setup();
    const order = await mkOrder();
    const first = await as(ids.operator).mutation(api.reviews.requestLink, { orderId: order });
    const again = await as(ids.owner).mutation(api.reviews.requestLink, { orderId: order });
    expect(again.url).toBe(first.url);
    expect(Date.parse(first.expiresAt) - Date.now()).toBeGreaterThan(13.9 * DAY);
    expect(await t.run((ctx) => ctx.db.query("reviewRequests").collect())).toHaveLength(1);
    const rows = await auditRows("review.requested");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: ids.operator, entityId: order });

    await expect(as(ids.acManager).mutation(api.reviews.requestLink, { orderId: order })).rejects.toThrow("Нет доступа");
    await expect(as(ids.exUser).mutation(api.reviews.requestLink, { orderId: order })).rejects.toThrow("Нет доступа");
    const inWork = await mkOrder({ status: "in_progress", doneAt: undefined });
    await expect(as(ids.operator).mutation(api.reviews.requestLink, { orderId: inWork })).rejects.toThrow("после выполнения");
    // Срок прошлой ссылки вышел — выдаём новую.
    await t.run(async (ctx) => {
      const req = (await ctx.db.query("reviewRequests").collect())[0]!;
      await ctx.db.patch(req._id, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    });
    expect((await as(ids.operator).mutation(api.reviews.requestLink, { orderId: order })).url).not.toBe(first.url);
  });

  test("ссылка без APP_URL — относительная", async () => {
    const { as, ids, mkOrder } = await setup();
    vi.stubEnv("APP_URL", "");
    const { url } = await as(ids.operator).mutation(api.reviews.requestLink, { orderId: await mkOrder() });
    expect(url).toMatch(/^\/otzyv\/[A-Za-z0-9_-]{32}$/);
  });
});

describe("оценка со слов клиента и из каналов", () => {
  test("сотрудник записывает оценку и исправляет её в течение 7 дней; позже — нельзя", async () => {
    const { t, as, ids, mkOrder, executor, reviews, auditRows } = await setup();
    const order = await mkOrder();
    expect(await as(ids.operator).mutation(api.reviews.addByOperator, { orderId: order, rating: 4, text: "Сказала по телефону: всё хорошо" })).toEqual({ updated: false });
    expect((await reviews())[0]).toMatchObject({ via: "operator", rating: 4, authorId: ids.operator });
    expect(await executor()).toMatchObject({ rating: 4.4, reviews: 1 }); // (22.5 + 4) / 6 = 4.42

    expect(await as(ids.owner).mutation(api.reviews.addByOperator, { orderId: order, rating: 5, text: "Сказала по телефону: всё хорошо" })).toEqual({ updated: true });
    expect(await reviews()).toHaveLength(1);
    expect(await executor()).toMatchObject({ rating: 4.6, reviews: 1 });
    const [upd] = await auditRows("review.updated");
    expect(upd).toMatchObject({ actorId: ids.owner, entityId: order });
    expect(upd!.summary).toContain("4★ → 5★");

    await t.run(async (ctx) => {
      const r = (await ctx.db.query("reviews").collect())[0]!;
      await ctx.db.patch(r._id, { at: new Date(Date.now() - 8 * DAY).toISOString() });
    });
    await expect(as(ids.operator).mutation(api.reviews.addByOperator, { orderId: order, rating: 3 })).rejects.toThrow("в течение 7 дней");
    expect((await reviews())[0]!.rating).toBe(5);
  });

  test("один отзыв на заказ: оценку клиента сотрудник не меняет, канал не добавляет вторую", async () => {
    const { t, as, ids, mkOrder, reviews, linkFor } = await setup();
    const order = await mkOrder();
    const { token } = await linkFor(order);
    await t.mutation(api.reviews.submitByToken, { token, rating: 5 });
    await expect(as(ids.operator).mutation(api.reviews.addByOperator, { orderId: order, rating: 1 })).rejects.toThrow("клиент оставил сам");
    expect(await t.mutation(internal.reviews._submit, { orderId: order, rating: 2, via: "whatsapp" })).toMatchObject({ ok: false });
    expect(await reviews()).toHaveLength(1);
  });

  test("проверки: оценка 1–5 целым числом, комментарий до 1000 символов, только выполненный заказ с мастером, только сотрудник", async () => {
    const { as, ids, mkOrder, reviews } = await setup();
    const order = await mkOrder();
    const op = as(ids.operator);
    for (const rating of [0, 6, 4.5, Number.NaN]) await expect(op.mutation(api.reviews.addByOperator, { orderId: order, rating })).rejects.toThrow("от 1 до 5");
    await expect(op.mutation(api.reviews.addByOperator, { orderId: order, rating: 5, text: "а".repeat(1001) })).rejects.toThrow("1000");
    await expect(op.mutation(api.reviews.addByOperator, { orderId: await mkOrder({ status: "cancelled" }), rating: 5 })).rejects.toThrow("после выполнения");
    await expect(op.mutation(api.reviews.addByOperator, { orderId: await mkOrder({ executorId: undefined }), rating: 5 })).rejects.toThrow("после выполнения");
    await expect(as(ids.acManager).mutation(api.reviews.addByOperator, { orderId: order, rating: 5 })).rejects.toThrow("Нет доступа");
    await expect(as(ids.exUser).mutation(api.reviews.addByOperator, { orderId: order, rating: 5 })).rejects.toThrow("Нет доступа");
    expect(await reviews()).toHaveLength(0);
  });

  test("канал (Telegram, WhatsApp): та же проверка, автор журнала — канал, один отзыв на заказ", async () => {
    const { t, mkOrder, reviews, auditRows, executor } = await setup();
    const order = await mkOrder();
    expect(await t.mutation(internal.reviews._submit, { orderId: order, rating: 7, via: "telegram" })).toMatchObject({ ok: false });
    expect(await t.mutation(internal.reviews._submit, { orderId: await mkOrder({ status: "in_progress" }), rating: 5, via: "telegram" })).toMatchObject({ ok: false });
    expect(await t.mutation(internal.reviews._submit, { orderId: order, rating: 5, text: "Спасибо!", via: "telegram" })).toEqual({ ok: true });
    expect(await t.mutation(internal.reviews._submit, { orderId: order, rating: 4, via: "whatsapp" })).toMatchObject({ ok: false });
    expect((await reviews()).map((r) => r.via)).toEqual(["telegram"]);
    expect((await auditRows("review.created"))[0]).toMatchObject({ actorName: "Telegram" });
    expect(await executor()).toMatchObject({ rating: 4.6, reviews: 1 });
  });
});

describe("рейтинг и низкие оценки", () => {
  test("байесовское среднее: (4,5·5 + Σ) / (5 + n), один знак после запятой", () => {
    expect(bayesianRating([])).toBe(4.5);
    expect(bayesianRating([5])).toBe(4.6); // 4.583
    expect(bayesianRating([1])).toBe(3.9); // 3.917 — одна плохая оценка не роняет до единицы
    expect(bayesianRating([5, 4])).toBe(4.5);
    expect(bayesianRating([2, 2])).toBe(3.8); // 3.786
    expect(bayesianRating(Array(20).fill(5))).toBe(4.9); // 4.9 — много отзывов: рейтинг близок к реальному
    expect(bayesianRating(Array(15).fill(3))).toBe(3.4); // 3.375 — со временем рейтинг уходит к реальному среднему
  });

  test("рейтинг считается по всем отзывам мастера, другие мастера не меняются", async () => {
    const { t, ids, mkOrder, executor, linkFor } = await setup();
    for (const rating of [5, 4, 2]) {
      const { token } = await linkFor(await mkOrder());
      await t.mutation(api.reviews.submitByToken, { token, rating });
    }
    // (22.5 + 11) / 8 = 4.19
    expect(await executor()).toMatchObject({ rating: 4.2, reviews: 3 });
    expect(await executor(ids.other)).toMatchObject({ rating: 5, reviews: 0 });
  });

  test("оценка ≤ 3 — уведомление владельцу и руководителю направления (tone bad), но не оператору и не чужому руководителю", async () => {
    const { t, ids, mkOrder, notes, auditRows, linkFor } = await setup();
    const order = await mkOrder();
    const { token } = await linkFor(order);
    await t.mutation(api.reviews.submitByToken, { token, rating: 2, text: "Опоздал на два часа" });
    for (const user of [ids.owner, ids.acManager]) {
      const [n] = await notes(user);
      expect(n).toMatchObject({ tone: "bad", link: `/orders/${order}` });
      expect(n!.text).toContain("Низкая оценка 2★ по заказу №1001");
    }
    expect(await notes(ids.operator)).toHaveLength(0);
    expect(await notes(ids.plumbingManager)).toHaveLength(0);
    expect((await auditRows("review.created"))[0]!.meta).toMatchObject({ low: true, notified: 2, rating: 2 });

    // Хорошая оценка — без уведомлений.
    const { token: good } = await linkFor(await mkOrder());
    await t.mutation(api.reviews.submitByToken, { token: good, rating: 4 });
    expect(await notes(ids.owner)).toHaveLength(1);
  });

  test("исправление на низкую оценку уведомляет; автор правки себе уведомление не получает", async () => {
    const { as, ids, mkOrder, notes } = await setup();
    const order = await mkOrder();
    await as(ids.owner).mutation(api.reviews.addByOperator, { orderId: order, rating: 5 });
    await as(ids.owner).mutation(api.reviews.addByOperator, { orderId: order, rating: 3 });
    expect(await notes(ids.owner)).toHaveLength(0);
    expect((await notes(ids.acManager))[0]!.text).toContain("Низкая оценка 3★");
  });
});

describe("карточки заказа и мастера", () => {
  test("заказ: отзыв, срок исправления и срок ссылки; токена в ответе нет; чужое направление — null", async () => {
    const { as, ids, mkOrder, linkFor } = await setup();
    const order = await mkOrder();
    const before = await as(ids.operator).query(api.reviews.forOrder, { orderId: order });
    expect(before).toMatchObject({ review: null, reviewable: true });
    expect(before!.linkExpiresAt).toBeUndefined();
    const { token } = await linkFor(order);
    const withLink = await as(ids.acManager).query(api.reviews.forOrder, { orderId: order });
    expect(withLink!.linkExpiresAt).toBeDefined();
    expect(JSON.stringify(withLink)).not.toContain(token);
    expect(await as(ids.plumbingManager).query(api.reviews.forOrder, { orderId: order })).toBeNull();

    await as(ids.operator).mutation(api.reviews.addByOperator, { orderId: order, rating: 5 });
    const after = await as(ids.operator).query(api.reviews.forOrder, { orderId: order });
    expect(after!.review).toMatchObject({ rating: 5, via: "operator", authorId: ids.operator, orderNumber: 1001 });
    expect(Date.parse(after!.editableUntil!) - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect(await as(ids.operator).query(api.reviews.forOrder, { orderId: await mkOrder({ status: "assigned", doneAt: undefined }) })).toMatchObject({ review: null, reviewable: false });
  });

  test("мастер: последние отзывы с номерами заказов и распределение по звёздам; руководителю чужого направления — null", async () => {
    const { t, as, ids, mkOrder, linkFor } = await setup();
    for (const rating of [5, 5, 3]) {
      const { token } = await linkFor(await mkOrder());
      await t.mutation(api.reviews.submitByToken, { token, rating });
    }
    const info = await as(ids.acManager).query(api.reviews.forExecutor, { executorId: ids.ex });
    expect(info).toMatchObject({ total: 3, byStars: [0, 0, 1, 0, 2] });
    expect(info!.latest.map((r) => r.orderNumber).sort()).toEqual([1001, 1002, 1003]);
    expect(await as(ids.plumbingManager).query(api.reviews.forExecutor, { executorId: ids.ex })).toBeNull();
    await expect(as(ids.exUser).query(api.reviews.forExecutor, { executorId: ids.ex })).rejects.toThrow("Нет доступа");
  });
});
