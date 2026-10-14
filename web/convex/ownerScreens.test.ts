/// <reference types="vite/client" />
// Экраны владельца (ТЗ п.5): «Долги клиентов» на «Главной» — только владельцу, суммы по debt(); карточка клиента —
// «Звонки» (с записями по подписанным ссылкам), «Оплаты» и «Файлы».
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { clientPayments, clientPaymentTotals } from "../src/data/clientRecords";
import { debt } from "../src/data/logic";
import { debtDays } from "../src/data/receivables";
import type { Order } from "../src/data/types";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const SITE = "https://test.convex.site";
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString();
/** convex-test не хранит тип загрузки (Convex берёт его из Content-Type) — проставляем, как сделал бы сервер. */
type RawDb = { patch: (id: string, value: Record<string, unknown>) => Promise<void> };

afterEach(() => {
  vi.unstubAllEnvs();
});

async function setup() {
  vi.stubEnv("FILES_SIGNING_KEY", "test-files-signing-key");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: iso(now) });
    const exUser = await ctx.db.insert("users", { name: "Асет", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = (name: string, phone: string) => ctx.db.insert("clients", { tenantId: T, name, kind: "person", phone, city: "Алматы", source: "olx", tags: [], createdAt: iso(now), ordersCount: 0, activeCount: 0, lastActivityAt: iso(now) });
    const anna = await client("Анна Долгова", "77071112233");
    const boris = await client("Борис Платёжный", "77075556677");
    return { owner, operator, manager, ex, exUser, anna, boris };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  let number = 7000;
  const mkOrder = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: ++number,
        clientId: ids.anna,
        clientName: "Анна Долгова",
        clientPhone: "77071112233",
        source: "olx",
        serviceId: "ac-repair",
        category: "ac",
        description: "Тест",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: iso(now - 3 * DAY),
        priority: "normal",
        status: "awaiting_payment",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 20000,
        payments: [],
        payoutPaid: false,
        executorId: ids.ex,
        createdAt: iso(now - 10 * DAY),
        createdBy: ids.owner,
        doneAt: iso(now - 2 * DAY),
        files: [],
        ...over,
      }),
    );
  const store = (type: string, body: string) =>
    t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob([body], { type }));
      await (ctx.db as unknown as RawDb).patch(id, { contentType: type });
      return id;
    });
  return { t, now, ids, as, mkOrder, store };
}

describe("«Главная» владельца: долги клиентов", () => {
  test("должники — сданные заказы с неполной оплатой, сумма по debt(), самые давние сверху; только владельцу", async () => {
    const s = await setup();
    const pay = (amount: number, extra: Partial<Doc<"orders">["payments"][number]> = {}) => ({ id: `p${amount}`, amount, method: "kaspi" as const, at: iso(s.now - DAY), ...extra });
    // Долг 30 000, ждём 5 дней.
    const old = await s.mkOrder({ doneAt: iso(s.now - 5 * DAY) });
    // Частичная оплата и сторно: долг 30 000 − 10 000 = 20 000 (сторнированные 5 000 не считаются), ждём 2 дня.
    const partial = await s.mkOrder({ clientId: s.ids.boris, clientName: "Борис Платёжный", payments: [pay(10000), pay(5000, { voidedAt: iso(s.now), voidReason: "ошибка" })] });
    // «Выполнен» без отметки времени выполнения — с даты создания.
    const legacy = await s.mkOrder({ status: "done", doneAt: undefined, createdAt: iso(s.now - 20 * DAY), clientPrice: 7000, payoutValue: 3000 });
    // Не должники: оплачен полностью, в работе, отменён, закрыт владельцем с долгом (списание), возврат.
    await s.mkOrder({ status: "paid", payments: [pay(30000)] });
    await s.mkOrder({ status: "in_progress", doneAt: undefined });
    await s.mkOrder({ status: "cancelled", doneAt: undefined });
    await s.mkOrder({ status: "closed" });
    await s.mkOrder({ status: "refund", payments: [pay(30000)], refunds: [{ id: "r1", amount: 30000, method: "kaspi", at: iso(s.now), reason: "брак", by: s.ids.owner }] });
    // «Ожидает оплаты», но оплачено всё (старые данные до автоматического «Оплачен») — долга нет.
    await s.mkOrder({ payments: [pay(30000)] });

    const r = await s.as(s.ids.owner).query(api.receivables.list, {});
    expect(r.debtors.map((d) => [d.orderId, d.debt])).toEqual([
      [legacy, 7000],
      [old, 30000],
      [partial, 20000],
    ]);
    expect(r).toMatchObject({ total: 57000, count: 3, truncated: false });
    expect(r.debtors[2]).toMatchObject({ clientId: s.ids.boris, clientName: "Борис Платёжный", number: expect.any(Number) });
    // Сумма — те же правила, что в карточке заказа.
    const docs = await s.t.run(async (ctx) => Promise.all([legacy, old, partial].map((id) => ctx.db.get(id))));
    expect(r.debtors.map((d) => d.debt)).toEqual(docs.map((o) => debt(o!)));
    expect(debtDays(r.debtors[1]!.since, s.now)).toBe(5);

    for (const who of [s.ids.operator, s.ids.manager, s.ids.exUser]) await expect(s.as(who).query(api.receivables.list, {})).rejects.toThrow("Нет доступа");
  });
});

