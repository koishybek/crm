/// <reference types="vite/client" />
// Удаление персональных данных клиента по его запросу (ТЗ п.26): только владелец и только с его телефоном;
// контакты, записи, расшифровки и переписка исчезают, номера заказов и деньги остаются.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { ANON_NAME, ERASED_TEXT } from "./lib/privacy";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const at = new Date().toISOString();
const PHONE = "77071234567";
const PII = ["Айгуль", "Сапарова", PHONE, "aigul@mail.kz", "Абая", "Звонить после 18", "холодит", "Асет молодец"];
const AI = { summary: "Не холодит кондиционер у Айгуль", extracted: [{ label: "Адрес", value: "ул. Абая, 10" }], questions: [] };

async function setup(opts: { activeOrder?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 1, cooperation: "freelance", joinedAt: at });
    const file = (text: string) => ctx.storage.store(new Blob([text], { type: "audio/mpeg" }));
    const client = await ctx.db.insert("clients", {
      tenantId: T,
      name: "Айгуль Сапарова",
      kind: "person",
      phone: PHONE,
      email: "aigul@mail.kz",
      city: "Алматы",
      address: "ул. Абая, 10, кв. 5",
      source: "olx",
      preferredChannel: "whatsapp",
      tags: ["VIP"],
      notes: "Звонить после 18",
      createdAt: at,
      ordersCount: 1,
      activeCount: 0,
      lastActivityAt: at,
    });
    const other = await ctx.db.insert("clients", { tenantId: T, name: "Ерлан Другой", kind: "person", phone: "77019998877", city: "Алматы", source: "phone", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });

    const callFromLead = await ctx.db.insert("calls", { tenantId: T, direction: "in", from: PHONE, to: "77270000000", status: "completed", startedAt: at, recordingId: await file("rec-1"), transcript: "Не холодит кондиционер", ai: AI, aiStatus: "done" });
    // Звонок до того, как клиента завели в базу: ни клиента, ни заявки — только номер.
    const callUnlinked = await ctx.db.insert("calls", { tenantId: T, direction: "in", from: PHONE, to: "77270000000", status: "completed", startedAt: at, recordingId: await file("rec-2"), transcript: "Айгуль, перезвоните", aiStatus: "done" });
    const callOut = await ctx.db.insert("calls", { tenantId: T, direction: "out", from: "77270000000", to: PHONE, clientId: client, clientName: "Айгуль Сапарова", status: "completed", startedAt: at, aiStatus: "none" });
    const callPending = await ctx.db.insert("calls", { tenantId: T, direction: "in", from: PHONE, to: "77270000000", status: "completed", startedAt: at, aiStatus: "pending" });
    const otherCall = await ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77019998877", to: "77270000000", status: "completed", startedAt: at, transcript: "Другой клиент", aiStatus: "done" });

    const lead = await ctx.db.insert("leads", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Айгуль Сапарова",
      clientPhone: PHONE,
      source: "olx",
      serviceId: "ac-repair",
      city: "Алматы",
      description: "Не холодит кондиционер",
      urgency: "normal",
      status: "converted",
      operatorId: operator,
      createdAt: at,
      comment: "Айгуль просит утром",
      ai: AI,
      callId: callFromLead,
    });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Айгуль Сапарова",
      clientPhone: PHONE,
      leadId: lead,
      source: "olx",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит кондиционер",
      city: "Алматы",
      address: "ул. Абая, 10, кв. 5",
      deadline: at,
      priority: "normal",
      status: "paid",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [{ id: "p1", amount: 30000, method: "kaspi", at }],
      payoutPaid: true,
      executorId: ex,
      createdAt: at,
      createdBy: operator,
      files: [],
    });
    const active = opts.activeOrder
      ? await ctx.db.insert("orders", {
          tenantId: T,
          number: 1002,
          clientId: client,
          clientName: "Айгуль Сапарова",
          clientPhone: PHONE,
          source: "olx",
          serviceId: "ac-repair",
          category: "ac",
          description: "Ещё кондиционер",
          city: "Алматы",
          address: "ул. Абая, 10, кв. 5",
          deadline: at,
          priority: "normal",
          status: "in_progress",
          clientPrice: 20000,
          payoutMode: "fixed",
          payoutValue: 14000,
          payments: [],
          payoutPaid: false,
          createdAt: at,
          createdBy: operator,
          files: [],
        })
      : null;
    await ctx.db.insert("history", { orderId: order, kind: "edited", text: "Изменены данные заказа: адрес «ул. Абая, 10» → «ул. Абая, 10, кв. 5»", actor: { type: "user", id: operator }, at });

    const wa = await ctx.db.insert("conversations", { tenantId: T, channel: "whatsapp", externalId: PHONE, contactName: "Айгуль", contactPhone: PHONE, waUserId: "KZ.123", lastMessageAt: at, lastText: "Абая 10", lastDirection: "in", unread: 1, status: "open" });
    const waPhoto = await ctx.storage.store(new Blob(["photo"], { type: "image/jpeg" }));
    await ctx.db.insert("conversationMessages", { conversationId: wa, direction: "in", kind: "text", text: "Адрес: ул. Абая 10", at, externalId: "whatsapp:wamid.77071234567" });
    await ctx.db.insert("conversationMessages", { conversationId: wa, direction: "in", kind: "image", text: "фото", at, fileId: waPhoto, fileName: "photo.jpg" });
    const olx = await ctx.db.insert("conversations", {
      tenantId: T,
      channel: "olx",
      externalId: "thread-1",
      contactName: "Айгуль",
      clientId: client,
      subject: "Ремонт кондиционеров",
      lastMessageAt: at,
      lastText: "Не холодит",
      lastDirection: "in",
      unread: 0,
      status: "open",
      meta: { olx: { total: 1, unread: 0, interlocutorId: 555 } },
    });
    await ctx.db.insert("conversationMessages", { conversationId: olx, direction: "in", kind: "text", text: "Не холодит, Айгуль", at, externalId: "olx:m1" });
    const tg = await ctx.db.insert("conversations", { tenantId: T, channel: "telegram", externalId: "100500", contactName: "Айгуль", leadId: lead, lastMessageAt: at, lastText: "Здравствуйте", lastDirection: "in", unread: 0, status: "open" });
    await ctx.db.insert("conversationMessages", { conversationId: tg, direction: "in", kind: "text", text: "Здравствуйте, это Айгуль", at, externalId: "telegram:100500:1" });
    await ctx.db.insert("botChats", { chatId: "100500", state: "awaiting_phone", draft: "Не холодит", name: "Айгуль", updatedAt: at });

    await ctx.db.insert("clientNotes", { clientId: client, authorId: operator, text: "Звонить после 18", at });
    await ctx.db.insert("interactions", { clientId: client, kind: "message", channel: "olx", title: "Сообщение в OLX", text: "Не холодит, Айгуль", at });
    await ctx.db.insert("reviews", { tenantId: T, orderId: order, executorId: ex, clientId: client, rating: 5, text: "Спасибо, Асет молодец", via: "link", at });
    const pendingLink = await ctx.db.insert("reviewRequests", { token: "tok-pending", orderId: order, createdAt: at, expiresAt: at });
    const usedLink = await ctx.db.insert("reviewRequests", { token: "tok-used", orderId: order, createdAt: at, expiresAt: at, usedAt: at });
    await ctx.db.insert("rateLimits", { key: `site:phone:${PHONE}`, windowStart: Date.now(), count: 1 });
    return { owner, operator, client, other, lead, order, active, callFromLead, callUnlinked, callOut, callPending, otherCall, wa, waPhoto, olx, tg, pendingLink, usedLink };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as };
}

