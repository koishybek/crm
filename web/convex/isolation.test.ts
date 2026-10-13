/// <reference types="vite/client" />
// «Мастер видит только своё; приватность файлов»: справочник без денег для мастера (аудит H-2, E14), аудитории сообщений
// заказа (M-6, E15, L-6), файлы «Показать мастеру», AI без адреса и бюджета в описании (H-3), окно контактов (L-5),
// подписанные ссылки на файлы (M-10, E16) и проверка загрузок на сервере (M-10, E21).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { toSummary, type Extraction } from "./ai";
import { scrub } from "./backup";
import { hmacSha256Hex, sha256Hex } from "./lib/crypto";
import { checkFileLink, fileSignature, FILE_URL_TTL_S, parseFileLink, parseRange } from "./lib/files";
import { DEFAULT_SERVICES } from "../src/data/catalog";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const SITE = "https://test.convex.site";
const MB = 1024 * 1024;
/** convex-test не хранит тип загрузки (Convex берёт его из Content-Type) — проставляем, как сделал бы сервер. */
type RawDb = { patch: (id: string, value: Record<string, unknown>) => Promise<void> };
type Sent = { url: string; body: Record<string, unknown> };
let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return Response.json({ ok: true, result: {} });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup() {
  vi.stubEnv("FILES_SIGNING_KEY", "test-files-signing-key");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  const t = convexTest(schema, modules);
  const at = new Date().toISOString();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const mk = async (name: string, phone: string) => {
      const ex = await ctx.db.insert("executors", { tenantId: T, name, phone, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: ex, tenantId: T, active: true });
      return { ex, user };
    };
    const a = await mk("Асет Мастеров", "77000000001");
    const b = await mk("Берик Мастеров", "77000000002");
    const orphan = await ctx.db.insert("users", { name: "Без профиля", email: "77000000009", role: "executor", tenantId: T, active: true });
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
      description: "Не холодит кондиционер",
      city: "Алматы",
      address: "ул. Абая, 10, кв. 5",
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      priority: "normal",
      status: "accepted",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      executorId: a.ex,
      assignedAt: at,
      createdAt: at,
      createdBy: owner,
      files: [],
    });
    return { owner, operator, a, b, orphan, client, order };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });
  /** Файл «из браузера»: в хранилище с типом и размером, как их запишет Convex. */
  const store = (type: string, opts: { size?: number; body?: string } = {}) =>
    t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob([opts.body ?? "data"], { type }));
      await (ctx.db as unknown as RawDb).patch(id, { contentType: type, ...(opts.size ? { size: opts.size } : {}) });
      return id;
    });
  /** Загрузка и подтверждение (files.confirmUpload) — как это делает uploadFile на фронте. */
  const upload = async (userId: Id<"users">, type: string, opts: { size?: number; body?: string } = {}) => {
    const storageId = await store(type, opts);
    const r = await as(userId).mutation(api.files.confirmUpload, { storageId });
    if (!r.ok) throw new Error(r.error);
    return storageId;
  };
  const exists = (id: Id<"_storage">) => t.run(async (ctx) => (await ctx.storage.get(id)) !== null);
  return { t, ids, as, store, upload, exists };
}

// ── 1. Справочник по ролям ───────────────────────────────────────────────────

describe("справочник: мастеру — без денег (аудит H-2, E14)", () => {
  test("мастер получает подписи, значки, направления и навыки, но не цены и не долю исполнителя; сотрудник — всё", async () => {
    const { ids, as } = await setup();
    const forExec = (await as(ids.a.user).query(api.catalog.list, {}))!;
    expect(forExec.services.length).toBeGreaterThan(20);
    for (const s of forExec.services) {
      expect(s).not.toHaveProperty("price");
      expect(s).not.toHaveProperty("payoutPct");
    }
    expect(JSON.stringify(forExec)).not.toMatch(/price|payoutPct/);
    expect(forExec.services.find((s) => s.id === "ac-repair")).toMatchObject({ label: "Ремонт кондиционера", icon: "snowflake", category: "ac" });
    expect(forExec.categories.find((c) => c.id === "ac")?.skills?.length).toBeGreaterThan(0);

    const forStaff = (await as(ids.operator).query(api.catalog.list, {}))!;
    expect(forStaff.services.find((s) => s.id === "ac-repair")).toMatchObject({ price: [20000, 35000], payoutPct: 70 });
  });

  test("цены, сохранённые владельцем, мастеру тоже не уходят; в публичном бандле справочник по умолчанию без денег", async () => {
    const { ids, as } = await setup();
    const key = await as(ids.owner).mutation(api.catalog.saveService, { category: "ac", label: "Демонтаж", icon: "snowflake", priceMin: 5000, priceMax: 9000, payoutPct: 64, examples: [], active: true });
    const forExec = (await as(ids.a.user).query(api.catalog.list, {}))!;
    expect(forExec.services.find((s) => s.id === key)).toEqual({ id: key, category: "ac", label: "Демонтаж", icon: "snowflake", examples: [], active: true });
    expect(DEFAULT_SERVICES.every((s) => s.price[0] === 0 && s.price[1] === 0 && s.payoutPct === 0)).toBe(true);
  });
});

