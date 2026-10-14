/// <reference types="vite/client" />
// Документы по заказу (ТЗ п.19.9): сумма прописью, реквизиты, нумерация, неизменный снимок, ссылка клиенту
// (токен, срок, ничего лишнего), права.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { numberInWords, sumInWords, requisitesIssues, type CompanyRequisites } from "../src/data/documents";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const APP = "https://app.test";
const REQ: CompanyRequisites = {
  name: "ТОО «Home Max Service»",
  bin: "210840012345",
  address: "г. Алматы, ул. Абая, 10",
  bank: "АО «Kaspi Bank»",
  iik: "KZ12722S000012345678",
  bik: "CASPKZKA",
  kbe: "17",
  director: "Ерланов Е. Е.",
  invoicePrefix: "СЧ-",
};

let tg: string[] = [];
beforeEach(() => {
  tg = [];
  vi.stubEnv("APP_URL", `${APP}/`);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://api.telegram.org/")) {
        tg.push(String(init?.body ?? ""));
        return Response.json({ ok: true, result: { message_id: 1 } });
      }
      return new Response("not found", { status: 404 });
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
  const now = Date.now();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель", email: "mgr@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгерим Касымова", kind: "person", phone: "77071234567", city: "Алматы", source: "telegram", tags: [], createdAt: iso(0), ordersCount: 1, activeCount: 0, lastActivityAt: iso(0) });
    return { owner, operator, manager, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  let n = 1000;
  const order = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: ++n,
        clientId: ids.client,
        clientName: "Айгерим Касымова",
        clientPhone: "77071234567",
        source: "telegram",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит, внутренняя заметка",
        city: "Алматы",
        address: "ул. Сатпаева, 5",
        deadline: iso(86400_000),
        priority: "normal",
        status: "awaiting_payment",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [{ id: "p1", amount: 10000, method: "cash", at: iso(-3600_000) }],
        payoutPaid: false,
        createdAt: iso(-2 * 3600_000),
        createdBy: ids.owner,
        doneAt: iso(-3600_000),
        files: [],
        ...over,
      }),
    );
  const requisites = (r: CompanyRequisites = REQ) => as(ids.owner).mutation(api.documents.saveRequisites, { requisites: r });
  return { t, ids, as, order, requisites, iso };
}

describe("сумма прописью (тенге и тиын)", () => {
  test.each([
    [0, "Ноль тенге 00 тиын"],
    [1, "Один тенге 00 тиын"],
    [2, "Два тенге 00 тиын"],
    [11, "Одиннадцать тенге 00 тиын"],
    [21, "Двадцать один тенге 00 тиын"],
    [112, "Сто двенадцать тенге 00 тиын"],
    [1000, "Одна тысяча тенге 00 тиын"],
    [2000, "Две тысячи тенге 00 тиын"],
    [5000, "Пять тысяч тенге 00 тиын"],
    [11000, "Одиннадцать тысяч тенге 00 тиын"],
    [21500, "Двадцать одна тысяча пятьсот тенге 00 тиын"],
    [30000, "Тридцать тысяч тенге 00 тиын"],
    [1_000_000, "Один миллион тенге 00 тиын"],
    [2_345_678, "Два миллиона триста сорок пять тысяч шестьсот семьдесят восемь тенге 00 тиын"],
    [1_000_000_000, "Один миллиард тенге 00 тиын"],
    [1234.56, "Одна тысяча двести тридцать четыре тенге 56 тиын"],
    [0.05, "Ноль тенге 05 тиын"],
    [99.999, "Сто тенге 00 тиын"],
  ])("%d → %s", (amount, words) => {
    expect(sumInWords(amount)).toBe(words);
  });

  test("числа: склонение разрядов и средние нули", () => {
    expect(numberInWords(1_001_001)).toBe("один миллион одна тысяча один");
    expect(numberInWords(5_000_014)).toBe("пять миллионов четырнадцать");
    expect(numberInWords(22_000)).toBe("двадцать две тысячи");
  });

  test("реквизиты: БИН 12 цифр, ИИК KZ+18, БИК 8 знаков, КБе 2 цифры", () => {
    expect(requisitesIssues(REQ)).toEqual([]);
    expect(requisitesIssues({ ...REQ, bin: "123" })).toContain("БИН / ИИН — 12 цифр");
    expect(requisitesIssues({ ...REQ, iik: "KZ12" })).toContain("ИИК — KZ и 18 знаков");
    expect(requisitesIssues({ ...REQ, bik: "кириллица" })).toContain("БИК — 8 латинских букв и цифр");
    expect(requisitesIssues({ ...REQ, kbe: "7" })).toContain("КБе — 2 цифры");
  });
});

