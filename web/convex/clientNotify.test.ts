/// <reference types="vite/client" />
// Сообщения клиенту о заказе (ТЗ п.18): выбор канала, окно WhatsApp, настройка владельца, события заказа по одному
// разу, оценка звёздами в Telegram.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { toClient } from "./clientNotify";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const HOUR = 3600_000;
const WA_SEND = "https://graph.facebook.com/v26.0/987654321098765/messages";
type Sent = { channel: "telegram" | "whatsapp"; method: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let seq = 0;

beforeEach(() => {
  sent = [];
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("WHATSAPP_TOKEN", "EAAtest");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "987654321098765");
  vi.stubEnv("APP_URL", "https://app.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (String(url) === WA_SEND) {
        sent.push({ channel: "whatsapp", method: "messages", body });
        return Response.json({ messaging_product: "whatsapp", messages: [{ id: `wamid.OUT${++seq}` }] });
      }
      if (String(url).startsWith("https://api.telegram.org/")) {
        const method = String(url).split("/").pop()!;
        sent.push({ channel: "telegram", method, body });
        return Response.json({ ok: true, result: method === "sendMessage" ? { message_id: ++seq } : true });
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
  const at = new Date(now).toISOString();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const exUser = await ctx.db.insert("users", { name: "Асет Мастеров", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгерим", kind: "person", phone: "77071234567", city: "Алматы", source: "telegram", tags: [], createdAt: at, ordersCount: 1, activeCount: 1, lastActivityAt: at });
    const stranger = await ctx.db.insert("clients", { tenantId: T, name: "Чужой", kind: "person", phone: "77079990000", city: "Алматы", source: "telegram", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    return { owner, operator, ex, exUser, client, stranger };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const flush = () => t.finishAllScheduledFunctions(() => {});
  /** Диалог клиента в канале: lastMessageAt — сколько часов назад писали; для WhatsApp окно — 24 часа от этого. */
  const conversation = (channel: Doc<"conversations">["channel"], externalId: string, hoursAgo: number, clientId: Id<"clients"> = ids.client) =>
    t.run((ctx) =>
      ctx.db.insert("conversations", {
        tenantId: T,
        channel,
        externalId,
        clientId,
        lastMessageAt: new Date(now - hoursAgo * HOUR).toISOString(),
        lastText: "…",
        lastDirection: "in",
        unread: 0,
        status: "open",
        replyUntil: channel === "whatsapp" ? new Date(now - hoursAgo * HOUR + 24 * HOUR).toISOString() : undefined,
      }),
    );
  let number = 1000;
  const order = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: ++number,
        clientId: ids.client,
        clientName: "Айгерим",
        clientPhone: "77071234567",
        source: "telegram",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: new Date(now + 24 * HOUR).toISOString(),
        priority: "normal",
        status: "awaiting_executor",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        createdAt: at,
        createdBy: ids.owner,
        files: [],
        ...over,
      }),
    );
  const notices = (conversationId: Id<"conversations">) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query("conversationMessages")
          .withIndex("by_conversation", (q) => q.eq("conversationId", conversationId))
          .collect()
      ).filter((m) => m.direction === "out"),
    );
  const toChat = (chatId: string) => sent.filter((s) => s.method === "sendMessage" && s.body.chat_id === chatId);
  return { t, ids, as, flush, conversation, order, notices, toChat };
}

describe("канал клиента", () => {
  test("последний диалог, куда можно написать: WhatsApp — только в окне 24 часа, форма сайта — никогда", async () => {
    const s = await setup();
    const tgConv = await s.conversation("telegram", "777", 5);
    const waConv = await s.conversation("whatsapp", "77071234567", 1);
    const r1 = await s.t.run((ctx) => toClient(ctx, s.ids.client, "Проверка"));
    expect(r1).toMatchObject({ queued: true, channel: "whatsapp", conversationId: waConv });
    await s.flush();
    expect(sent.filter((x) => x.channel === "whatsapp")).toHaveLength(1);
    expect((await s.notices(waConv))[0]).toMatchObject({ kind: "system", status: "sent", text: "Проверка" });

    // Окно WhatsApp закрылось — пишем в Telegram, хотя там писали раньше.
    await s.t.run((ctx) => ctx.db.patch(waConv, { replyUntil: new Date(Date.now() - 1000).toISOString() }));
    expect(await s.t.run((ctx) => toClient(ctx, s.ids.client, "Ещё раз"))).toMatchObject({ queued: true, channel: "telegram", conversationId: tgConv });
    await s.flush();
    expect(s.toChat("777").map((m) => m.body.text)).toEqual(["Ещё раз"]);

    // Только форма сайта — написать некуда.
    const site = await s.t.run((ctx) => ctx.db.insert("clients", { tenantId: T, name: "С сайта", kind: "person", phone: "77015550000", city: "Алматы", source: "site", tags: [], createdAt: new Date().toISOString(), ordersCount: 0, activeCount: 0, lastActivityAt: new Date().toISOString() }));
    await s.conversation("site", "77015550000", 1, site);
    expect(await s.t.run((ctx) => toClient(ctx, site, "Тест"))).toEqual({ queued: false, reason: "no_channel" });
  });

  test("владелец выключил «Уведомлять клиентов» — не пишем; включать и выключать может только владелец", async () => {
    const s = await setup();
    await s.conversation("telegram", "777", 1);
    expect(await s.as(s.ids.owner).query(api.clientNotify.settings, {})).toEqual({ enabled: true, channels: { telegram: true, whatsapp: true, olx: false } });
    await expect(s.as(s.ids.operator).mutation(api.clientNotify.setEnabled, { enabled: false })).rejects.toThrow("Нет доступа");
    await s.as(s.ids.owner).mutation(api.clientNotify.setEnabled, { enabled: false });
    expect(await s.t.run((ctx) => toClient(ctx, s.ids.client, "Тест"))).toEqual({ queued: false, reason: "off" });
    await s.as(s.ids.owner).mutation(api.clientNotify.setEnabled, { enabled: true });
    expect(await s.t.run((ctx) => toClient(ctx, s.ids.client, "Тест"))).toMatchObject({ queued: true, channel: "telegram" });
    await s.flush();
    expect(s.toChat("777")).toHaveLength(1);
    const rows = (await s.t.run((ctx) => ctx.db.query("audit").collect())).filter((r) => r.action === "settings.clientNotify");
    expect(rows.map((r) => r.meta)).toEqual([{ enabled: false }, { enabled: true }]);
  });
});

describe("события заказа", () => {
  test("мастер взял заказ → «мастер приедет»; выполнено → спасибо, ссылка и звёзды; каждое событие — один раз", async () => {
    const s = await setup();
    const conv = await s.conversation("telegram", "777", 2);
    const id = await s.order();
    const master = s.as(s.ids.exUser);
    await master.mutation(api.worker.take, { id });
    await s.flush();
    let msgs = s.toChat("777");
    expect(msgs).toHaveLength(1);
    const first = String(msgs[0]!.body.text);
    expect(first).toMatch(/^Заказ №1001: мастер Асет приедет завтра до \d\d:\d\d\./);
    // Только имя мастера и время: без фамилии, телефона мастера и денег.
    expect(first).not.toMatch(/Мастеров|77000000001|000/);

    // Отказался и взял снова — тот же мастер, второе сообщение не нужно.
    await master.mutation(api.worker.act, { id, action: "decline" });
    await master.mutation(api.worker.take, { id });
    await master.mutation(api.worker.act, { id, action: "start" });
    await master.mutation(api.worker.act, { id, action: "done" });
    await s.flush();
    msgs = s.toChat("777");
    expect(msgs).toHaveLength(2);
    const done = msgs[1]!;
    expect(String(done.body.text)).toMatch(/^Заказ №1001 выполнен — спасибо, что выбрали Home Max Service!/);
    expect(String(done.body.text)).toMatch(/https:\/\/app\.test\/otzyv\/[A-Za-z0-9_-]{32}/);
    expect(done.body.reply_markup).toEqual({ inline_keyboard: [[1, 2, 3, 4, 5].map((n) => ({ text: `⭐${n}`, callback_data: `rv:${id}:${n}` }))] });

    // Сотрудник вернул в работу и снова закрыл — «выполнено» второй раз не уходит.
    const owner = s.as(s.ids.owner);
    await owner.mutation(api.orders.changeStatus, { id, to: "in_progress" });
    await owner.mutation(api.orders.changeStatus, { id, to: "done" });
    await s.flush();
    expect(s.toChat("777")).toHaveLength(2);
    expect((await s.notices(conv)).map((m) => m.status)).toEqual(["sent", "sent"]);

    // След — в истории заказа и в журнале; ссылку для оценки создала система.
    const history = await s.t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", id)).collect());
    expect(history.filter((h) => h.text.startsWith("Клиенту отправлено в Telegram")).map((h) => h.text)).toEqual([
      "Клиенту отправлено в Telegram: мастер и время приезда",
      "Клиенту отправлено в Telegram: работа выполнена, просьба оценить",
    ]);
    const audit = await s.t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.filter((r) => r.action === "order.clientNotice").map((r) => r.actorName)).toEqual(["Система", "Система"]);
    expect(audit.filter((r) => r.action === "review.requested").map((r) => r.actorName)).toEqual(["Система"]);
  });

  test("новый мастер на заказе — клиенту новое сообщение с его именем", async () => {
    const s = await setup();
    await s.conversation("telegram", "777", 2);
    const id = await s.order();
    await s.as(s.ids.exUser).mutation(api.worker.take, { id });
    await s.as(s.ids.exUser).mutation(api.worker.act, { id, action: "decline" });
    const other = await s.t.run(async (ctx) => {
      const ex = await ctx.db.insert("executors", { tenantId: T, name: "Берик Второй", phone: "77000000002", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: new Date().toISOString() });
      return ctx.db.insert("users", { name: "Берик Второй", email: "77000000002", role: "executor", executorId: ex, tenantId: T, active: true });
    });
    await s.as(other).mutation(api.worker.take, { id });
    await s.flush();
    expect(s.toChat("777").map((m) => String(m.body.text).match(/мастер (\S+)/)?.[1])).toEqual(["Асет", "Берик"]);
  });

  test("сотрудник отменил заказ — сообщение один раз, без причины отмены", async () => {
    const s = await setup();
    await s.conversation("telegram", "777", 2);
    const id = await s.order({ status: "new" });
    const owner = s.as(s.ids.owner);
    await owner.mutation(api.orders.changeStatus, { id, to: "cancelled", reason: "Клиент нашёл дешевле" });
    await owner.mutation(api.orders.changeStatus, { id, to: "new" });
    await owner.mutation(api.orders.changeStatus, { id, to: "cancelled", reason: "Снова отмена" });
    await s.flush();
    const msgs = s.toChat("777");
    expect(msgs.map((m) => m.body.text)).toEqual(["Заказ №1001 отменён. Если это ошибка или понадобится помощь — напишите нам сюда."]);
  });

  test("WhatsApp: ссылка на оценку без кнопок; окно закрыто — не пишем и событие не тратим", async () => {
    const s = await setup();
    const wa = await s.conversation("whatsapp", "77071234567", 30); // окно закрылось 6 часов назад
    const id = await s.order({ status: "in_progress", executorId: s.ids.ex, assignedAt: new Date().toISOString() });
    await s.as(s.ids.exUser).mutation(api.worker.act, { id, action: "done" });
    await s.flush();
    expect(sent).toHaveLength(0);
    expect(await s.notices(wa)).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("reviewRequests").collect())).toHaveLength(0); // ссылку не создаём впустую

    // Клиент написал — окно открылось; заказ вернули в работу и снова сдали — теперь сообщение уходит.
    await s.t.run((ctx) => ctx.db.patch(wa, { replyUntil: new Date(Date.now() + 20 * HOUR).toISOString() }));
    await s.as(s.ids.owner).mutation(api.orders.changeStatus, { id, to: "in_progress" });
    await s.as(s.ids.owner).mutation(api.orders.changeStatus, { id, to: "done" });
    await s.flush();
    const wa1 = sent.filter((x) => x.channel === "whatsapp");
    expect(wa1).toHaveLength(1);
    const text = (wa1[0]!.body.text as { body: string }).body;
    expect(text).toMatch(/Оцените, пожалуйста, работу мастера: https:\/\/app\.test\/otzyv\//);
    expect(wa1[0]!.body.type).toBe("text"); // только текст: кнопок WhatsApp здесь нет
  });
});