// ── 2. Аудитории сообщений и файлы ───────────────────────────────────────────

describe("сообщения заказа: мастеру — только «С мастером» (аудит M-6, E15, L-6)", () => {
  test("мастер не видит внутренние заметки, переписку по клиенту и сообщения другого мастера; сотрудник видит всё", async () => {
    const { t, ids, as } = await setup();
    await t.run(async (ctx) => {
      const msg = (author: Id<"users">, channel: "internal" | "client" | "executor", text: string, at: string) =>
        ctx.db.insert("messages", { orderId: ids.order, author: { type: "user", id: author }, channel, text, files: [], at });
      await msg(ids.operator, "internal", "Маржа 9 000, мастеру не говорить", "2026-10-01T05:00:00.000Z");
      await msg(ids.operator, "client", "Клиент просит скидку", "2026-10-01T05:01:00.000Z");
      await msg(ids.b.user, "executor", "Клиент грубил, отказываюсь", "2026-10-01T05:02:00.000Z");
      await msg(ids.operator, "executor", "Захватите стремянку", "2026-10-01T05:03:00.000Z");
      await msg(ids.a.user, "executor", "Буду через 15 минут", "2026-10-01T05:04:00.000Z");
    });
    const w = (await as(ids.a.user).query(api.worker.order, { id: ids.order }))!;
    expect(w.messages.map((m) => m.text)).toEqual(["Захватите стремянку", "Буду через 15 минут"]);
    const view = await as(ids.a.user).query(api.executorApp.order, { id: ids.order });
    if (view.state !== "mine") throw new Error("ожидали свой заказ");
    expect(view.notes.map((n) => [n.text, n.mine, n.author])).toEqual([
      ["Захватите стремянку", false, "Мадина"],
      ["Буду через 15 минут", true, undefined],
    ]);
    const raw = JSON.stringify([w, view]);
    for (const leak of ["Маржа", "скидку", "грубил"]) expect(raw).not.toContain(leak);
    expect((await as(ids.operator).query(api.orders.detail, { id: ids.order }))!.messages).toHaveLength(5);
  });

  test("мастер пишет только в «С мастером»; о сообщении офиса мастеру он узнаёт, о внутренней заметке — нет", async () => {
    const { t, ids, as } = await setup();
    for (const channel of ["internal", "client"] as const) {
      await expect(as(ids.a.user).mutation(api.orders.addMessage, { orderId: ids.order, text: "Пишу не туда", channel, files: [] })).rejects.toThrow("только в переписку с офисом");
    }
    await as(ids.a.user).mutation(api.orders.addMessage, { orderId: ids.order, text: "На месте", channel: "executor", files: [] });
    await as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "Маржа 9 000", channel: "internal", files: [] });
    await as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "Клиент ждёт к 18:00", channel: "executor", files: [] });
    const bell = (userId: Id<"users">) =>
      t.run(async (ctx) => (await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", userId)).collect()).map((n) => n.text));
    expect(await bell(ids.a.user)).toEqual(["Офис написал по заказу №1001: «Клиент ждёт к 18:00»"]);
    expect(await bell(ids.operator)).toContain("Мастер написал по заказу №1001");
    const stored = await t.run((ctx) => ctx.db.query("messages").collect());
    expect(stored.find((m) => m.text === "На месте")?.channel).toBe("executor");
  });

  test("учётка мастера без профиля не пишет в заказ без мастера (аудит L-6)", async () => {
    const { t, ids, as } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.order, { executorId: undefined, status: "awaiting_executor" }));
    await expect(as(ids.orphan).mutation(api.orders.addMessage, { orderId: ids.order, text: "Привет", channel: "executor", files: [] })).rejects.toThrow("Это не ваш заказ");
  });
});

