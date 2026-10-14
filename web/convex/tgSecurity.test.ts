/// <reference types="vite/client" />
// Безопасность Telegram-бота (аудит H-4, L-3, M-9, E19): чужой контакт, антиспам (флуд, голосовые, длина черновика),
// кнопки от имени нажавшего, повтор доставки вебхука, ссылки привязки; уборка служебных таблиц.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const at = new Date().toISOString();
const CODE = "b".repeat(24);
const WEBHOOK_SECRET = "tg-webhook-secret";
const AI_EXTRACT = { summary: "Течёт кран", serviceId: "leak-fix", city: "Алматы", address: null, when: null, budget: null, urgency: "normal", clientName: null, questions: [] };

type Sent = { method: string; body: Record<string, unknown> };
let sent: Sent[] = [];
let ai: string[] = [];

beforeEach(() => {
  sent = [];
  ai = [];
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "test_bot");
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("APP_URL", "https://app.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://ai.test/v1/transcribe")) {
        ai.push("transcribe");
        return Response.json({ text: "Течёт кран на кухне", language: "ru", seconds: 20 });
      }
      if (u.startsWith("https://ai.test/v1/extract")) {
        ai.push("extract");
        return Response.json(AI_EXTRACT);
      }
      if (u.startsWith("https://api.telegram.org/file/")) return new Response(new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/ogg" } });
      const method = u.split("/").pop()!;
      sent.push({ method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      const result = method === "getFile" ? { file_path: "voice/file_1.oga", file_size: 3 } : {};
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const texts = () => sent.filter((s) => s.method === "sendMessage").map((s) => String(s.body.text));
const withAi = () => {
  vi.stubEnv("AI_URL", "https://ai.test");
  vi.stubEnv("AI_SECRET", "s");
};

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const exUser = await ctx.db.insert("users", { name: "Асет Мастеров", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Настоящий Клиент", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Настоящий Клиент",
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
    return { owner, ex, exUser, client, order };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as };
}

let messageId = 0;
const msg = (chatId: number, text: string | undefined, extra: Record<string, unknown> = {}) => ({
  update: { message: { message_id: ++messageId, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Гульмира" }, text, ...extra } },
});

describe("бот: только свой номер (аудит H-4)", () => {
  test("чужая карточка контакта — отказ: ни заявки, ни записи в историю настоящего клиента; свой контакт — заявка", async () => {
    const { t, ids } = await setup();
    await t.action(internal.telegram.handleUpdate, msg(777, "Отмените мой заказ, мастер не нужен"));
    // Карточка из записной книжки: номер настоящего клиента, user_id — не отправителя (или его нет вовсе).
    await t.action(internal.telegram.handleUpdate, msg(777, undefined, { contact: { phone_number: "+7 707 123 45 67", first_name: "Клиент", user_id: 999 } }));
    await t.action(internal.telegram.handleUpdate, msg(777, undefined, { contact: { phone_number: "+7 707 123 45 67", first_name: "Клиент" } }));
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("interactions").withIndex("by_client", (q) => q.eq("clientId", ids.client)).collect())).toHaveLength(0);
    const refusal = sent.filter((s) => s.method === "sendMessage").at(-1)!;
    expect(String(refusal.body.text)).toContain("собственный номер");
    expect(JSON.stringify(refusal.body.reply_markup)).toContain("request_contact");

    // Тот же человек делится своим номером кнопкой — заявка создаётся.
    await t.action(internal.telegram.handleUpdate, msg(777, undefined, { contact: { phone_number: "+7 701 222 33 44", first_name: "Гульмира", user_id: 777 } }));
    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads.map((l) => l.clientPhone)).toEqual(["77012223344"]);
  });
});

describe("бот: антиспам (аудит E19)", () => {
  test("голосовое длиннее 2 минут — не скачиваем и не расшифровываем, просим покороче", async () => {
    withAi();
    const { t } = await setup();
    await t.action(internal.telegram.handleUpdate, msg(778, undefined, { voice: { file_id: "v-long", duration: 300 } }));
    expect(sent.some((s) => s.method === "getFile")).toBe(false);
    expect(ai).toEqual([]);
    expect(texts().at(-1)).toContain("длиннее 2 минут");
    const inbox = await t.run((ctx) => ctx.db.query("conversationMessages").collect());
    expect(inbox.find((m) => m.direction === "in")).toMatchObject({ kind: "audio", text: "Голосовое сообщение" });
    expect(inbox.find((m) => m.direction === "in")?.fileId).toBeUndefined();
  });

  test("голосовых больше 10 в час — без расшифровки; до лимита — расшифровываются", async () => {
    withAi();
    const { t } = await setup();
    await t.run((ctx) => ctx.db.insert("rateLimits", { key: "tg:voice:779", windowStart: Date.now(), count: 10 }));
    await t.action(internal.telegram.handleUpdate, msg(779, undefined, { voice: { file_id: "v-1", duration: 15 } }));
    expect(sent.some((s) => s.method === "getFile")).toBe(false);
    expect(ai).toEqual([]);
    expect(texts().at(-1)).toContain("Слишком много голосовых");

    await t.action(internal.telegram.handleUpdate, msg(780, undefined, { voice: { file_id: "v-2", duration: 15 } }));
    expect(sent.some((s) => s.method === "getFile")).toBe(true);
    expect(ai).toContain("transcribe");
  });

  test("черновик заявки полон — не дописываем молча, а просим номер", async () => {
    const { t } = await setup();
    const full = "Подробно о поломке. ".repeat(150).slice(0, 3000);
    await t.run((ctx) => ctx.db.insert("botChats", { chatId: "781", state: "awaiting_phone", draft: full, updatedAt: new Date().toISOString() }));
    await t.action(internal.telegram.handleUpdate, msg(781, "И ещё одна мелочь"));
    expect(texts().at(-1)).toContain("Подробности уже записали");
    const row = await t.run((ctx) => ctx.db.query("botChats").withIndex("by_chat", (q) => q.eq("chatId", "781")).first());
    expect(row?.draft).toBe(full);
  });
});

describe("кнопки и вебхук (аудит L-3)", () => {
  test("кнопку нажал не владелец чата — отказ: действует только нажавший и только в личном чате", async () => {
    const { t, ids } = await setup();
    // Карточка в чате, привязанном к мастеру, но нажал посторонний (from.id ≠ chat.id): раньше заказ брался от имени мастера.
    await t.run((ctx) => ctx.db.patch(ids.exUser, { telegramChatId: "-100500" }));
    const cb = { update: { callback_query: { id: "cb-group", data: `take:${ids.order}`, from: { id: 999 }, message: { message_id: 7, chat: { id: -100500 } } } } };
    await t.action(internal.telegram.handleUpdate, cb);
    const o = await t.run((ctx) => ctx.db.get(ids.order));
    expect(o?.status).toBe("awaiting_executor");
    expect(o?.executorId).toBeUndefined();
    const answer = sent.find((s) => s.method === "answerCallbackQuery")!;
    expect(answer.body).toMatchObject({ show_alert: true });
    expect(String(answer.body.text)).toContain("личном чате");
  });

  test("повтор доставки того же update_id обрабатывается один раз; без секрета — 403", async () => {
    vi.useFakeTimers();
    const { t, ids } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.exUser, { telegramChatId: "555" }));
    // Команда мастера: её ничто, кроме update_id, от повтора не защищает — второй ответ ушёл бы в чат.
    const update = { update_id: 424242, message: { message_id: 1, chat: { id: 555, type: "private" }, from: { id: 555 }, text: "/feed" } };
    const post = (secret: string) => t.fetch("/telegram", { method: "POST", body: JSON.stringify(update), headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": secret } });
    expect((await post("wrong-secret")).status).toBe(403);
    expect((await post(WEBHOOK_SECRET)).status).toBe(200);
    expect((await post(WEBHOOK_SECRET)).status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.query("telegramUpdates").collect())).toHaveLength(1);
    expect(texts().filter((x) => x.includes("Свободные заказы"))).toHaveLength(1);
  });
});

describe("привязка Telegram (аудит M-9)", () => {
  const start = (chatId: number) => msg(chatId, `/start ${CODE}`);
  const withCode = (extra: Record<string, unknown> = {}) => ({ telegramLinkCode: CODE, telegramLinkExpiresAt: Date.now() + 30 * 60_000, ...extra });

  test("ссылка из кабинета живёт 30 минут, одноразовая; привязка и отвязка — в журнале", async () => {
    const { t, ids, as } = await setup();
    const url = await as(ids.exUser).mutation(api.telegram.linkUrl, {});
    const u = (await t.run((ctx) => ctx.db.get(ids.exUser)))!;
    expect(url).toBe(`https://t.me/test_bot?start=${u.telegramLinkCode}`);
    expect(u.telegramLinkExpiresAt! - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(u.telegramLinkExpiresAt! - Date.now()).toBeLessThanOrEqual(30 * 60_000);

    await t.action(internal.telegram.handleUpdate, msg(555, `/start ${u.telegramLinkCode}`));
    expect((await t.run((ctx) => ctx.db.get(ids.exUser)))?.telegramChatId).toBe("555");
    // Та же ссылка второй раз (переслали, утекла) — уже не работает.
    await t.action(internal.telegram.handleUpdate, msg(556, `/start ${u.telegramLinkCode}`));
    expect((await t.run((ctx) => ctx.db.get(ids.exUser)))?.telegramChatId).toBe("555");
    expect(texts().at(-1)).toContain("Ссылка устарела");

    // Подключённому новая ссылка не выдаётся: сначала «Отключить Telegram».
    await expect(as(ids.exUser).mutation(api.telegram.linkUrl, {})).rejects.toThrow("Отключить Telegram");
    await as(ids.exUser).mutation(api.telegram.unlink, {});
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.map((a) => [a.action, a.entityId, a.summary.split(":")[0]])).toEqual([
      ["user.telegram", ids.exUser, "Telegram подключён"],
      ["user.telegram", ids.exUser, "Telegram отключён"],
    ]);
  });

  test("просроченная ссылка, отключённый доступ и временный пароль — не привязываем; код гасится", async () => {
    const { t, ids } = await setup();
    for (const extra of [{ telegramLinkExpiresAt: Date.now() - 1 }, { active: false }, { mustChangePassword: true }]) {
      await t.run((ctx) => ctx.db.patch(ids.exUser, withCode(extra)));
      await t.action(internal.telegram.handleUpdate, start(555));
      const u = await t.run((ctx) => ctx.db.get(ids.exUser));
      expect(u?.telegramChatId).toBeUndefined();
      expect(u?.telegramLinkCode).toBeUndefined();
      expect(texts().at(-1)).toContain("Ссылка устарела");
      await t.run((ctx) => ctx.db.patch(ids.exUser, { active: true, mustChangePassword: undefined }));
    }
  });

  test("аккаунт уже подключён к другому чату — молча не заменяем, объясняем, как перенести", async () => {
    const { t, ids } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.exUser, withCode({ telegramChatId: "999" })));
    await t.action(internal.telegram.handleUpdate, start(555));
    expect((await t.run((ctx) => ctx.db.get(ids.exUser)))?.telegramChatId).toBe("999");
    expect(texts().at(-1)).toContain("уже подключён к другому Telegram");
  });
});

describe("уборка служебных таблиц", () => {
  test("отжившие лимиты и update_id удаляются, свежие остаются", async () => {
    vi.useFakeTimers();
    const t0 = new Date("2026-10-10T10:00:00Z").getTime();
    vi.setSystemTime(t0);
    const { t } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.insert("rateLimits", { key: "tg:chat:old", windowStart: t0, count: 3 });
      await ctx.db.insert("telegramUpdates", { updateId: 1 });
    });
    vi.setSystemTime(t0 + 3 * 86400_000);
    await t.run(async (ctx) => {
      await ctx.db.insert("rateLimits", { key: "tg:chat:fresh", windowStart: Date.now(), count: 1 });
      await ctx.db.insert("telegramUpdates", { updateId: 2 });
    });
    expect(await t.mutation(internal.maintenance.cleanup, {})).toEqual({ rateLimits: 1, telegramUpdates: 1 });
    expect((await t.run((ctx) => ctx.db.query("rateLimits").collect())).map((r) => r.key)).toEqual(["tg:chat:fresh"]);
    expect((await t.run((ctx) => ctx.db.query("telegramUpdates").collect())).map((r) => r.updateId)).toEqual([2]);
  });
});