describe("выпуск документов", () => {
  test("без реквизитов не выпускается; реквизиты сохраняет только владелец", async () => {
    const s = await setup();
    const orderId = await s.order();
    await expect(s.as(s.ids.operator).mutation(api.documents.issue, { orderId, kind: "invoice" })).rejects.toThrow("Настройки → Документы");
    await expect(s.as(s.ids.operator).mutation(api.documents.saveRequisites, { requisites: REQ })).rejects.toThrow();
    await expect(s.requisites({ ...REQ, iik: "123" })).rejects.toThrow("ИИК");
    await s.requisites();
    expect(await s.as(s.ids.operator).mutation(api.documents.issue, { orderId, kind: "invoice" })).toBeDefined();
    await expect(s.as(s.ids.manager).mutation(api.documents.issue, { orderId, kind: "invoice" })).rejects.toThrow();
  });

  test("нумерация: сквозная по виду, с префиксом и стартом; повторное открытие — тот же номер; «заново» — новый, прежний заменён", async () => {
    const s = await setup();
    await s.requisites({ ...REQ, invoiceStart: 100, actPrefix: "АВР-" });
    const a = await s.order();
    const b = await s.order();
    const op = s.as(s.ids.operator);
    const inv1 = await op.mutation(api.documents.issue, { orderId: a, kind: "invoice" });
    const inv2 = await op.mutation(api.documents.issue, { orderId: b, kind: "invoice" });
    const act1 = await op.mutation(api.documents.issue, { orderId: a, kind: "act" });
    expect(await op.mutation(api.documents.issue, { orderId: a, kind: "invoice" })).toBe(inv1);
    const docs = await s.t.run((ctx) => ctx.db.query("documents").collect());
    const byId = (id: Id<"documents">) => docs.find((d) => d._id === id)!;
    expect([byId(inv1).label, byId(inv2).label, byId(act1).label]).toEqual(["СЧ-100", "СЧ-101", "АВР-1"]);
    const inv3 = await op.mutation(api.documents.issue, { orderId: a, kind: "invoice", reissue: true });
    const after = await s.t.run(async (ctx) => ({ old: (await ctx.db.get(inv1))!, fresh: (await ctx.db.get(inv3))! }));
    expect(after.fresh.label).toBe("СЧ-102");
    expect(after.old.replacedAt).toBeDefined();
    expect((await s.t.run((ctx) => ctx.db.query("audit").collect())).filter((x) => x.action === "order.document")).toHaveLength(4);
  });

  test("акт — только когда работа сдана; счёт по отменённому — нельзя", async () => {
    const s = await setup();
    await s.requisites();
    const inWork = await s.order({ status: "in_progress", doneAt: undefined });
    await expect(s.as(s.ids.operator).mutation(api.documents.issue, { orderId: inWork, kind: "act" })).rejects.toThrow("работа сдана");
    expect(await s.as(s.ids.operator).mutation(api.documents.issue, { orderId: inWork, kind: "invoice" })).toBeDefined();
    const cancelled = await s.order({ status: "cancelled" });
    await expect(s.as(s.ids.operator).mutation(api.documents.issue, { orderId: cancelled, kind: "invoice" })).rejects.toThrow("счёт по нему не выставить");
  });

  test("снимок неизменен: цена заказа и реквизиты поменялись — печатается как выпущено", async () => {
    const s = await setup();
    await s.requisites();
    const orderId = await s.order();
    await s.as(s.ids.operator).mutation(api.documents.issue, { orderId, kind: "invoice" });
    const before = (await s.as(s.ids.operator).query(api.documents.latest, { orderId, kind: "invoice" }))!;
    expect(before.data).toMatchObject({
      total: 30000,
      paid: 10000,
      totalWords: "Тридцать тысяч тенге 00 тиын",
      vatNote: "Без НДС",
      orderNumber: 1001,
      seller: { name: REQ.name, bin: REQ.bin, iik: REQ.iik, bik: REQ.bik, kbe: "17" },
      buyer: { name: "Айгерим Касымова", phone: "77071234567" },
      lines: [{ qty: 1, unit: "усл.", price: 30000, sum: 30000 }],
    });
    await s.t.run((ctx) => ctx.db.patch(orderId, { clientPrice: 45000 }));
    await s.requisites({ ...REQ, name: "ТОО «Другое название»", bin: "999999999999" });
    const after = (await s.as(s.ids.operator).query(api.documents.latest, { orderId, kind: "invoice" }))!;
    expect(after.data).toEqual(before.data);
    expect(after.label).toBe(before.label);
  });
});

