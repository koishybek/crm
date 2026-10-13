/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { isMeaningful } from "./lib/chat";
import { findKzPhone, kzPhone } from "./lib/phone";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const page = { numItems: 50, cursor: null };
type Sent = { method: string; body: Record<string, unknown> };
const AI_EXTRACT = { summary: "Течёт кран на кухне", serviceId: "leak-fix", city: "Алматы", address: "ул. Абая 10", when: null, budget: null, urgency: "high", clientName: "Айгерим", questions: ["Какой этаж?"] };
let sent: Sent[] = [];
/** Ответ Telegram на sendMessage — меняется в тестах ошибок. */
let tgReply: Record<string, unknown> = { ok: true, result: { message_id: 555 } };

beforeEach(() => {
  sent = [];
  tgReply = { ok: true, result: { message_id: 555 } };
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "test_bot");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://ai.test/v1/extract")) return Response.json(AI_EXTRACT);
      const method = String(url).split("/").pop()!;
      sent.push({ method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return Response.json(method === "sendMessage" ? tgReply : { ok: true, result: {} });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const at = new Date().toISOString();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true, telegramChatId: "100" });
    const operator = await ctx.db.insert("users", { name: "Оператор Мадина", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель", email: "man@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const executor = await ctx.db.insert("users", { name: "Асет", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    return { owner, operator, manager, executor, ex, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const wa = (externalId: string, text: string, extra: Record<string, unknown> = {}) =>
  ({ channel: "whatsapp" as const, externalId, contactPhone: externalId, contactName: "Айгерим", text, kind: "text" as const, ...extra });

const conversations = (s: Setup) => s.t.run((ctx) => ctx.db.query("conversations").collect());
const messagesOf = (s: Setup, id: Id<"conversations">) => s.t.run((ctx) => ctx.db.query("conversationMessages").withIndex("by_conversation", (q) => q.eq("conversationId", id)).collect());
const leads = (s: Setup) => s.t.run((ctx) => ctx.db.query("leads").collect());

describe("разбор текста", () => {
  test("казахстанский номер: нормализация и поиск в тексте", () => {
    expect(kzPhone("+7 (701) 123-45-67")).toBe("77011234567");
    expect(kzPhone("8 701 1234567")).toBe("77011234567");
    expect(kzPhone("7011234567")).toBe("77011234567");
    expect(kzPhone("+7 995 123 45 67")).toBeNull(); // Россия
    expect(kzPhone("12345")).toBeNull();
    expect(findKzPhone("Здравствуйте, мой номер 8 701 555 44 33, звоните после 18")).toBe("77015554433");
    expect(findKzPhone("+7(727)3001020 офис")).toBe("77273001020");
    expect(findKzPhone("Заказ 123456789012, квартира 87")).toBeNull();
  });

  test("суть обращения — не приветствие и не вложение", () => {
    expect(isMeaningful("Течёт кран на кухне")).toBe(true);
    expect(isMeaningful("Нужен электрик")).toBe(true);
    expect(isMeaningful("Здравствуйте")).toBe(false);
    expect(isMeaningful("Добрый день!")).toBe(false);
    expect(isMeaningful("Спасибо большое")).toBe(false);
    expect(isMeaningful("Фото")).toBe(false);
    expect(isMeaningful("Стикер 👍")).toBe(false);
  });
});

describe("входящие", () => {
  test("повтор вебхука не дублирует сообщение", async () => {
    const s = await setup();
    const first = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Течёт кран", { externalMessageId: "wamid.1" }));
    const again = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Течёт кран", { externalMessageId: "wamid.1" }));
    expect(first.duplicate).toBe(false);
    expect(again).toMatchObject({ duplicate: true, conversationId: first.conversationId, messageId: first.messageId });
    expect(await messagesOf(s, first.conversationId)).toHaveLength(1);
    expect((await conversations(s))[0]!.unread).toBe(1);
  });

  test("один диалог на собеседника; закрытый открывается заново новым сообщением", async () => {
    const s = await setup();
    const a = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Течёт кран"));
    await s.as(s.ids.operator).mutation(api.inbox.close, { id: a.conversationId });
    let c = (await conversations(s))[0]!;
    expect(c).toMatchObject({ status: "closed", unread: 0 });
    const b = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Ещё вопрос по смесителю"));
    expect(b.conversationId).toBe(a.conversationId);
    expect(b.created).toBe(false);
    c = (await conversations(s))[0]!;
    expect(c).toMatchObject({ status: "open", unread: 1, lastText: "Ещё вопрос по смесителю", lastDirection: "in" });
    // Закрытые — в архиве, открытые — в общем списке.
    const open = await s.as(s.ids.operator).query(api.inbox.list, { filter: "all", paginationOpts: page });
    expect(open.page.map((x) => x.id)).toEqual([a.conversationId]);
    const closed = await s.as(s.ids.operator).query(api.inbox.list, { filter: "closed", paginationOpts: page });
    expect(closed.page).toHaveLength(0);
  });

  test("непрочитанные, «прочитано» и фильтры списка", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const w = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Течёт кран"));
    await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Срочно, пожалуйста"));
    await s.t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-1", text: "Добрый день, ещё актуально?", kind: "text", subject: "Ремонт кондиционеров", subjectUrl: "https://www.olx.kz/d/obyavlenie/ID1.html" });
    expect(await op.query(api.inbox.unreadCount, {})).toBe(2);
    expect((await op.query(api.inbox.get, { id: w.conversationId }))!.conversation.unread).toBe(2);
    await op.mutation(api.inbox.markRead, { id: w.conversationId });
    expect(await op.query(api.inbox.unreadCount, {})).toBe(1);
    const unread = await op.query(api.inbox.list, { filter: "unread", paginationOpts: page });
    expect(unread.page.map((c) => c.channel)).toEqual(["olx"]);
    expect(unread.page[0]!.subjectUrl).toBe("https://www.olx.kz/d/obyavlenie/ID1.html");
    const whatsapp = await op.query(api.inbox.list, { filter: "whatsapp", paginationOpts: page });
    expect(whatsapp.page.map((c) => c.id)).toEqual([w.conversationId]);
    // Назначение → фильтр «Мои».
    await op.mutation(api.inbox.assign, { id: w.conversationId, userId: s.ids.operator });
    expect((await op.query(api.inbox.list, { filter: "mine", paginationOpts: page })).page.map((c) => c.id)).toEqual([w.conversationId]);
    expect((await s.as(s.ids.owner).query(api.inbox.list, { filter: "mine", paginationOpts: page })).page).toHaveLength(0);
    await expect(op.mutation(api.inbox.assign, { id: w.conversationId, userId: s.ids.manager })).rejects.toThrow("владельца или оператора");
  });

  test("клиент по номеру привязывается сам; номер из текста OLX запоминается; ссылки — только http(s)", async () => {
    const s = await setup();
    const w = await s.t.mutation(internal.inbox.ingest, wa("+7 707 123 45 67", "Сломалась стиральная машина"));
    let c = (await s.t.run((ctx) => ctx.db.get(w.conversationId)))!;
    expect(c.clientId).toBe(s.ids.client);
    expect(c.contactPhone).toBe("77071234567");
    const o = await s.t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-2", text: "Мой номер 8 701 555 44 33, перезвоните", kind: "text", subjectUrl: "javascript:alert(1)" });
    c = (await s.t.run((ctx) => ctx.db.get(o.conversationId)))!;
    expect(c.contactPhone).toBe("77015554433");
    expect(c.subjectUrl).toBeUndefined();
  });

  test("сообщение компании из синхронизации канала (OLX) — исходящее: без «непрочитанных», уведомлений и авто-заявки", async () => {
    const s = await setup();
    const a = await s.t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-7", contactName: "Ержан", text: "Здравствуйте, сколько стоит чистка?", kind: "text", externalMessageId: "m-1" });
    const notesBefore = (await s.t.run((ctx) => ctx.db.query("notifications").collect())).length;
    await s.t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-7", text: "Добрый день! 10 000 ₸ за сплит, мой номер 8 701 000 00 00", kind: "text", externalMessageId: "m-2", direction: "out" });
    const c = (await s.t.run((ctx) => ctx.db.get(a.conversationId)))!;
    expect(c).toMatchObject({ unread: 1, lastDirection: "out", lastText: "Добрый день! 10 000 ₸ за сплит, мой номер 8 701 000 00 00" });
    // Номер в нашем же сообщении — не номер клиента.
    expect(c.contactPhone).toBeUndefined();
    const out = (await messagesOf(s, a.conversationId)).at(-1)!;
    expect(out).toMatchObject({ direction: "out", status: "sent", kind: "text" });
    expect((await s.t.run((ctx) => ctx.db.query("notifications").collect())).length).toBe(notesBefore);
  });

  test("статус доставки от канала обновляется и не откатывается назад", async () => {
    const s = await setup();
    const { conversationId } = await s.t.mutation(internal.inbox.ingest, { channel: "telegram", externalId: "777", text: "Здравствуйте", kind: "text", externalMessageId: "777:1", notify: false, autoLead: false });
    const { messageId } = await s.as(s.ids.operator).mutation(api.inbox.reply, { conversationId, text: "Добрый день!" });
    await s.t.finishAllScheduledFunctions(() => {});
    const status = (st: "sent" | "delivered" | "read" | "failed") => s.t.mutation(internal.inbox._deliveryStatus, { channel: "telegram", externalMessageId: "777:555", status: st });
    expect(await status("delivered")).toBe(true);
    expect(await status("read")).toBe(true);
    expect(await status("delivered")).toBe(false);
    expect(await status("failed")).toBe(false);
    expect((await s.t.run((ctx) => ctx.db.get(messageId)))!.status).toBe("read");
    expect(await s.t.mutation(internal.inbox._deliveryStatus, { channel: "telegram", externalMessageId: "777:404", status: "read" })).toBe(false);
  });

  test("уведомление о новом сообщении — владельцам и операторам, не чаще раза в 10 минут; назначенному — только ему", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T06:00:00Z"));
    const s = await setup();
    const inboxNotes = () => s.t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.link?.startsWith("/inbox?c=")));
    const a = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Течёт кран"));
    let notes = await inboxNotes();
    expect(notes.map((n) => n.userId).sort()).toEqual([s.ids.owner, s.ids.operator].sort());
    expect(notes[0]!.text).toContain("Новое сообщение в WhatsApp от Айгерим");
    expect(notes[0]!.link).toBe(`/inbox?c=${a.conversationId}`);
    await s.t.mutation(internal.inbox.ingest, wa("77019998877", "И смеситель шатается"));
    expect(await inboxNotes()).toHaveLength(2);
    vi.setSystemTime(new Date("2026-10-12T06:11:00Z"));
    await s.as(s.ids.owner).mutation(api.inbox.assign, { id: a.conversationId, userId: s.ids.operator });
    await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Вы тут?"));
    notes = await inboxNotes();
    expect(notes).toHaveLength(3);
    expect(notes.at(-1)!.userId).toBe(s.ids.operator);
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
  });
});

describe("ответы клиенту", () => {
  async function telegramChat(s: Setup) {
    return (await s.t.mutation(internal.inbox.ingest, { channel: "telegram", externalId: "777", contactName: "Гульмира", text: "Здравствуйте", kind: "text", externalMessageId: "777:1", notify: false, autoLead: false })).conversationId;
  }

  test("Telegram: «отправляется» → «отправлено»; текст экранируется; в журнале — без текста", async () => {
    const s = await setup();
    const id = await telegramChat(s);
    const op = s.as(s.ids.operator);
    const { messageId } = await op.mutation(api.inbox.reply, { conversationId: id, text: "  Мастер будет в 18:00 <b>сегодня</b> & завтра  " });
    let m = (await s.t.run((ctx) => ctx.db.get(messageId)))!;
    expect(m).toMatchObject({ status: "sending", direction: "out", kind: "text", authorId: s.ids.operator, text: "Мастер будет в 18:00 <b>сегодня</b> & завтра" });
    const c = (await s.t.run((ctx) => ctx.db.get(id)))!;
    expect(c).toMatchObject({ lastDirection: "out", unread: 0, lastText: "Мастер будет в 18:00 <b>сегодня</b> & завтра" });
    await s.t.finishAllScheduledFunctions(() => {});
    m = (await s.t.run((ctx) => ctx.db.get(messageId)))!;
    expect(m.status).toBe("sent");
    expect(m.externalId).toBe("telegram:777:555");
    const out = sent.find((x) => x.method === "sendMessage" && x.body.chat_id === "777")!;
    expect(out.body).toMatchObject({ chat_id: "777", parse_mode: "HTML", text: "Мастер будет в 18:00 &lt;b&gt;сегодня&lt;/b&gt; &amp; завтра" });
    const journal = await s.t.run((ctx) => ctx.db.query("audit").collect());
    const entry = journal.find((x) => x.action === "conversation.reply")!;
    expect(entry).toMatchObject({ actorId: s.ids.operator, entity: "conversation", entityId: id });
    expect(entry.meta).toEqual({ channel: "telegram", length: "Мастер будет в 18:00 <b>сегодня</b> & завтра".length });
    expect(JSON.stringify(entry)).not.toContain("18:00");
    expect((await s.t.run((ctx) => ctx.db.query("systemStatus").collect())).find((x) => x.key === "telegram")?.okAt).toBeDefined();
  });

  test("ошибка Telegram: «не отправлено» с причиной, повтор отправляет", async () => {
    const s = await setup();
    const id = await telegramChat(s);
    const op = s.as(s.ids.operator);
    tgReply = { ok: false, description: "Forbidden: bot was blocked by the user" };
    const { messageId } = await op.mutation(api.inbox.reply, { conversationId: id, text: "Добрый вечер" });
    await s.t.finishAllScheduledFunctions(() => {});
    let m = (await s.t.run((ctx) => ctx.db.get(messageId)))!;
    expect(m.status).toBe("failed");
    expect(m.error).toContain("заблокировал бота");
    // Блокировка конкретным клиентом — не сбой канала.
    expect((await s.t.run((ctx) => ctx.db.query("systemStatus").collect())).find((x) => x.key === "telegram")?.error).toBeUndefined();
    const detail = (await op.query(api.inbox.get, { id }))!;
    expect(detail.messages.at(-1)).toMatchObject({ status: "failed", error: m.error });

    tgReply = { ok: true, result: { message_id: 556 } };
    await op.mutation(api.inbox.resend, { messageId });
    await s.t.finishAllScheduledFunctions(() => {});
    m = (await s.t.run((ctx) => ctx.db.get(messageId)))!;
    expect(m.status).toBe("sent");
    expect(m.error).toBeUndefined();
    await expect(op.mutation(api.inbox.resend, { messageId })).rejects.toThrow("нельзя отправить повторно");
  });

  test("сломанный токен — сбой канала в мониторинге", async () => {
    const s = await setup();
    const id = await telegramChat(s);
    tgReply = { ok: false, description: "Unauthorized" };
    await s.as(s.ids.operator).mutation(api.inbox.reply, { conversationId: id, text: "Здравствуйте" });
    await s.t.finishAllScheduledFunctions(() => {});
    expect((await s.t.run((ctx) => ctx.db.query("systemStatus").collect())).find((x) => x.key === "telegram")?.error).toContain("токен");
  });

  test("WhatsApp и OLX пока не подключены, у сайта нет обратного канала — честный отказ, ничего не сохраняется", async () => {
    const s = await setup();
    const op = s.as(s.ids.operator);
    const w = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Здравствуйте", { autoLead: false }));
    const o = await s.t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-3", text: "Актуально?", kind: "text" });
    const site = await s.t.mutation(internal.inbox.ingest, { channel: "site", externalId: "77019998800", contactPhone: "77019998800", text: "Заявка с сайта", kind: "text", autoLead: false, notify: false });
    await expect(op.mutation(api.inbox.reply, { conversationId: w.conversationId, text: "Добрый день" })).rejects.toThrow("Канал не подключён");
    await expect(op.mutation(api.inbox.reply, { conversationId: o.conversationId, text: "Добрый день" })).rejects.toThrow("Канал не подключён");
    await expect(op.mutation(api.inbox.reply, { conversationId: site.conversationId, text: "Добрый день" })).rejects.toThrow("Ответьте клиенту по телефону");
    expect((await op.query(api.inbox.get, { id: site.conversationId }))!.replyBlock).toBe("Ответьте клиенту по телефону");
    expect((await op.query(api.inbox.get, { id: w.conversationId }))!.replyBlock).toBe("Канал не подключён");
    const outs = await s.t.run(async (ctx) => (await ctx.db.query("conversationMessages").collect()).filter((m) => m.direction === "out"));
    expect(outs).toHaveLength(0);
  });

  test("пустой и слишком длинный ответ отклоняются; без бота Telegram ответить нельзя", async () => {
    const s = await setup();
    const id = await telegramChat(s);
    const op = s.as(s.ids.operator);
    await expect(op.mutation(api.inbox.reply, { conversationId: id, text: "   " })).rejects.toThrow("Напишите сообщение");
    await expect(op.mutation(api.inbox.reply, { conversationId: id, text: "а".repeat(4001) })).rejects.toThrow("не больше 4000");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    await expect(op.mutation(api.inbox.reply, { conversationId: id, text: "Здравствуйте" })).rejects.toThrow("Telegram-бот не подключён");
  });
});

describe("Telegram → «Сообщения»", () => {
  let mid = 1000;
  const msg = (chatId: number, text: string | undefined, extra: Record<string, unknown> = {}) => ({
    update: { message: { message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Гульмира", username: "gulmira_kz" }, text, ...extra } },
  });

  test("сообщения клиента и ответы бота попадают в чат, бот создаёт заявку, диалог связан с заявкой и клиентом", async () => {
    const s = await setup();
    await s.t.action(internal.telegram.handleUpdate, msg(777, "Течёт кран на кухне, Алматы"));
    await s.t.action(internal.telegram.handleUpdate, msg(777, undefined, { contact: { phone_number: "+7 701 222 33 44", first_name: "Гульмира" } }));
    const [lead] = await leads(s);
    expect(lead).toMatchObject({ source: "telegram", clientPhone: "77012223344" });
    const [c] = await conversations(s);
    expect(c).toMatchObject({ channel: "telegram", externalId: "777", contactName: "Гульмира", contactPhone: "77012223344", leadId: lead!._id, clientId: lead!.clientId });
    const thread = (await messagesOf(s, c!._id)).map((m) => `${m.direction}:${m.kind}:${m.text.split("\n")[0]}`);
    expect(thread).toEqual([
      "in:text:Течёт кран на кухне, Алматы",
      "out:system:Принято! Чтобы оператор перезвонил, поделитесь номером — кнопка ниже 👇",
      "in:text:Поделился номером: +7 701 222 33 44",
      `out:system:Спасибо, Гульмира! Заявка №${lead!.number} принята 🙌`,
    ]);
    // Системные сообщения бота не перебивают превью: последним показывается сообщение клиента.
    expect(c!.lastDirection).toBe("in");
    const detail = (await s.as(s.ids.operator).query(api.inbox.get, { id: c!._id }))!;
    expect(detail.lead).toMatchObject({ id: lead!._id, number: lead!.number });
    expect(detail.telegramUsername).toBe("gulmira_kz");
    expect(detail.replyBlock).toBeUndefined();
    // Журнал: заявку создал «Telegram».
    const journal = await s.t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((x) => x.action === "lead.create")).toMatchObject({ actorName: "Telegram", entityId: lead!._id });
  });

  test("повтор вебхука не дублирует ни сообщение, ни ответ бота", async () => {
    const s = await setup();
    const update = msg(778, "Не работает кондиционер");
    await s.t.action(internal.telegram.handleUpdate, update);
    await s.t.action(internal.telegram.handleUpdate, update);
    const [c] = await conversations(s);
    expect((await messagesOf(s, c!._id)).filter((m) => m.direction === "in")).toHaveLength(1);
    expect(sent.filter((x) => x.method === "sendMessage" && x.body.chat_id === "778")).toHaveLength(1);
  });

  test("номер текстом — заявка сразу, без кнопки", async () => {
    const s = await setup();
    await s.t.action(internal.telegram.handleUpdate, msg(779, "Сломался холодильник, мой номер 8 701 555 44 33"));
    const [lead] = await leads(s);
    expect(lead).toMatchObject({ source: "telegram", clientPhone: "77015554433" });
    expect(lead!.description).toContain("Сломался холодильник");
    expect(String(sent.at(-1)!.body.text)).toContain(`№${lead!.number}`);
  });

  test("повторное «Отправить номер» не создаёт вторую заявку", async () => {
    const s = await setup();
    const contact = { contact: { phone_number: "+77012223344", first_name: "Гульмира" } };
    await s.t.action(internal.telegram.handleUpdate, msg(780, "Нужна сборка шкафа"));
    await s.t.action(internal.telegram.handleUpdate, msg(780, undefined, contact));
    await s.t.action(internal.telegram.handleUpdate, msg(780, undefined, contact));
    const all = await leads(s);
    expect(all).toHaveLength(1);
    expect(String(sent.at(-1)!.body.text)).toContain("уже у оператора");
  });

  test("команда не заводит диалог, но ответ бота на неё пишется в уже идущий", async () => {
    const s = await setup();
    await s.t.action(internal.telegram.handleUpdate, msg(782, "/start"));
    expect(await conversations(s)).toHaveLength(0);
    await s.t.action(internal.telegram.handleUpdate, msg(782, "Нужен сантехник, течёт стояк"));
    await s.t.action(internal.telegram.handleUpdate, msg(782, "/help"));
    const [c] = await conversations(s);
    const last = (await messagesOf(s, c!._id)).at(-1)!;
    expect(last).toMatchObject({ direction: "out", kind: "system", status: "sent" });
    expect(last.text).toContain("Опишите, что случилось");
  });

  test("флуд из одного чата не разбирается", async () => {
    const s = await setup();
    await s.t.run((ctx) => ctx.db.insert("rateLimits", { key: "tg:chat:781", windowStart: Date.now(), count: 20 }));
    await s.t.action(internal.telegram.handleUpdate, msg(781, "Течёт кран"));
    expect(await conversations(s)).toHaveLength(0);
    expect(sent.filter((x) => x.method === "sendMessage")).toHaveLength(0);
  });
});

describe("заявка из переписки", () => {
  test("WhatsApp с номером: очередь сообщений → одна заявка с AI-разбором, источник whatsapp, автор в журнале — WhatsApp", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AI_URL", "https://ai.test");
    vi.stubEnv("AI_SECRET", "s");
    const s = await setup();
    await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Здравствуйте"));
    await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Течёт кран на кухне"));
    const last = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Алматы, Абая 10, можно сегодня?"));
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const all = await leads(s);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ source: "whatsapp", serviceId: "leak-fix", urgency: "high", clientPhone: "77019998877", clientName: "Айгерим" });
    expect(all[0]!.ai?.summary).toBe("Течёт кран на кухне");
    expect(all[0]!.comment).toContain("Алматы, Абая 10");
    const c = (await s.t.run((ctx) => ctx.db.get(last.conversationId)))!;
    expect(c.leadId).toBe(all[0]!._id);
    const journal = await s.t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((x) => x.action === "lead.create")).toMatchObject({ actorName: "WhatsApp", entityId: all[0]!._id });
    // Следующие сообщения — к той же заявке, вторая не создаётся.
    await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Ещё нужно поменять смеситель"));
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await leads(s)).toHaveLength(1);
  });

  test("без AI заявка всё равно создаётся — с текстом клиента и услугой «уточнить»", async () => {
    vi.useFakeTimers();
    const s = await setup();
    await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Нужно собрать шкаф из Икеи"));
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    const [lead] = await leads(s);
    expect(lead).toMatchObject({ source: "whatsapp", serviceId: "other", description: "Нужно собрать шкаф из Икеи" });
    expect(lead!.ai).toBeUndefined();
  });

  test("без номера (OLX), из «Здравствуйте» и при активном заказе клиента — заявка не создаётся", async () => {
    vi.useFakeTimers();
    const s = await setup();
    await s.t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-9", text: "Здравствуйте, нужен ремонт кондиционера", kind: "text" });
    await s.t.mutation(internal.inbox.ingest, wa("77019990000", "Здравствуйте"));
    await s.t.run(async (ctx) => {
      await ctx.db.insert("orders", {
        tenantId: T,
        number: 1001,
        clientId: s.ids.client,
        clientName: "Клиент Тест",
        clientPhone: "77071234567",
        source: "olx",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: new Date(Date.now() + 86400_000).toISOString(),
        priority: "normal",
        status: "in_progress",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        createdAt: new Date().toISOString(),
        createdBy: s.ids.owner,
        files: [],
      });
    });
    await s.t.mutation(internal.inbox.ingest, wa("77071234567", "Мастер опаздывает, когда будет?"));
    await s.t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await leads(s)).toHaveLength(0);
  });

  test("черновик для формы и связь созданной заявки с диалогом", async () => {
    vi.stubEnv("AI_URL", "https://ai.test");
    vi.stubEnv("AI_SECRET", "s");
    const s = await setup();
    const op = s.as(s.ids.operator);
    const o = await s.t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-5", contactName: "Айгерим", text: "Течёт кран на кухне, Алматы", kind: "text" });
    const d = await op.action(api.inbox.draftFromConversation, { id: o.conversationId });
    expect(d).toMatchObject({ channel: "olx", name: "Айгерим", text: "Течёт кран на кухне, Алматы", draft: { serviceId: "leak-fix", city: "Алматы" } });
    expect(d.ai?.summary).toBe("Течёт кран на кухне");
    await expect(s.as(s.ids.manager).action(api.inbox.draftFromConversation, { id: o.conversationId })).rejects.toThrow("Нет доступа");

    const lead = await op.mutation(api.leads.create, { clientName: "Айгерим", phone: "+7 701 444 55 66", source: "olx", serviceId: "leak-fix", city: "Алматы", description: "Течёт кран", urgency: "high" });
    await op.mutation(api.inbox.linkLead, { id: o.conversationId, leadId: lead.id });
    const c = (await s.t.run((ctx) => ctx.db.get(o.conversationId)))!;
    expect(c).toMatchObject({ leadId: lead.id, contactPhone: "77014445566" });
    expect(c.clientId).toBeDefined();
    expect(await op.query(api.inbox.forLead, { leadId: lead.id })).toEqual({ id: o.conversationId, channel: "olx" });
    expect(await s.as(s.ids.manager).query(api.inbox.forLead, { leadId: lead.id })).toBeNull();
    const journal = await s.t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.some((x) => x.action === "conversation.linkLead" && x.entityId === o.conversationId)).toBe(true);
  });
});