describe("оценка звёздами в Telegram", () => {
  const cb = (chatId: number, data: string) => ({ update: { callback_query: { id: `cb${chatId}`, data, from: { id: chatId }, message: { message_id: 42, chat: { id: chatId } } } } });

  test("из чата клиента — отзыв один раз, спасибо и звёзды убраны; чужой чат — отказ", async () => {
    const s = await setup();
    const conv = await s.conversation("telegram", "777", 1);
    await s.conversation("telegram", "999", 1, s.ids.stranger);
    const id = await s.order({ status: "done", executorId: s.ids.ex, doneAt: new Date().toISOString() });
    const reviews = () => s.t.run((ctx) => ctx.db.query("reviews").collect());
    const answers = () => sent.filter((x) => x.method === "answerCallbackQuery").map((x) => x.body.text);

    // Чужой чат (и чат без диалога) — подделанная кнопка не проходит.
    await s.t.action(internal.telegram.handleUpdate, cb(999, `rv:${id}:1`));
    await s.t.action(internal.telegram.handleUpdate, cb(555, `rv:${id}:1`));
    expect(await reviews()).toHaveLength(0);
    expect(answers()).toEqual([expect.stringContaining("только из чата клиента"), expect.stringContaining("только из чата клиента")]);
    expect(sent.some((x) => x.method === "editMessageReplyMarkup")).toBe(false);

    await s.t.action(internal.telegram.handleUpdate, cb(777, `rv:${id}:4`));
    let all = await reviews();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ orderId: id, rating: 4, via: "telegram", clientId: s.ids.client });
    expect(answers().at(-1)).toBe("Спасибо за оценку!");
    expect(sent.filter((x) => x.method === "editMessageReplyMarkup").map((x) => x.body)).toEqual([{ chat_id: "777", message_id: 42, reply_markup: { inline_keyboard: [] } }]);
    expect((await s.t.run((ctx) => ctx.db.query("conversationMessages").withIndex("by_conversation", (q) => q.eq("conversationId", conv)).collect())).map((m) => m.text)).toEqual(["Клиент оценил работу: 4★"]);

    // Повторное нажатие (другая звезда) ничего не меняет, но звёзды тоже убирает.
    await s.t.action(internal.telegram.handleUpdate, cb(777, `rv:${id}:1`));
    all = await reviews();
    expect(all).toHaveLength(1);
    expect(all[0]!.rating).toBe(4);
    expect(answers().at(-1)).toContain("оценка уже получена");
    expect(sent.filter((x) => x.method === "editMessageReplyMarkup")).toHaveLength(2);
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.ex)))?.reviews).toBe(1);
  });
});