describe("удаление данных клиента: кто и с каким подтверждением", () => {
  test("оператору нельзя; неверный телефон — отказ; данные не тронуты", async () => {
    const { t, ids, as } = await setup();
    await expect(as(ids.operator).mutation(api.clients.anonymize, { clientId: ids.client, confirmPhone: PHONE })).rejects.toThrow("Нет доступа");
    await expect(as(ids.owner).mutation(api.clients.anonymize, { clientId: ids.client, confirmPhone: "+7 707 000 00 00" })).rejects.toThrow("Телефон не совпадает");
    const c = await t.run((ctx) => ctx.db.get(ids.client));
    expect(c).toMatchObject({ name: "Айгуль Сапарова", phone: PHONE, email: "aigul@mail.kz" });
    expect(c?.anonymizedAt).toBeUndefined();
  });

  test("пока заказ клиента в работе — сначала завершить или отменить", async () => {
    const { ids, as } = await setup({ activeOrder: true });
    await expect(as(ids.owner).mutation(api.clients.anonymize, { clientId: ids.client, confirmPhone: PHONE })).rejects.toThrow("Сначала завершите или отмените заказы клиента: №1002");
  });
});

describe("удаление данных клиента: что исчезает и что остаётся", () => {
  test("контакты, записи, расшифровки и переписка — удалены; номера, деньги и оценка — на месте", async () => {
    const { t, ids, as } = await setup();
    const n = await as(ids.owner).mutation(api.clients.anonymize, { clientId: ids.client, confirmPhone: "+7 (707) 123-45-67" });
    expect(n).toMatchObject({ leads: 1, orders: 1, calls: 4, recordings: 2, conversations: 3, messages: 4, files: 1, notes: 1, interactions: 1, reviews: 1 });

    const db = await t.run(async (ctx) => ({
      client: (await ctx.db.get(ids.client))!,
      other: (await ctx.db.get(ids.other))!,
      lead: (await ctx.db.get(ids.lead))!,
      order: (await ctx.db.get(ids.order))!,
      history: await ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", ids.order)).collect(),
      calls: await Promise.all([ids.callFromLead, ids.callUnlinked, ids.callOut, ids.callPending].map((id) => ctx.db.get(id))),
      otherCall: (await ctx.db.get(ids.otherCall))!,
      convs: await Promise.all([ids.wa, ids.olx, ids.tg].map(async (id) => ({ c: (await ctx.db.get(id))!, m: await ctx.db.query("conversationMessages").withIndex("by_conversation", (q) => q.eq("conversationId", id)).collect() }))),
      photo: (await ctx.storage.get(ids.waPhoto)) !== null,
      botChats: await ctx.db.query("botChats").collect(),
      notes: await ctx.db.query("clientNotes").collect(),
      interactions: await ctx.db.query("interactions").collect(),
      reviews: await ctx.db.query("reviews").collect(),
      links: await ctx.db.query("reviewRequests").collect(),
      limits: await ctx.db.query("rateLimits").collect(),
      audit: await ctx.db.query("audit").collect(),
    }));

    // Карточка: ни имени, ни контактов; телефон в базе — недозвонимая заглушка, уникальная для индекса.
    expect(db.client).toMatchObject({ name: ANON_NAME, tags: [] });
    expect(db.client.phone).toMatch(/^7000\d{7}$/);
    expect(db.client.email ?? db.client.address ?? db.client.notes ?? db.client.preferredChannel).toBeUndefined();
    expect(db.client.anonymizedAt).toBeDefined();
    expect(db.other).toMatchObject({ name: "Ерлан Другой", phone: "77019998877" });

    // Номера, услуги и деньги — на месте; имя, телефон, адрес и текст — нет.
    expect(db.lead).toMatchObject({ number: 1001, serviceId: "ac-repair", clientName: ANON_NAME, clientPhone: "", description: ERASED_TEXT, status: "converted" });
    expect(db.lead.comment ?? db.lead.ai).toBeUndefined();
    expect(db.order).toMatchObject({ number: 1001, clientPrice: 30000, payoutValue: 21000, payoutPaid: true, status: "paid", clientName: ANON_NAME, clientPhone: "", address: "", description: ERASED_TEXT });
    expect(db.order.payments).toEqual([{ id: "p1", amount: 30000, method: "kaspi", at }]);
    expect(db.history[0]!.text).toBe("Изменены данные заказа: адрес изменён");

    // Звонки — по заявке, по клиенту и по номеру: без записей, расшифровок и номера клиента.
    for (const call of db.calls) {
      expect(call?.recordingId ?? call?.transcript ?? call?.ai).toBeUndefined();
      expect(call?.clientId).toBe(ids.client);
    }
    expect(db.calls.map((c) => (c?.direction === "in" ? c.from : c?.to))).toEqual(["", "", "", ""]);
    expect(db.otherCall.transcript).toBe("Другой клиент");
    const leftRecordings = await t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).filter((f) => f._id !== ids.waPhoto).length);
    expect(leftRecordings).toBe(0);

    // Переписка: тексты и файлы удалены, диалоги отвязаны от клиента и закрыты.
    for (const { c, m } of db.convs) {
      expect(c).toMatchObject({ contactName: ANON_NAME, lastText: ERASED_TEXT, status: "closed", unread: 0 });
      expect(c.clientId ?? c.leadId ?? c.contactPhone ?? c.waUserId).toBeUndefined();
      for (const msg of m) expect(msg).toMatchObject({ text: ERASED_TEXT });
      expect(m.some((x) => x.fileId !== undefined)).toBe(false);
    }
    const [wa, olx, tg] = db.convs;
    expect(wa!.c.externalId).toBe(`erased:${ids.wa}`);
    expect(tg!.c.externalId).toBe(`erased:${ids.tg}`);
    expect(wa!.m.some((x) => x.externalId !== undefined)).toBe(false);
    expect(db.photo).toBe(false);
    expect(db.botChats).toEqual([]);
    // OLX: ключи треда и сообщений остаются, иначе синхронизация загрузила бы всю историю заново.
    expect(olx!.c.externalId).toBe("thread-1");
    expect(olx!.m[0]!.externalId).toBe("olx:m1");
    expect(olx!.c.meta).toEqual({ olx: { total: 1, unread: 0 } });

    expect(db.notes).toEqual([]);
    expect(db.interactions.map((i) => i.text)).toEqual([""]);
    expect(db.reviews[0]).toMatchObject({ rating: 5 });
    expect(db.reviews[0]!.text).toBeUndefined();
    expect(db.links.map((l) => l._id)).toEqual([ids.usedLink]);
    expect(db.limits).toEqual([]);

    // Журнал: факт и счётчики, без имени, телефона и текстов.
    const entry = db.audit.find((a) => a.action === "client.anonymized")!;
    expect(entry).toMatchObject({ entityId: ids.client, actorId: ids.owner });
    for (const s of PII) expect(JSON.stringify(entry)).not.toContain(s);

    // Наружу из базы — тоже ничего личного, и по старому номеру клиент не находится.
    const detail = await as(ids.owner).query(api.clients.detail, { id: ids.client });
    for (const s of PII) expect(JSON.stringify(detail)).not.toContain(s);
    expect(detail?.client.phone).toBe("");
    expect(await as(ids.owner).query(api.clients.byPhone, { phone: PHONE })).toBeNull();
    expect(await as(ids.owner).query(api.clients.list, { q: "+7 707 123 45 67" })).toEqual([]);
  });

  test("после удаления: повтор, правка карточки и опоздавший разбор звонка ничего не возвращают", async () => {
    const { t, ids, as } = await setup();
    await as(ids.owner).mutation(api.clients.anonymize, { clientId: ids.client, confirmPhone: PHONE });
    await expect(as(ids.owner).mutation(api.clients.anonymize, { clientId: ids.client, confirmPhone: PHONE })).rejects.toThrow("уже удалены");
    await expect(as(ids.operator).mutation(api.clients.addNote, { clientId: ids.client, text: "Новый комментарий" })).rejects.toThrow("Данные клиента удалены");
    await expect(as(ids.operator).mutation(api.clients.setTags, { id: ids.client, tags: ["VIP"] })).rejects.toThrow("Данные клиента удалены");

    // Разбор звонка шёл в момент удаления — расшифровка и скачанная запись не сохраняются.
    const late = await t.run((ctx) => ctx.storage.store(new Blob(["late"], { type: "audio/mpeg" })));
    await t.mutation(internal.calls._saveAi, { id: ids.callPending, status: "done", recordingId: late, transcript: "Айгуль, адрес Абая 10", ai: AI });
    const call = await t.run((ctx) => ctx.db.get(ids.callPending));
    expect(call?.transcript ?? call?.recordingId).toBeUndefined();
    expect(await t.run(async (ctx) => (await ctx.storage.get(late)) !== null)).toBe(false);

    // OLX прислал старое сообщение ещё раз — это повтор, текст не возвращается и нового диалога нет.
    const again = await t.mutation(internal.inbox.ingest, { channel: "olx", externalId: "thread-1", externalMessageId: "m1", text: "Не холодит, Айгуль", kind: "text" });
    expect(again.duplicate).toBe(true);
    const olxMessages = await t.run((ctx) => ctx.db.query("conversationMessages").withIndex("by_conversation", (q) => q.eq("conversationId", ids.olx)).collect());
    expect(olxMessages.map((m) => m.text)).toEqual([ERASED_TEXT]);
    expect(await t.run((ctx) => ctx.db.query("conversations").withIndex("by_channel_external", (q) => q.eq("channel", "olx")).collect())).toHaveLength(1);
  });
});
