/// <reference types="vite/client" />
// Переписка с клиентом из заказа (ТЗ п.9.12, п.16.2): сообщение уходит в мессенджер клиента (Telegram, WhatsApp в окне),
// писать некуда — заметка и «позвоните», ответы клиента — в ленте заказа за его период, мастеру и руководителю не видно.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { NO_CHANNEL } from "../src/data/orderClientChat";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const WA_SEND = "https://graph.facebook.com/v26.0/987654321098765/messages";
type Sent = { channel: "telegram" | "whatsapp"; body: Record<string, unknown> };
let sent: Sent[] = [];
let tgFails = false;
let seq = 0;

beforeEach(() => {
  sent = [];
  tgFails = false;
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("WHATSAPP_TOKEN", "EAAtest");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "987654321098765");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (String(url) === WA_SEND) {
        sent.push({ channel: "whatsapp", body });
        return Response.json({ messaging_product: "whatsapp", messages: [{ id: `wamid.OUT${++seq}` }] });
      }
      if (String(url).startsWith("https://api.telegram.org/")) {
        if (tgFails) return Response.json({ ok: false, description: "Forbidden: bot was blocked by the user" }, { status: 403 });
        sent.push({ channel: "telegram", body });
        return Response.json({ ok: true, result: { message_id: ++seq } });
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
  const at = (ms: number) => new Date(now + ms).toISOString();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руслан Руководитель", email: "mgr@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at(0) });
    const exUser = await ctx.db.insert("users", { name: "Асет Мастеров", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгерим", kind: "person", phone: "77071234567", city: "Алматы", source: "telegram", tags: [], createdAt: at(0), ordersCount: 1, activeCount: 1, lastActivityAt: at(0) });
    const other = await ctx.db.insert("clients", { tenantId: T, name: "Чужой", kind: "person", phone: "77079990000", city: "Алматы", source: "telegram", tags: [], createdAt: at(0), ordersCount: 0, activeCount: 0, lastActivityAt: at(0) });
    return { owner, operator, manager, ex, exUser, client, other };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const flush = () => t.finishAllScheduledFunctions(() => {});
  /** Диалог клиента: последнее сообщение hoursAgo часов назад; у WhatsApp окно — 24 часа от него. */
  const conversation = (channel: Doc<"conversations">["channel"], externalId: string, hoursAgo: number, clientId: Id<"clients"> = ids.client) =>
    t.run((ctx) =>
      ctx.db.insert("conversations", {
        tenantId: T,
        channel,
        externalId,
        clientId,
        contactName: "Айгерим К.",
        lastMessageAt: at(-hoursAgo * HOUR),
        lastText: "…",
        lastDirection: "in",
        unread: 0,
        status: "open",
        replyUntil: channel === "whatsapp" ? at(-hoursAgo * HOUR + DAY) : undefined,
      }),
    );
  const incoming = (conversationId: Id<"conversations">, text: string, msAgo: number) =>
    t.run((ctx) => ctx.db.insert("conversationMessages", { conversationId, direction: "in", kind: "text", text, at: at(-msAgo) }));
  const order = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: 1001,
        clientId: ids.client,
        clientName: "Айгерим",
        clientPhone: "77071234567",
        source: "telegram",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: at(DAY),
        priority: "normal",
        status: "accepted",
        executorId: ids.ex,
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        createdAt: at(-2 * HOUR),
        createdBy: ids.owner,
        files: [],
        ...over,
      }),
    );
  const notes = (orderId: Id<"orders">) => t.run((ctx) => ctx.db.query("messages").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect());
  return { t, ids, as, flush, conversation, incoming, order, notes, at };
}