describe("файлы заказа: мастер видит только отмеченные «Показать мастеру»", () => {
  test("счёт во внутренней заметке мастеру не виден, схема из переписки с ним — видна; «Показать мастеру» открывает файл и пишется в журнал", async () => {
    const { t, ids, as, upload } = await setup();
    const invoice = await upload(ids.operator, "image/jpeg");
    await as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "Счёт клиенту 30 000", channel: "internal", files: [{ storageId: invoice, name: "счёт.jpg" }] });
    const scheme = await upload(ids.operator, "application/pdf");
    await as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "Схема монтажа", channel: "executor", files: [{ storageId: scheme, name: "схема.pdf" }] });

    const mine = async () => {
      const v = await as(ids.a.user).query(api.executorApp.order, { id: ids.order });
      if (v.state !== "mine") throw new Error("ожидали свой заказ");
      return v;
    };
    let view = await mine();
    expect(view.photos).toEqual([]);
    expect(view.documents).toEqual([]); // схема — в переписке, не дублируется
    expect(view.notes[0]!.files.map((f) => f.name)).toEqual(["схема.pdf"]);
    expect(view.notes[0]!.files[0]!.url).toMatch(/\/files\/.+&name=/);
    expect(JSON.stringify(view)).not.toContain("счёт");
    const w = (await as(ids.a.user).query(api.worker.order, { id: ids.order }))!;
    expect(w.order.files.map((f) => f.name)).toEqual(["схема.pdf"]);

    const files = (await t.run((ctx) => ctx.db.get(ids.order)))!.files;
    const invoiceId = files.find((f) => f.name === "счёт.jpg")!.id;
    const schemeId = files.find((f) => f.name === "схема.pdf")!.id;
    expect(files.map((f) => [f.name, f.forExecutor === true])).toEqual([
      ["счёт.jpg", false],
      ["схема.pdf", true],
    ]);
    await expect(as(ids.a.user).mutation(api.orders.setFileForExecutor, { orderId: ids.order, fileId: invoiceId, forExecutor: true })).rejects.toThrow("Нет доступа");
    await expect(as(ids.operator).mutation(api.orders.setFileForExecutor, { orderId: ids.order, fileId: schemeId, forExecutor: false })).rejects.toThrow("уже видит");

    await as(ids.operator).mutation(api.orders.setFileForExecutor, { orderId: ids.order, fileId: invoiceId, forExecutor: true });
    view = await mine();
    expect(view.photos.map((p) => p.name)).toEqual(["счёт.jpg"]);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.filter((a) => a.action === "order.fileAccess")).toEqual([expect.objectContaining({ actorId: ids.operator, entityId: ids.order, meta: { fileId: invoiceId, forExecutor: true } })]);

    const staff = (await as(ids.operator).query(api.orders.detail, { id: ids.order }))!;
    expect(staff.order.files.map((f) => f.forExecutor)).toEqual([true, true]);
    expect(staff.messages.find((m) => m.channel === "internal")!.files[0]!.forExecutor).toBe(true);

    await as(ids.operator).mutation(api.orders.setFileForExecutor, { orderId: ids.order, fileId: invoiceId, forExecutor: false });
    expect((await mine()).photos).toEqual([]);
  });

  test("перенос старых данных: сообщения мастера из «внутреннего» — в «С мастером», фото клиента — «показаны мастеру», остальное — как было", async () => {
    vi.useFakeTimers();
    const { t, ids, as } = await setup();
    const file = (id: string, kind: "image" | "file") => ({ id, name: `${id}.${kind === "image" ? "jpg" : "pdf"}`, kind });
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.order, { files: [file("own", "image"), file("client-photo", "image"), file("client-doc", "file"), file("invoice", "image"), { ...file("hidden", "image"), forExecutor: false }] });
      const msg = (author: Id<"users">, channel: "internal" | "client", files: ReturnType<typeof file>[], text: string) =>
        ctx.db.insert("messages", { orderId: ids.order, author: { type: "user", id: author }, channel, text, files, at: new Date().toISOString() });
      await msg(ids.a.user, "internal", [file("own", "image")], "Фотоотчёт");
      await msg(ids.operator, "client", [file("client-photo", "image"), file("client-doc", "file"), file("hidden", "image")], "Фото от клиента");
      await msg(ids.operator, "internal", [file("invoice", "image")], "Счёт");
    });
    await t.mutation(internal.files.migrateExecutorChannel, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const order = (await t.run((ctx) => ctx.db.get(ids.order)))!;
    expect(order.files.map((f) => [f.id, f.forExecutor])).toEqual([
      ["own", true],
      ["client-photo", true],
      ["client-doc", undefined],
      ["invoice", undefined],
      ["hidden", false],
    ]);
    const view = await as(ids.a.user).query(api.executorApp.order, { id: ids.order });
    if (view.state !== "mine") throw new Error("ожидали свой заказ");
    expect(view.notes.map((n) => [n.text, n.mine])).toEqual([["Фотоотчёт", true]]);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((x) => x.action === "system.migration")?.summary).toBe("Переписка мастеров перенесена в канал «С мастером»: сообщений 1, файлов показано мастерам 2");
  });

  test("фотоотчёт мастера виден ему сразу; в превью ленты — только фото, отмеченные для мастера", async () => {
    const { t, ids, as, upload } = await setup();
    const shot = await upload(ids.a.user, "image/jpeg");
    await as(ids.a.user).mutation(api.orders.addMessage, { orderId: ids.order, text: "Готово", channel: "executor", files: [{ storageId: shot, name: "готово.jpg" }] });
    expect((await t.run((ctx) => ctx.db.get(ids.order)))!.files).toEqual([expect.objectContaining({ name: "готово.jpg", kind: "image", storageId: shot, forExecutor: true })]);

    const internalPhoto = await upload(ids.operator, "image/png");
    const shownPhoto = await upload(ids.operator, "image/png");
    const open = await t.run(async (ctx) => {
      const base = (await ctx.db.get(ids.order))!;
      const { _id: _i, _creationTime: _c, ...copy } = base;
      void _i;
      void _c;
      return ctx.db.insert("orders", {
        ...copy,
        number: 1002,
        status: "awaiting_executor",
        executorId: undefined,
        assignedAt: undefined,
        files: [
          { id: "f-int", name: "чек.png", kind: "image", storageId: internalPhoto },
          { id: "f-ok", name: "кондиционер.png", kind: "image", storageId: shownPhoto, forExecutor: true },
        ],
      });
    });
    const extras = await as(ids.b.user).query(api.executorApp.feedExtras, {});
    const card = extras.find((x) => x.id === open)!;
    expect(card.photos).toBe(1);
    expect(card.thumbUrl).toContain(`/files/${shownPhoto}?`);
  });
});