describe("доступ", () => {
  test("руководитель направления, мастер и гость не видят переписку и не могут отвечать", async () => {
    const s = await setup();
    const w = await s.t.mutation(internal.inbox.ingest, wa("77019998877", "Течёт кран", { autoLead: false }));
    for (const who of [s.as(s.ids.manager), s.as(s.ids.executor)]) {
      await expect(who.query(api.inbox.list, { filter: "all", paginationOpts: page })).rejects.toThrow("Нет доступа");
      await expect(who.query(api.inbox.get, { id: w.conversationId })).rejects.toThrow("Нет доступа");
      await expect(who.mutation(api.inbox.reply, { conversationId: w.conversationId, text: "Привет" })).rejects.toThrow("Нет доступа");
      await expect(who.mutation(api.inbox.markRead, { id: w.conversationId })).rejects.toThrow("Нет доступа");
      await expect(who.mutation(api.inbox.close, { id: w.conversationId })).rejects.toThrow("Нет доступа");
      expect(await who.query(api.inbox.unreadCount, {})).toBeNull();
    }
    await expect(s.t.query(api.inbox.list, { filter: "all", paginationOpts: page })).rejects.toThrow("Нужно войти");
    await expect(s.t.mutation(api.inbox.reply, { conversationId: w.conversationId, text: "Привет" })).rejects.toThrow("Нужно войти");
  });
});