describe("ссылка клиенту", () => {
  test("публичная страница по токену: только снимок документа — без id заказа, описания и денег мастера", async () => {
    const s = await setup();
    await s.requisites();
    const orderId = await s.order();
    const id = await s.as(s.ids.operator).mutation(api.documents.issue, { orderId, kind: "act" });
    const { url, delivery } = await s.as(s.ids.operator).mutation(api.documents.share, { id, send: false });
    expect(delivery).toBeNull();
    expect(url.startsWith(`${APP}/d/`)).toBe(true);
    const token = url.slice(`${APP}/d/`.length);
    const view = (await s.t.query(api.documents.publicView, { token }))!;
    expect(Object.keys(view).sort()).toEqual(["data", "date", "kind", "label"]);
    const text = JSON.stringify(view);
    for (const leak of [orderId, s.ids.client, "21000", "внутренняя заметка", "payout"]) expect(text).not.toContain(leak);
    // В базе — только хэш токена.
    const doc = (await s.t.run((ctx) => ctx.db.get(id)))!;
    expect(doc.publicTokenHash).toBeDefined();
    expect(JSON.stringify(doc)).not.toContain(token);
    // Неверный и короткий токен — ничего.
    expect(await s.t.query(api.documents.publicView, { token: `${token.slice(0, -1)}x` })).toBeNull();
    expect(await s.t.query(api.documents.publicView, { token: "short" })).toBeNull();
  });

  test("срок ссылки истёк, документ заменён или выпущена новая ссылка — прежняя не открывается", async () => {
    const s = await setup();
    await s.requisites();
    const orderId = await s.order();
    const id = await s.as(s.ids.operator).mutation(api.documents.issue, { orderId, kind: "invoice" });
    const first = (await s.as(s.ids.operator).mutation(api.documents.share, { id, send: false })).url.split("/d/")[1]!;
    const second = (await s.as(s.ids.operator).mutation(api.documents.share, { id, send: false })).url.split("/d/")[1]!;
    expect(await s.t.query(api.documents.publicView, { token: first })).toBeNull();
    expect(await s.t.query(api.documents.publicView, { token: second })).not.toBeNull();
    await s.t.run((ctx) => ctx.db.patch(id, { publicExpiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(await s.t.query(api.documents.publicView, { token: second })).toBeNull();
    const third = (await s.as(s.ids.operator).mutation(api.documents.share, { id, send: false })).url.split("/d/")[1]!;
    await s.as(s.ids.operator).mutation(api.documents.issue, { orderId, kind: "invoice", reissue: true });
    expect(await s.t.query(api.documents.publicView, { token: third })).toBeNull();
    await expect(s.as(s.ids.operator).mutation(api.documents.share, { id, send: true })).rejects.toThrow("заменён");
  });

  test("«Отправить клиенту» — в его Telegram ссылкой; писать некуда — заметка и причина", async () => {
    const s = await setup();
    await s.requisites();
    const orderId = await s.order();
    const id = await s.as(s.ids.operator).mutation(api.documents.issue, { orderId, kind: "invoice" });
    const none = await s.as(s.ids.operator).mutation(api.documents.share, { id, send: true });
    expect(none.delivery).toMatchObject({ sent: false });
    await s.t.run((ctx) =>
      ctx.db.insert("conversations", { tenantId: T, channel: "telegram", externalId: "777", clientId: s.ids.client, contactName: "Айгерим", lastMessageAt: new Date().toISOString(), lastText: "…", lastDirection: "in", unread: 0, status: "open" }),
    );
    const r = await s.as(s.ids.operator).mutation(api.documents.share, { id, send: true });
    expect(r.delivery).toEqual({ sent: true, channel: "telegram" });
    await s.t.finishAllScheduledFunctions(() => {});
    expect(tg.some((b) => b.includes(r.url))).toBe(true);
    expect((await s.t.run((ctx) => ctx.db.get(id)))!.sentAt).toBeDefined();
    await expect(s.as(s.ids.manager).mutation(api.documents.share, { id, send: false })).rejects.toThrow();
  });
});