describe("сообщение клиенту из заказа", () => {
  test("уходит в Telegram клиента: статус «отправлено» в ленте заказа, отметка в истории, не заметка", async () => {
    const s = await setup();
    const conv = await s.conversation("telegram", "777", 1);
    const orderId = await s.order();
    const r = await s.as(s.ids.operator).mutation(api.orderClientChat.send, { orderId, text: "Мастер будет в 15:00" });
    expect(r).toEqual({ sent: true, channel: "telegram" });
    await s.flush();
    expect(sent).toEqual([{ channel: "telegram", body: expect.objectContaining({ chat_id: "777", text: "Мастер будет в 15:00" }) }]);

    const feed = (await s.as(s.ids.operator).query(api.orderClientChat.feed, { orderId }))!;
    expect(feed.target).toEqual({ conversationId: conv, channel: "telegram" });
    expect(feed.dialogId).toBe(conv);
    expect(feed.messages).toEqual([expect.objectContaining({ direction: "out", text: "Мастер будет в 15:00", status: "sent", authorName: "Мадина Оператор", channel: "telegram" })]);
    expect(await s.notes(orderId)).toEqual([]);
    const history = await s.t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect());
    expect(history.map((h) => h.text)).toContain("Сообщение клиенту в Telegram");
    // Ответ в канал — как из «Сообщений»: превью диалога обновлено.
    expect((await s.t.run((ctx) => ctx.db.get(conv)))!.lastText).toBe("Мастер будет в 15:00");
  });

  test("Telegram отказал — в ленте «не доставлено» с причиной", async () => {
    const s = await setup();
    await s.conversation("telegram", "777", 1);
    const orderId = await s.order();
    tgFails = true;
    await s.as(s.ids.owner).mutation(api.orderClientChat.send, { orderId, text: "Здравствуйте" });
    await s.flush();
    const feed = (await s.as(s.ids.owner).query(api.orderClientChat.feed, { orderId }))!;
    expect(feed.messages[0]).toMatchObject({ status: "failed", error: "Клиент заблокировал бота — сообщение не доставлено" });
  });

  test("WhatsApp: в 24-часовом окне — уходит; окно закрыто — заметка в заказе и «позвоните»", async () => {
    const s = await setup();
    const wa = await s.conversation("whatsapp", "77071234567", 2);
    const orderId = await s.order();
    expect(await s.as(s.ids.operator).mutation(api.orderClientChat.send, { orderId, text: "Едем" })).toEqual({ sent: true, channel: "whatsapp" });
    await s.flush();
    expect(sent.map((x) => x.channel)).toEqual(["whatsapp"]);

    await s.t.run((ctx) => ctx.db.patch(wa, { replyUntil: new Date(Date.now() - 1000).toISOString() }));
    const r = await s.as(s.ids.operator).mutation(api.orderClientChat.send, { orderId, text: "Мастер опоздает на 20 минут" });
    expect(r).toEqual({ sent: false, reason: `${NO_CHANNEL}: окно WhatsApp закрыто — клиент писал больше суток назад` });
    await s.flush();
    expect(sent).toHaveLength(1);
    expect((await s.notes(orderId)).map((m) => [m.channel, m.text])).toEqual([["client", "Мастер опоздает на 20 минут"]]);
    const feed = (await s.as(s.ids.operator).query(api.orderClientChat.feed, { orderId }))!;
    expect(feed.target).toBeNull();
    expect(feed.blocked).toContain("окно WhatsApp закрыто");
    // «Открыть диалог» всё равно ведёт в последний диалог клиента.
    expect(feed.dialogId).toBe(wa);
  });

  test("клиент не на связи в мессенджерах (только форма сайта) — понятная причина, запись остаётся заметкой", async () => {
    const s = await setup();
    await s.conversation("site", "77071234567", 1);
    const orderId = await s.order();
    const r = await s.as(s.ids.owner).mutation(api.orderClientChat.send, { orderId, text: "Перезвоните нам" });
    expect(r).toEqual({ sent: false, reason: NO_CHANNEL });
    expect((await s.notes(orderId)).map((m) => m.text)).toEqual(["Перезвоните нам"]);
    await s.flush();
    expect(sent).toEqual([]);
  });

  test("пустое сообщение — отказ", async () => {
    const s = await setup();
    const orderId = await s.order();
    await expect(s.as(s.ids.owner).mutation(api.orderClientChat.send, { orderId, text: "  " })).rejects.toThrow("Напишите сообщение");
  });
});

describe("ответы клиента в заказе", () => {
  test("лента — сообщения диалогов клиента за период заказа; чужие и слишком старые — нет", async () => {
    const s = await setup();
    const tg = await s.conversation("telegram", "777", 0);
    const strangers = await s.conversation("telegram", "888", 0, s.ids.other);
    const orderId = await s.order({ createdAt: s.at(-2 * DAY) });
    await s.incoming(tg, "Кондиционер течёт", 2 * DAY + HOUR); // за час до заказа — обращение
    await s.incoming(tg, "Старый разговор про другое", 10 * DAY);
    await s.incoming(tg, "Во сколько приедете?", HOUR);
    await s.incoming(strangers, "Чужое сообщение", HOUR);
    const feed = (await s.as(s.ids.operator).query(api.orderClientChat.feed, { orderId }))!;
    expect(feed.messages.map((m) => [m.direction, m.text, m.contactName])).toEqual([
      ["in", "Кондиционер течёт", "Айгерим К."],
      ["in", "Во сколько приедете?", "Айгерим К."],
    ]);
  });

  test("закрытый заказ: ответы спустя трое суток после закрытия в ленту не попадают", async () => {
    const s = await setup();
    const tg = await s.conversation("telegram", "777", 0);
    const orderId = await s.order({ createdAt: s.at(-10 * DAY), status: "closed", closedAt: s.at(-6 * DAY) });
    await s.incoming(tg, "Спасибо, всё работает", 5 * DAY);
    await s.incoming(tg, "Нужна ещё чистка", HOUR);
    const feed = (await s.as(s.ids.owner).query(api.orderClientChat.feed, { orderId }))!;
    expect(feed.messages.map((m) => m.text)).toEqual(["Спасибо, всё работает"]);
  });

  test("мастер и руководитель направления переписку с клиентом не видят и клиенту не пишут", async () => {
    const s = await setup();
    const tg = await s.conversation("telegram", "777", 0);
    const orderId = await s.order();
    await s.incoming(tg, "Мой домофон 25", HOUR);
    expect(await s.as(s.ids.exUser).query(api.orderClientChat.feed, { orderId })).toBeNull();
    expect(await s.as(s.ids.manager).query(api.orderClientChat.feed, { orderId })).toBeNull();
    await expect(s.as(s.ids.exUser).mutation(api.orderClientChat.send, { orderId, text: "Я мастер" })).rejects.toThrow();
    await expect(s.as(s.ids.manager).mutation(api.orderClientChat.send, { orderId, text: "Я руководитель" })).rejects.toThrow();
    // В заказе глазами мастера — ни текста клиента, ни заметок по клиенту.
    await s.as(s.ids.operator).mutation(api.orderClientChat.send, { orderId, text: "Код домофона 25" });
    const worker = await s.as(s.ids.exUser).query(api.executorApp.order, { id: orderId });
    expect(JSON.stringify(worker)).not.toContain("домофон");
  });
});