// ── 3. AI не отдаёт мастеру адрес и бюджет ───────────────────────────────────

describe("AI-разбор: адрес и бюджет — не в описании заказа (аудит H-3)", () => {
  const x: Extraction = {
    summary: "Не холодит кондиционер",
    serviceId: "ac-repair",
    city: "Алматы",
    address: "мкр. Самал-2, д. 58",
    when: "завтра после 18:00",
    budget: 15000,
    urgency: "normal",
    clientName: "Аружан",
    questions: [],
  };

  test("описание — только суть; адрес — в черновике; бюджет и время — в AI-блоке для сотрудников", () => {
    const { ai, draft } = toSummary(x, () => "Ремонт кондиционера");
    expect(draft.description).toBe("Не холодит кондиционер");
    expect(draft.address).toBe("мкр. Самал-2, д. 58");
    expect(ai.extracted.map((e) => e.label)).toEqual(expect.arrayContaining(["Адрес", "Когда", "Бюджет"]));
  });

  test("заявка из бота: адрес — полем заявки, не в описании; в ленте мастера его нет, в заказе — только после подтверждения", async () => {
    const { t, ids, as } = await setup();
    const { ai, draft } = toSummary(x, () => "Ремонт кондиционера");
    const res = await t.mutation(internal.bot._createLead, {
      chatId: "777",
      phone: "+7 701 555 66 77",
      name: "Аружан",
      ai,
      serviceId: draft.serviceId,
      city: draft.city,
      address: draft.address,
      urgency: draft.urgency,
      description: draft.description,
      preferredTime: draft.when,
      budget: draft.budget,
    });
    if (!res.ok) throw new Error("заявка не создана");
    const lead = (await t.run((ctx) => ctx.db.query("leads").withIndex("by_number", (q) => q.eq("number", res.number)).unique()))!;
    expect(lead.description).toBe("Не холодит кондиционер");
    // Адрес, удобное время и бюджет — структурными полями заявки (ТЗ п.8.3), а не текстом в комментарии.
    expect(lead).toMatchObject({ address: "мкр. Самал-2, д. 58", preferredTime: "завтра после 18:00", budget: 15000 });
    expect(lead.comment ?? "").not.toContain("Самал");

    const created = await as(ids.operator).mutation(api.leads.convert, { id: lead._id });
    await as(ids.operator).mutation(api.orders.updateFinance, { id: created.id, clientPrice: 30000, payoutMode: "fixed", payoutValue: 20000, payoutPaid: false });
    await as(ids.operator).mutation(api.orders.changeStatus, { id: created.id, to: "awaiting_executor" });
    const feed = await as(ids.b.user).query(api.worker.feed, {});
    const card = feed.feed.find((o) => o.id === created.id)!;
    expect(card.description).toBe("Не холодит кондиционер");
    expect(JSON.stringify(feed)).not.toMatch(/Самал|15 ?000|Бюджет/);
  });

  test("старое AI-описание с «Адрес: …» и «Бюджет клиента: …» мастер не видит; телефон в тексте — только с открытыми контактами", async () => {
    const { t, ids, as } = await setup();
    const legacy = "Не холодит кондиционер. Адрес: ул. Абая, 10. Когда: завтра после 18:00. Бюджет клиента: 15 000 ₸. Перезвонить +7 701 555 66 77";
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.order, { status: "awaiting_executor", executorId: undefined, assignedAt: undefined, description: legacy });
      await ctx.db.patch(ids.b.user, { telegramChatId: "555" });
    });
    const feed = await as(ids.b.user).query(api.worker.feed, {});
    expect(feed.feed[0]!.description).toBe("Не холодит кондиционер. Когда: завтра после 18:00. Перезвонить [номер скрыт]");
    const tg = await t.query(internal.worker._forChat, { chatId: "555", what: "feed" });
    expect(tg.cards[0]!.description).not.toMatch(/Абая|Бюджет|701/);

    await as(ids.b.user).mutation(api.worker.take, { id: ids.order });
    const mine = (await as(ids.b.user).query(api.worker.order, { id: ids.order }))!;
    expect(mine.order.description).toBe("Не холодит кондиционер. Когда: завтра после 18:00. Перезвонить +7 701 555 66 77");
    // Сотрудник видит описание как есть.
    expect((await as(ids.operator).query(api.orders.detail, { id: ids.order }))!.order.description).toBe(legacy);
  });
});

