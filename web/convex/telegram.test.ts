/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const at = new Date().toISOString();
type Sent = { method: string; body: Record<string, unknown> };
const AI_EXTRACT = { summary: "Стиральная машина не сливает воду", serviceId: "wm-repair", city: "Алматы", address: null, when: "сегодня после 19:00", budget: null, urgency: "high", clientName: "Ерлан", questions: ["Модель машины?"] };
let sent: Sent[] = [];
/** convex-test не хранит тип загрузки (Convex берёт его из Content-Type) — проставляем, как сделал бы сервер. */
type RawDb = { patch: (id: string, value: Record<string, unknown>) => Promise<void> };

beforeEach(() => {
  sent = [];
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "test_bot");
  vi.stubEnv("APP_URL", "https://app.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      // AI-сервис: расшифровка с «фантомом» Whisper на тишине и разбор.
      if (String(url).startsWith("https://ai.test/v1/transcribe")) return Response.json({ text: "Стиралка не сливает воду. Продолжение следует... Продолжение следует...", language: "ru", seconds: 60 });
      if (String(url).startsWith("https://ai.test/v1/extract")) return Response.json(AI_EXTRACT);
      const method = String(url).split("/").pop()!;
      sent.push({ method, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const texts = () => sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").map((s) => String(s.body.text));

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true, telegramChatId: "100" });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    // Ссылка привязки из кабинета: одноразовая, живёт 30 минут.
    const exUser = await ctx.db.insert("users", { name: "Асет Мастеров", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true, telegramLinkCode: "a".repeat(24), telegramLinkExpiresAt: Date.now() + 30 * 60_000 });
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
  return { t, ids };
}

// В Telegram id сообщения уникален внутри чата; повтор того же id — повтор вебхука, его бот пропускает.
let messageId = 0;
const msg = (chatId: number, text: string, extra: Record<string, unknown> = {}) => ({ update: { message: { message_id: ++messageId, chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Гульмира" }, text, ...extra } } });
const cb = (chatId: number, data: string) => ({ update: { callback_query: { id: "cb1", data, from: { id: chatId }, message: { message_id: 7, chat: { id: chatId } } } } });

describe("бот: сотрудники и мастера", () => {
  test("мастер привязывает Telegram по ссылке из кабинета", async () => {
    const { t, ids } = await setup();
    await t.action(internal.telegram.handleUpdate, msg(555, `/start ${"a".repeat(24)}`));
    const u = await t.run((ctx) => ctx.db.get(ids.exUser));
    expect(u?.telegramChatId).toBe("555");
    expect(u?.telegramLinkCode).toBeUndefined();
    expect(texts().join()).toContain("Telegram подключён");
  });

  test("мастер берёт заказ кнопкой и ведёт его до «выполнено»", async () => {
    const { t, ids } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.exUser, { telegramChatId: "555" }));
    await t.action(internal.telegram.handleUpdate, cb(555, `take:${ids.order}`));
    let o = await t.run((ctx) => ctx.db.get(ids.order));
    expect(o?.status).toBe("accepted");
    expect(o?.executorId).toBe(ids.ex);
    const edit = sent.find((s) => s.method === "editMessageText")!;
    expect(String(edit.body.text)).toContain("ул. Абая, 1"); // после взятия — адрес
    expect(JSON.stringify(edit.body.reply_markup)).toContain(`act:start:${ids.order}`);

    await t.action(internal.telegram.handleUpdate, cb(555, `act:start:${ids.order}`));
    await t.action(internal.telegram.handleUpdate, cb(555, `act:done:${ids.order}`));
    o = await t.run((ctx) => ctx.db.get(ids.order));
    expect(o?.status).toBe("done");
  });

  test("чужой Telegram не может взять заказ", async () => {
    const { t, ids } = await setup();
    await t.action(internal.telegram.handleUpdate, cb(999, `take:${ids.order}`));
    const o = await t.run((ctx) => ctx.db.get(ids.order));
    expect(o?.status).toBe("awaiting_executor");
    const answer = sent.find((s) => s.method === "answerCallbackQuery")!;
    expect(String(answer.body.text)).toContain("не привязан");
  });

  test("заказ уже взят в кабинете — кнопка в Telegram отвечает отказом", async () => {
    const { t, ids } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.exUser, { telegramChatId: "555" });
      const other = await ctx.db.insert("executors", { tenantId: T, name: "Другой", phone: "77000000002", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
      await ctx.db.patch(ids.order, { status: "accepted", executorId: other });
    });
    await t.action(internal.telegram.handleUpdate, cb(555, `take:${ids.order}`));
    expect(String(sent.find((s) => s.method === "answerCallbackQuery")!.body.text)).toContain("уже взял");
  });
});

describe("бот: заявки от клиентов", () => {
  test("текст → номер кнопкой → заявка в CRM; следующее сообщение — к этой заявке", async () => {
    const { t, ids } = await setup();
    await t.action(internal.telegram.handleUpdate, msg(777, "Течёт кран на кухне, Алматы"));
    expect(JSON.stringify(sent.at(-1)!.body.reply_markup)).toContain("request_contact");
    await t.action(internal.telegram.handleUpdate, msg(777, "", { text: undefined, contact: { phone_number: "+7 701 222 33 44", first_name: "Гульмира", user_id: 777 } }));
    const leads = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(leads).toHaveLength(1);
    expect(leads[0]!.source).toBe("telegram");
    expect(leads[0]!.clientPhone).toBe("77012223344");
    expect(leads[0]!.description).toContain("Течёт кран");
    expect(texts().at(-1)).toContain(`№${leads[0]!.number}`);
    // Владелец (Telegram привязан) получил уведомление о новой заявке.
    await t.finishAllScheduledFunctions(() => {});
    expect(sent.some((s) => s.method === "sendMessage" && s.body.chat_id === "100" && String(s.body.text).includes("из Telegram"))).toBe(true);

    await t.action(internal.telegram.handleUpdate, msg(777, "И ещё смеситель шатается"));
    const notes = await t.run((ctx) => ctx.db.query("interactions").collect());
    expect(notes.some((n) => n.text.includes("смеситель"))).toBe(true);
    expect(texts().at(-1)).toContain("Передали оператору");
    void ids;
  });
});

describe("телефония", () => {
  test("звонок от АТС находит клиента; пропущенный — уведомление", async () => {
    const { t, ids } = await setup();
    const id = await t.mutation(internal.calls._ingest, { event: "ringing", externalId: "c1", direction: "in", from: "+7 (707) 123-45-67", to: "77270000000" });
    let c = await t.run((ctx) => ctx.db.get(id));
    expect(c?.clientId).toBe(ids.client);
    expect(c?.status).toBe("ringing");
    await t.mutation(internal.calls._ingest, { event: "ended", externalId: "c1" });
    c = await t.run((ctx) => ctx.db.get(id));
    expect(c?.status).toBe("missed");
    const n = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(n.some((x) => x.text.includes("Пропущенный"))).toBe(true);
  });

  test("разбор AI с понятной услугой сам создаёт заявку и связывает её со звонком", async () => {
    const { t } = await setup();
    const id = await t.mutation(internal.calls._ingest, { event: "answered", externalId: "c2", direction: "in", from: "77015550000", to: "77270000000" });
    await t.mutation(internal.calls._saveAi, {
      id,
      status: "done",
      transcript: "Не холодит кондиционер",
      ai: { summary: "Не холодит кондиционер", extracted: [], questions: [] },
      draft: { serviceId: "ac-repair", city: "Алматы", urgency: "high", clientName: "Гульмира", description: "Не холодит кондиционер" },
      autoLead: true,
    });
    const c = await t.run((ctx) => ctx.db.get(id));
    expect(c?.leadId).toBeDefined();
    const lead = await t.run((ctx) => ctx.db.get(c!.leadId!));
    expect(lead?.source).toBe("phone");
    expect(lead?.callId).toBe(id);
    expect(lead?.ai?.summary).toBe("Не холодит кондиционер");
    expect(lead?.clientName).toBe("Гульмира");
  });

  test("вебхук без секрета или с неверным — отказ", async () => {
    const { t, ids } = await setup();
    const res = await t.fetch("/pbx/events", { method: "POST", body: JSON.stringify({ event: "ringing" }), headers: { "Content-Type": "application/json" } });
    expect(res.status).toBe(503); // секрет ещё не создан
    const secret = await t.withIdentity({ subject: `${ids.owner}|s` }).mutation(api.calls.regeneratePbxSecret, {});
    const bad = await t.fetch("/pbx/events?secret=nope", { method: "POST", body: JSON.stringify({ event: "ringing" }), headers: { "Content-Type": "application/json" } });
    expect(bad.status).toBe(403);
    const good = await t.fetch(`/pbx/events?secret=${secret}`, { method: "POST", body: "event=ringing&caller=87071234567&call_id=x9", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(good.status).toBe(200);
    const calls = await t.run((ctx) => ctx.db.query("calls").collect());
    expect(calls[0]?.clientId).toBe(ids.client);
  });
});

describe("запись звонка → AI", () => {
  test("из формы заявки AI только заполняет звонок, из раздела «Звонки» — сам создаёт заявку; звонок связывается с одной заявкой", async () => {
    vi.useFakeTimers();
    vi.stubEnv("AI_URL", "https://ai.test");
    vi.stubEnv("AI_SECRET", "s");
    const { t, ids } = await setup();
    const owner = t.withIdentity({ subject: `${ids.owner}|s` });
    // Запись загружена браузером и подтверждена (files.confirmUpload) — только такую можно отдать в звонок.
    const rec = async () => {
      const storageId = await t.run(async (ctx) => {
        const id = await ctx.storage.store(new Blob(["fake audio"], { type: "audio/mpeg" }));
        await (ctx.db as unknown as RawDb).patch(id, { contentType: "audio/mpeg" });
        return id;
      });
      await owner.mutation(api.files.confirmUpload, { storageId });
      return storageId;
    };
    const fromForm = await owner.mutation(api.calls.upload, { storageId: await rec(), phone: "+7 701 555 01 47", autoLead: false });
    const fromPage = await owner.mutation(api.calls.upload, { storageId: await rec(), phone: "77015550148" });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const form = await t.run((ctx) => ctx.db.get(fromForm));
    expect(form?.aiStatus).toBe("done");
    expect(form?.transcript).toBe("Стиралка не сливает воду."); // «Продолжение следует…» вырезано
    expect(form?.draft?.serviceId).toBe("wm-repair");
    expect(form?.leadId).toBeUndefined();

    const page = await t.run((ctx) => ctx.db.get(fromPage));
    const auto = await t.run((ctx) => ctx.db.get(page!.leadId!));
    expect(auto?.source).toBe("phone");
    expect(auto?.callId).toBe(fromPage);

    const input = { clientName: "Ерлан", phone: "77015550147", source: "phone" as const, serviceId: "wm-repair", city: "Алматы", description: "Не сливает воду", urgency: "high" as const, callId: fromForm };
    const first = await owner.mutation(api.leads.create, input);
    const second = await owner.mutation(api.leads.create, input);
    expect((await t.run((ctx) => ctx.db.get(fromForm)))?.leadId).toBe(first.id);
    expect((await t.run((ctx) => ctx.db.get(second.id)))?.callId).toBeUndefined();
  });
});

describe("утренняя сводка", () => {
  test("владельцу уходит сводка с деньгами, мастеру — заказы на сегодня", async () => {
    vi.useFakeTimers();
    // 9:00 по Алматы: «срок через час» гарантированно сегодня (около полуночи тест иначе плавал бы).
    vi.setSystemTime(new Date("2026-10-12T04:00:00Z"));
    const { t, ids } = await setup();
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.exUser, { telegramChatId: "555" });
      await ctx.db.patch(ids.order, { status: "accepted", executorId: ids.ex, deadline: new Date(Date.now() + 3600_000).toISOString() });
    });
    await t.mutation(internal.digest.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const toOwner = sent.find((s) => s.body.chat_id === "100");
    const toExec = sent.find((s) => s.body.chat_id === "555");
    expect(String(toOwner?.body.text)).toContain("маржа");
    expect(String(toExec?.body.text)).toContain("№1001");
  });
});