describe("карточка клиента: звонки, оплаты, файлы", () => {
  test("звонки клиента — привязанные и с его номера до того, как его завели; запись по подписанной ссылке", async () => {
    const s = await setup();
    const audio = await s.store("audio/mpeg", "RIFFDATA-recording");
    const calls = await s.t.run(async (ctx) => {
      const call = (over: Partial<Doc<"calls">>) => ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77071112233", to: "77270000000", status: "completed", startedAt: iso(s.now - DAY), aiStatus: "none", ...over });
      return {
        linked: await call({ clientId: s.ids.anna, clientName: "Анна Долгова", recordingId: audio, duration: 95, startedAt: iso(s.now - 3 * DAY), ai: { summary: "Не холодит кондиционер", extracted: [], questions: [] } }),
        early: await call({ startedAt: iso(s.now - 40 * DAY), status: "missed" }),
        outgoing: await call({ direction: "out", from: "77270000000", to: "77071112233", startedAt: iso(s.now - 2 * DAY) }),
        // С этого номера звонил, но звонок уже в чужой карточке; и звонок другого клиента.
        foreign: await call({ clientId: s.ids.boris, startedAt: iso(s.now - 4 * DAY) }),
        other: await call({ from: "77075556677", startedAt: iso(s.now - 5 * DAY) }),
        // Исходящий с номера клиента не считается его звонком (номер клиента у исходящего — «кому»).
        reversed: await call({ direction: "out", from: "77071112233", to: "77279999999" }),
      };
    });
    const list = await s.as(s.ids.operator).query(api.clientRecords.calls, { clientId: s.ids.anna });
    expect(list!.map((c) => c.id)).toEqual([calls.outgoing, calls.linked, calls.early]);
    const rec = list!.find((c) => c.id === calls.linked)!;
    expect(rec).toMatchObject({ hasRecording: true, duration: 95, ai: { summary: "Не холодит кондиционер" } });
    expect(rec.recordingSrc).toMatch(new RegExp(`^${SITE}/files/${audio}\\?exp=\\d+&sig=[0-9a-f]{64}$`));
    const res = await s.t.fetch(rec.recordingSrc!.slice(SITE.length));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("RIFFDATA-recording");
    expect((await s.t.fetch(`/files/${audio}`)).status).toBe(403);

    expect(await s.as(s.ids.owner).query(api.clientRecords.calls, { clientId: s.ids.anna })).toHaveLength(3);
    for (const who of [s.ids.manager, s.ids.exUser]) await expect(s.as(who).query(api.clientRecords.calls, { clientId: s.ids.anna })).rejects.toThrow("Нет доступа");
  });

  test("файлы — по заказам и перепискам клиента, со ссылками на 15 минут; чужие не попадают", async () => {
    const s = await setup();
    const photo = await s.store("image/jpeg", "jpeg-bytes");
    const act = await s.store("application/pdf", "%PDF-act");
    const voice = await s.store("audio/ogg", "ogg-voice");
    const mine = await s.mkOrder({
      createdAt: iso(s.now - 3 * DAY),
      files: [
        { id: "f-photo", name: "до ремонта.jpg", kind: "image", storageId: photo },
        { id: "f-act", name: "акт.pdf", kind: "file", storageId: act },
        { id: "f-lost", name: "без файла.jpg", kind: "image" },
      ],
    });
    await s.mkOrder({ clientId: s.ids.boris, files: [{ id: "f-foreign", name: "чужое.jpg", kind: "image", storageId: photo }] });
    const chat = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("conversations", { tenantId: T, channel: "whatsapp", externalId: "77071112233", clientId: s.ids.anna, lastMessageAt: iso(s.now - DAY), lastText: "голосовое", lastDirection: "in", unread: 0, status: "open" });
      await ctx.db.insert("conversationMessages", { conversationId: id, direction: "in", kind: "audio", text: "", at: iso(s.now - DAY), fileId: voice });
      await ctx.db.insert("conversationMessages", { conversationId: id, direction: "in", kind: "text", text: "Здравствуйте", at: iso(s.now - DAY - 60_000) });
      return id;
    });

    const groups = (await s.as(s.ids.operator).query(api.clientRecords.files, { clientId: s.ids.anna }))!;
    expect(groups.map((g) => [g.title, g.link, g.files.map((f) => [f.name, f.kind])])).toEqual([
      ["Переписка в WhatsApp", `/inbox?c=${chat}`, [["Голосовое сообщение", "audio"]]],
      [expect.stringMatching(/^Заказ №\d+$/), `/orders/${mine}`, [["до ремонта.jpg", "image"], ["акт.pdf", "file"]]],
    ]);
    const pdf = groups[1]!.files[1]!;
    expect(pdf.src).toContain("&name=");
    const res = await s.t.fetch(pdf.src!.slice(SITE.length));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("filename*=UTF-8''%D0%B0%D0%BA%D1%82.pdf");
    expect(await res.text()).toBe("%PDF-act");

    for (const who of [s.ids.manager, s.ids.exUser]) await expect(s.as(who).query(api.clientRecords.files, { clientId: s.ids.anna })).rejects.toThrow("Нет доступа");
  });

  test("оплаты клиента: все платежи и возвраты по его заказам, сторно — в списке с пометкой, но не в сумме", () => {
    const base = { clientPrice: 30000, payoutMode: "fixed", payoutValue: 20000 } as const;
    const orders = [
      { ...base, id: "o1", number: 1001, payments: [{ id: "p1", amount: 30000, method: "kaspi", at: "2026-10-01T06:00:00.000Z", by: "u1" }], refunds: [{ id: "r1", amount: 5000, method: "cash", at: "2026-10-03T06:00:00.000Z", reason: "скидка", by: "u2" }] },
      { ...base, id: "o2", number: 1002, payments: [{ id: "p2", amount: 10000, method: "card", at: "2026-10-02T06:00:00.000Z", voidedAt: "2026-10-02T07:00:00.000Z", voidReason: "дубль" }, { id: "p3", amount: 10000, method: "card", at: "2026-10-02T08:00:00.000Z", note: "предоплата" }] },
    ] as unknown as Order[];
    const rows = clientPayments(orders);
    expect(rows.map((r) => [r.id, r.kind, r.number, r.amount, r.voided?.reason ?? null, r.note ?? null])).toEqual([
      ["r1", "refund", 1001, 5000, null, "скидка"],
      ["p3", "payment", 1002, 10000, null, "предоплата"],
      ["p2", "payment", 1002, 10000, "дубль", null],
      ["p1", "payment", 1001, 30000, null, null],
    ]);
    expect(clientPaymentTotals(orders)).toEqual({ received: 40000, refunded: 5000 });
  });
});