// ── 4. Окно контактов ────────────────────────────────────────────────────────

describe("контакты клиента — пока заказ у мастера в работе (аудит L-5)", () => {
  const OPEN = ["accepted", "in_progress", "awaiting_client", "done", "awaiting_payment"] as const;
  const CLOSED = ["assigned", "paid", "closed", "cancelled", "refund"] as const;

  test("адрес и телефон есть после подтверждения и до оплаты; у назначенного, оплаченного, закрытого, отменённого и возврата — нет", async () => {
    const { t, ids, as } = await setup();
    for (const status of [...OPEN, ...CLOSED]) {
      await t.run((ctx) => ctx.db.patch(ids.order, { status }));
      const open = (OPEN as readonly string[]).includes(status);
      const w = (await as(ids.a.user).query(api.worker.order, { id: ids.order }))!;
      const app = await as(ids.a.user).query(api.executorApp.order, { id: ids.order });
      const list = await as(ids.a.user).query(api.worker.mine, {});
      if (app.state !== "mine") throw new Error("ожидали свой заказ");
      for (const o of [w.order, app.order, list.orders[0]!]) {
        expect([status, o.address, o.clientPhone, o.clientName]).toEqual(open ? [status, "ул. Абая, 10, кв. 5", "77071234567", "Клиент Тест"] : [status, undefined, undefined, undefined]);
      }
    }
  });

  test("Telegram /orders и утренняя сводка: у неподтверждённого заказа адреса нет", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-12T04:00:00Z")); // 9:00 по Алматы
    const { t, ids } = await setup();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.a.user, { telegramChatId: "555" });
      const base = (await ctx.db.get(ids.order))!;
      const { _id: _i, _creationTime: _c, ...copy } = base;
      void _i;
      void _c;
      const soon = new Date(Date.now() + 3600_000).toISOString();
      await ctx.db.patch(ids.order, { deadline: soon });
      await ctx.db.insert("orders", { ...copy, number: 1002, status: "assigned", address: "ул. Секретная, 1", deadline: soon });
    });
    const chat = await t.query(internal.worker._forChat, { chatId: "555", what: "orders" });
    expect(chat.cards.map((c) => [c.number, c.address])).toEqual([
      [1001, "ул. Абая, 10, кв. 5"],
      [1002, undefined],
    ]);
    await t.mutation(internal.digest.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const digest = String(sent.find((s) => s.body.chat_id === "555")?.body.text);
    expect(digest).toContain("№1001");
    expect(digest).toContain("Абая");
    expect(digest).toContain("№1002");
    expect(digest).not.toContain("Секретная");
  });
});

// ── 5. Подписанные ссылки ────────────────────────────────────────────────────

describe("подписанные ссылки на файлы (аудит M-10, E16)", () => {
  test("HMAC-SHA256 по RFC 4231 и прежний SHA-256", async () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // Ключ длиннее блока (64 байта) сначала хэшируется — сверяем с Web Crypto.
    const key = "k".repeat(100);
    const raw = await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode("ссылка"));
    expect(hmacSha256Hex(key, "ссылка")).toBe(Array.from(new Uint8Array(raw), (b) => b.toString(16).padStart(2, "0")).join(""));
  });

  test("подпись: верная — да; истёкшая, подделанная, чужой файл, срок дальше выдаваемого и без ключа — нет", () => {
    const now = Date.parse("2026-10-12T04:00:00Z");
    const exp = now / 1000 + 600;
    const link = { storageId: "kg2abc", exp, name: "", sig: fileSignature("key", "kg2abc", exp, "") };
    expect(checkFileLink(link, "key", now)).toBe("ok");
    expect(checkFileLink(link, "key", now + 601_000)).toBe("expired");
    expect(checkFileLink({ ...link, sig: link.sig.replace(/^./, (c) => (c === "0" ? "1" : "0")) }, "key", now)).toBe("invalid");
    expect(checkFileLink({ ...link, storageId: "kg2abd" }, "key", now)).toBe("invalid");
    expect(checkFileLink({ ...link, name: "другое.pdf" }, "key", now)).toBe("invalid");
    expect(checkFileLink(link, "other-key", now)).toBe("invalid");
    expect(checkFileLink(link, null, now)).toBe("invalid");
    const far = now / 1000 + FILE_URL_TTL_S * 10;
    expect(checkFileLink({ ...link, exp: far, sig: fileSignature("key", "kg2abc", far, "") }, "key", now)).toBe("invalid");
    expect(parseFileLink(new URL(`${SITE}/files/kg2abc?exp=${exp}&sig=${link.sig}`))).toEqual(link);
    expect(parseFileLink(new URL(`${SITE}/files/../secret?exp=1&sig=${link.sig}`))).toBeNull();
    expect(parseFileLink(new URL(`${SITE}/files/kg2abc?exp=soon&sig=${link.sig}`))).toBeNull();
  });

  test("Range: один диапазон, хвост, открытый — кусками; несколько и мусор — весь файл; за концом — 416", () => {
    expect(parseRange(null, 10)).toBeNull();
    expect(parseRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange("bytes=2-50", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=0-", 100 * MB)).toEqual({ start: 0, end: 8 * MB - 1 });
    expect(parseRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(parseRange("bytes=5-2", 10)).toBeNull();
    expect(parseRange("items=0-1", 10)).toBeNull();
    expect(parseRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 10)).toBe("unsatisfiable");
  });

  test("ссылка из карточки заказа отдаёт файл (целиком и по Range); подделка, чужой файл и истёкшая — 403", async () => {
    const { ids, as, upload, t } = await setup();
    const photo = await upload(ids.operator, "image/jpeg", { body: "0123456789" });
    const other = await upload(ids.operator, "image/jpeg", { body: "другое" });
    await as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "", channel: "internal", files: [{ storageId: photo, name: "фото.jpg" }] });
    const src = (await as(ids.operator).query(api.orders.detail, { id: ids.order }))!.order.files[0]!.src!;
    expect(src).toMatch(new RegExp(`^${SITE}/files/${photo}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    const path = src.slice(SITE.length);

    const full = await t.fetch(path);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/jpeg");
    expect(full.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
    expect(Number(full.headers.get("cache-control")!.split("=")[1])).toBeLessThanOrEqual(FILE_URL_TTL_S);
    expect(full.headers.get("x-content-type-options")).toBe("nosniff");
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(full.headers.get("content-disposition")).toBe("inline");
    expect(await full.text()).toBe("0123456789");

    const part = await t.fetch(path, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("content-length")).toBe("4");
    expect(await part.text()).toBe("2345");
    const tail = await t.fetch(path, { headers: { Range: "bytes=-3" } });
    expect([tail.status, tail.headers.get("content-range"), await tail.text()]).toEqual([206, "bytes 7-9/10", "789"]);
    const beyond = await t.fetch(path, { headers: { Range: "bytes=20-" } });
    expect([beyond.status, beyond.headers.get("content-range")]).toEqual([416, "bytes */10"]);

    const sig = /sig=([0-9a-f]+)/.exec(path)![1]!;
    expect((await t.fetch(path.replace(sig, sig.replace(/^./, (c) => (c === "0" ? "1" : "0"))))).status).toBe(403);
    expect((await t.fetch(path.replace(String(photo), String(other)))).status).toBe(403);
    expect((await t.fetch(`/files/${photo}`)).status).toBe(403);

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 17 * 60_000);
    const expired = await t.fetch(path);
    expect(expired.status).toBe(403);
    expect(await expired.text()).toContain("устарела");
  });

  test("документ — скачиванием с именем файла и в песочнице; запись звонка — в карточке звонка подписанной ссылкой", async () => {
    const { ids, as, upload, t } = await setup();
    const doc = await upload(ids.operator, "application/msword");
    await as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "", channel: "internal", files: [{ storageId: doc, name: "Договор №5.doc" }] });
    const src = (await as(ids.operator).query(api.orders.detail, { id: ids.order }))!.order.files[0]!.src!;
    const res = await t.fetch(src.slice(SITE.length));
    expect(res.status).toBe(200);
    // Кириллица в запасном имени — подчёркиваниями, настоящее имя — в filename* (RFC 6266).
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="_______ _5.doc"; filename*=UTF-8''${encodeURIComponent("Договор №5.doc")}`);
    expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");

    const rec = await upload(ids.operator, "audio/mpeg");
    const callId = await as(ids.operator).mutation(api.calls.upload, { storageId: rec, autoLead: false });
    const card = (await as(ids.operator).query(api.calls.get, { id: callId }))!;
    expect(card.call.recordingSrc).toMatch(new RegExp(`^${SITE}/files/${rec}\\?exp=\\d+&sig=`));
    const list = await as(ids.operator).query(api.calls.list, {});
    expect(list[0]!.recordingSrc).toBeUndefined();
  });

  test("без FILES_SIGNING_KEY ключ создаётся при первой загрузке (или уборкой), клиентам не отдаётся и в копию не попадает", async () => {
    const { t, ids, as, store } = await setup();
    vi.stubEnv("FILES_SIGNING_KEY", "");
    const photo = await store("image/jpeg");
    await t.run(async (ctx) => {
      const o = (await ctx.db.get(ids.order))!;
      await ctx.db.patch(ids.order, { files: [...o.files, { id: "f-1", name: "фото.jpg", kind: "image", storageId: photo }] });
    });
    // Ключа ещё нет — ссылок нет (а не ссылок без подписи).
    expect((await as(ids.operator).query(api.orders.detail, { id: ids.order }))!.order.files[0]!.src).toBeUndefined();
    await as(ids.operator).mutation(api.files.confirmUpload, { storageId: await store("image/png") });
    const row = await t.run((ctx) => ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "filesSigningKey")).unique());
    expect(row!.value.length).toBeGreaterThanOrEqual(40);
    const src = (await as(ids.operator).query(api.orders.detail, { id: ids.order }))!.order.files[0]!.src!;
    expect((await t.fetch(src.slice(SITE.length))).status).toBe(200);
    expect(src).not.toContain(row!.value);
    expect(scrub("settings", { key: "filesSigningKey", value: row!.value })).toBeNull();

    const fresh = convexTest(schema, modules);
    await fresh.mutation(internal.files.maintain, {});
    expect(await fresh.run((ctx) => ctx.db.query("settings").withIndex("by_key", (q) => q.eq("key", "filesSigningKey")).unique())).not.toBeNull();
  });
});

// ── 6. Загрузки ──────────────────────────────────────────────────────────────

describe("загрузки: проверка на сервере (аудит M-10, E21)", () => {
  test("ссылок на загрузку — не больше 100 в час на пользователя", async () => {
    const { ids, as } = await setup();
    for (let i = 0; i < 100; i++) await as(ids.operator).mutation(api.orders.uploadUrl, {});
    await expect(as(ids.operator).mutation(api.orders.uploadUrl, {})).rejects.toThrow("Слишком много загрузок");
    expect(await as(ids.owner).mutation(api.orders.uploadUrl, {})).toContain("upload");
  });

  test("тип и размер по данным хранилища: HTML, SVG, большие фото, видео, аудио и документы — отказ, файл удалён", async () => {
    const { ids, as, store, exists } = await setup();
    const bad: [string, number, string][] = [
      ["text/html", 100, "не принимаем"],
      ["image/svg+xml", 100, "не принимаем"],
      ["application/zip", 100, "не принимаем"],
      ["image/jpeg", 15 * MB + 1, "до 15 МБ"],
      ["video/mp4", 100 * MB + 1, "до 100 МБ"],
      ["audio/mpeg", 25 * MB + 1, "до 25 МБ"],
      ["application/pdf", 25 * MB + 1, "до 25 МБ"],
    ];
    for (const [type, size, error] of bad) {
      const id = await store(type, { size });
      const r = await as(ids.operator).mutation(api.files.confirmUpload, { storageId: id });
      expect([type, r.ok, r.ok ? "" : r.error]).toEqual([type, false, expect.stringContaining(error)]);
      expect(await exists(id)).toBe(false);
    }
    const good: [string, number, string][] = [
      ["image/heic", 15 * MB, "image"],
      ["video/mp4", 100 * MB, "video"],
      ["audio/ogg", 25 * MB, "audio"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", 1000, "file"],
    ];
    for (const [type, size, kind] of good) {
      const r = await as(ids.operator).mutation(api.files.confirmUpload, { storageId: await store(type, { size }) });
      expect(r).toEqual({ ok: true, kind });
    }
  });

  test("чужая, неподтверждённая, старая и уже прикреплённая загрузка не прикрепляется", async () => {
    vi.useFakeTimers();
    const { ids, as, store, upload } = await setup();
    const mine = await upload(ids.operator, "image/jpeg");
    const attach = (userId: Id<"users">, storageId: Id<"_storage">, channel: "internal" | "executor" = "internal") =>
      as(userId).mutation(api.orders.addMessage, { orderId: ids.order, text: "", channel, files: [{ storageId, name: "фото.jpg" }] });
    // Чужую — ни прикрепить, ни «забрать» себе.
    await expect(attach(ids.owner, mine)).rejects.toThrow("Файл не найден");
    await expect(attach(ids.a.user, mine, "executor")).rejects.toThrow("Файл не найден");
    expect(await as(ids.owner).mutation(api.files.confirmUpload, { storageId: mine })).toEqual({ ok: false, error: expect.stringContaining("не найден") });
    // Без подтверждения — нельзя.
    await expect(attach(ids.operator, await store("image/jpeg"))).rejects.toThrow("Файл не найден");
    // Один раз.
    await attach(ids.operator, mine);
    await expect(attach(ids.operator, mine)).rejects.toThrow("уже прикреплён");
    // Подтвердить можно только свежую загрузку (час): старый id из ссылки не «забрать».
    const old = await store("image/jpeg");
    vi.setSystemTime(Date.now() + 61 * 60_000);
    expect((await as(ids.operator).mutation(api.files.confirmUpload, { storageId: old })).ok).toBe(false);
  });

  test("в звонок — только аудиозапись; у заказа — не больше 100 файлов", async () => {
    const { t, ids, as, upload } = await setup();
    const photo = await upload(ids.operator, "image/jpeg");
    await expect(as(ids.operator).mutation(api.calls.upload, { storageId: photo })).rejects.toThrow("аудиофайл");
    await t.run((ctx) => ctx.db.patch(ids.order, { files: Array.from({ length: 100 }, (_, i) => ({ id: `f-${i}`, name: `${i}.jpg`, kind: "image" as const })) }));
    await expect(as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "", channel: "internal", files: [{ storageId: photo, name: "ещё.jpg" }] })).rejects.toThrow(
      "больше 100",
    );
  });

  test("уборка: неприкреплённые загрузки старше суток удаляются вместе с файлом, прикреплённые остаются", async () => {
    vi.useFakeTimers();
    const { t, ids, as, upload, exists } = await setup();
    const used = await upload(ids.operator, "image/jpeg");
    const left = await upload(ids.operator, "image/jpeg");
    await as(ids.operator).mutation(api.orders.addMessage, { orderId: ids.order, text: "", channel: "internal", files: [{ storageId: used, name: "фото.jpg" }] });
    expect(await t.mutation(internal.files.maintain, {})).toEqual({ removed: 0 });
    vi.setSystemTime(Date.now() + 25 * 3600_000);
    expect(await t.mutation(internal.files.maintain, {})).toEqual({ removed: 1 });
    expect([await exists(used), await exists(left)]).toEqual([true, false]);
  });
});
