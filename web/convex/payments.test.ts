/// <reference types="vite/client" />
// Онлайн-оплата (ТЗ п.19.7, п.23.5): счёт → ссылка провайдера (форма запроса Freedom Pay и CloudPayments), уведомление
// с подписью → оплата от «Система» тем же путём, что «Внести оплату»; повтор — без второй оплаты; чужая подпись, не та
// сумма, отменённый заказ — без денег; Kaspi — ссылка магазина; переходы статусов счёта.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { hmacBase64 } from "./lib/hmac";
import { md5Hex } from "./lib/md5";
import { freedomSign, scriptOf, xmlFields } from "./lib/pay/freedompay";
import { kaspiLink, kaspiTemplateIssue, nextIntentStatus, type PayIntentEvent, type PayIntentStatus } from "../src/data/payIntents";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const SITE = "https://test.convex.site";
const INTEGRATIONS_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
const FP_SECRET = "fp-secret-key";
const CP_SECRET = "cp-api-secret";

type Seen = { url: string; method: string; headers: Headers; body: string };
let seen: Seen[] = [];
let routes: ((s: Seen) => Response | null)[] = [];

beforeEach(() => {
  seen = [];
  routes = [];
  vi.stubEnv("INTEGRATIONS_KEY", INTEGRATIONS_KEY);
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const s: Seen = { url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body: typeof init?.body === "string" ? init.body : "" };
      seen.push(s);
      if (url.startsWith("https://api.telegram.org/")) return Response.json({ ok: true, result: { message_id: 1 } });
      for (const r of routes) {
        const res = r(s);
        if (res) return res;
      }
      return new Response("not found", { status: 404 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const freedomInitOk = (paymentId = "1234567") =>
  new Response(`<?xml version="1.0" encoding="utf-8"?><response><pg_status>ok</pg_status><pg_payment_id>${paymentId}</pg_payment_id><pg_redirect_url>https://customer.freedompay.kz/pay.html?customer=abc</pg_redirect_url><pg_redirect_url_type>need data</pg_redirect_url_type><pg_salt>s1</pg_salt><pg_sig>ignored</pg_sig></response>`, {
    headers: { "content-type": "application/xml" },
  });

async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель", email: "mgr@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: iso(0) });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгерим", kind: "person", phone: "77071234567", city: "Алматы", source: "telegram", tags: [], createdAt: iso(0), ordersCount: 1, activeCount: 0, lastActivityAt: iso(0) });
    return { owner, operator, manager, ex, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
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
        deadline: iso(86400_000),
        priority: "normal",
        status: "awaiting_payment",
        executorId: ids.ex,
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        createdAt: iso(-2 * 3600_000),
        createdBy: ids.owner,
        doneAt: iso(-3600_000),
        files: [],
        ...over,
      }),
    );
  const get = (id: Id<"orders">) => t.run(async (ctx) => (await ctx.db.get(id))!);
  const intents = () => t.run((ctx) => ctx.db.query("paymentIntents").collect());
  const journal = () => t.run((ctx) => ctx.db.query("audit").collect());
  const flush = () => t.finishAllScheduledFunctions(() => {});
  const freedom = async () => {
    await as(ids.owner).action(api.payments.save, { provider: "freedompay", fields: { merchantId: "554433", secretKey: FP_SECRET, testMode: "1" } });
    routes.push((r) => (r.url === "https://api.freedompay.kz/init_payment.php" ? freedomInitOk() : null));
  };
  const cloud = async () => {
    await as(ids.owner).action(api.payments.save, { provider: "cloudpayments", fields: { publicId: "pk_test_1", apiSecret: CP_SECRET } });
    routes.push((r) => (r.url === "https://api.cloudpayments.ru/orders/create" ? Response.json({ Success: true, Message: null, Model: { Id: "gASGZVgUN21hcpPF", Url: "https://orders.cloudpayments.ru/d/gASGZVgUN21hcpPF", Amount: 30000 } }) : null));
  };
  return { t, ids, as, order, get, intents, journal, flush, freedom, cloud, iso };
}

/** Уведомление Freedom Pay о результате с подписью для пути /pay/freedompay. */
function freedomNotice(invoiceId: string, over: Record<string, string> = {}, secret = FP_SECRET) {
  const fields: Record<string, string> = {
    pg_order_id: invoiceId,
    pg_payment_id: "1234567",
    pg_amount: "30000.00",
    pg_currency: "KZT",
    pg_net_amount: "29100.00",
    pg_ps_amount: "30000",
    pg_ps_full_amount: "30000.00",
    pg_ps_currency: "KZT",
    pg_description: "Заказ №1001",
    pg_result: "1",
    pg_payment_date: "2026-10-14 12:00:00",
    pg_can_reject: "1",
    pg_testing_mode: "1",
    pg_salt: "rnd-salt",
    ...over,
  };
  fields.pg_sig = freedomSign("freedompay", fields, secret);
  return new URLSearchParams(fields).toString();
}

describe("правила (без сервера)", () => {
  test("подпись Freedom Pay — как в примере документации: скрипт; значения по алфавиту имён; секрет → md5", () => {
    const fields = { pg_order_id: "23", pg_merchant_id: "MID", pg_amount: "25", pg_salt: "molbulak", pg_description: "test" };
    expect(freedomSign("init_payment.php", fields, "SECRET")).toBe(md5Hex("init_payment.php;25;test;MID;23;molbulak;SECRET"));
    // pg_sig в подпись не входит.
    expect(freedomSign("init_payment.php", { ...fields, pg_sig: "x" }, "SECRET")).toBe(md5Hex("init_payment.php;25;test;MID;23;molbulak;SECRET"));
    expect(scriptOf("/pay/freedompay")).toBe("freedompay");
    expect(xmlFields("<response><pg_status>error</pg_status><pg_error_description>Неверная &amp; подпись</pg_error_description></response>")).toEqual({ pg_status: "error", pg_error_description: "Неверная & подпись" });
  });

  test("HMAC-SHA256 в base64 (CloudPayments) — эталонный вектор RFC 4231", async () => {
    expect(await hmacBase64("SHA-256", "Jefe", "what do ya want for nothing?")).toBe("W9zBRr9gdU5qBCQmCJV1x1oAPwidJzmDnexYuWTsOEM=");
  });

  test("статусы счёта: оплаченный и «нужна проверка» — конечные; оплата после неудачи и отмены — принимается", () => {
    const table: [PayIntentStatus, PayIntentEvent, PayIntentStatus | null][] = [
      ["created", "paid", "paid"],
      ["created", "failed", "failed"],
      ["failed", "paid", "paid"],
      ["failed", "failed", null],
      ["cancelled", "paid", "paid"],
      ["cancelled", "failed", null],
      ["created", "cancel", "cancelled"],
      ["cancelled", "cancel", null],
      ["created", "mismatch", "review"],
      ["created", "blocked", "review"],
      ["paid", "paid", null],
      ["paid", "cancel", null],
      ["paid", "mismatch", null],
      ["review", "paid", null],
    ];
    for (const [from, ev, to] of table) expect([from, ev, nextIntentStatus(from, ev)]).toEqual([from, ev, to]);
  });

  test("ссылка Kaspi: только https на kaspi.kz, сумма и номер заказа подставляются", () => {
    expect(kaspiTemplateIssue("https://pay.kaspi.kz/pay/shop?amount={amount}")).toBeNull();
    expect(kaspiTemplateIssue("http://pay.kaspi.kz/pay/shop")).not.toBeNull();
    expect(kaspiTemplateIssue("https://kaspi.kz.evil.com/pay")).not.toBeNull();
    expect(kaspiLink("https://pay.kaspi.kz/pay/shop?amount={amount}&order={order}", 15000.4, 1001)).toBe("https://pay.kaspi.kz/pay/shop?amount=15000&order=1001");
  });
});

describe("Freedom Pay", () => {
  test("счёт: init_payment с подписью, суммой долга, номером счёта и адресом уведомления; ссылку копируют", async () => {
    const s = await setup();
    await s.freedom();
    const orderId = await s.order({ payments: [{ id: "p0", amount: 5000, method: "cash", at: s.iso(-3600_000) }] });
    const r = await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay" });
    expect(r.url).toBe("https://customer.freedompay.kz/pay.html?customer=abc");
    const req = seen.find((x) => x.url === "https://api.freedompay.kz/init_payment.php")!;
    expect(req.method).toBe("POST");
    const f = Object.fromEntries(new URLSearchParams(req.body));
    const [x] = await s.intents();
    expect(f).toMatchObject({ pg_merchant_id: "554433", pg_amount: "25000", pg_currency: "KZT", pg_order_id: x!.invoiceId, pg_result_url: `${SITE}/pay/freedompay`, pg_request_method: "POST", pg_testing_mode: "1" });
    expect(f.pg_description).toContain("Заказ №1001");
    expect(f.pg_sig).toBe(freedomSign("init_payment.php", f, FP_SECRET));
    expect(x).toMatchObject({ status: "created", amount: 25000, externalId: "1234567", url: r.url, provider: "freedompay" });
    // Повторное «Выставить счёт» на ту же сумму — тот же счёт, без второго запроса к провайдеру.
    const again = await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay" });
    expect(again.intentId).toBe(r.intentId);
    expect(seen.filter((y) => y.url.includes("init_payment"))).toHaveLength(1);
    // Больше долга и не сотрудник — отказ.
    await expect(s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay", amount: 26000 })).rejects.toThrow("не больше долга");
    await expect(s.as(s.ids.manager).action(api.payments.createLink, { orderId, provider: "freedompay" })).rejects.toThrow();
  });

  test("уведомление с верной подписью → оплата от «Система» тем же путём, статус «Оплачен»; повтор — без второй оплаты", async () => {
    const s = await setup();
    await s.freedom();
    const orderId = await s.order();
    await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay" });
    const [x] = await s.intents();
    const body = freedomNotice(x!.invoiceId);
    const res = await s.t.fetch("/pay/freedompay", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(res.status).toBe(200);
    const reply = xmlFields(await res.text());
    expect(reply.pg_status).toBe("ok");
    expect(reply.pg_sig).toBe(freedomSign("freedompay", reply, FP_SECRET));
    const o = await s.get(orderId);
    expect(o.payments).toEqual([expect.objectContaining({ amount: 30000, method: "card", note: expect.stringContaining("Freedom Pay") })]);
    expect(o.payments[0]!.by).toBeUndefined();
    expect(o.status).toBe("paid");
    expect((await s.intents())[0]).toMatchObject({ status: "paid", paymentId: o.payments[0]!.id });
    const history = await s.t.run((ctx) => ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", orderId)).collect());
    expect(history.some((h) => h.kind === "payment" && h.actor.type === "system")).toBe(true);
    expect((await s.journal()).find((a) => a.action === "order.payment")).toMatchObject({ actorName: "Система" });
    // Провайдер повторил уведомление — денег не прибавилось.
    expect((await s.t.fetch("/pay/freedompay", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(200);
    expect((await s.get(orderId)).payments).toHaveLength(1);
    await s.flush();
  });

  test("неверная подпись — 403 без денег; сумма не та — «нужна проверка», отказ провайдеру и уведомление владельцу", async () => {
    const s = await setup();
    await s.freedom();
    const orderId = await s.order();
    await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay" });
    const [x] = await s.intents();
    const post = (body: string) => s.t.fetch("/pay/freedompay", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect((await post(freedomNotice(x!.invoiceId, {}, "чужой-ключ"))).status).toBe(403);
    // Подменили сумму после подписи.
    expect((await post(freedomNotice(x!.invoiceId).replace("pg_amount=30000.00", "pg_amount=1.00"))).status).toBe(403);
    expect((await s.get(orderId)).payments).toHaveLength(0);
    const res = await post(freedomNotice(x!.invoiceId, { pg_amount: "300.00" }));
    expect(res.status).toBe(200);
    expect(xmlFields(await res.text()).pg_status).toBe("rejected");
    expect((await s.get(orderId)).payments).toHaveLength(0);
    expect((await s.intents())[0]).toMatchObject({ status: "review", reportedAmount: 300 });
    const notes = await s.t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.some((n) => n.userId === s.ids.owner && n.text.includes("требует проверки"))).toBe(true);
    // После «нужна проверка» правильное уведомление уже ничего не вносит — решает владелец.
    await post(freedomNotice(x!.invoiceId));
    expect((await s.get(orderId)).payments).toHaveLength(0);
  });

  test("заказ отменили, а клиент оплатил — денег в заказ не вносим, счёт «нужна проверка»; неизвестный счёт — отказ", async () => {
    const s = await setup();
    await s.freedom();
    const orderId = await s.order();
    await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay" });
    const [x] = await s.intents();
    await s.t.run((ctx) => ctx.db.patch(orderId, { status: "cancelled" }));
    const res = await s.t.fetch("/pay/freedompay", { method: "POST", body: freedomNotice(x!.invoiceId), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(xmlFields(await res.text()).pg_status).toBe("rejected");
    expect((await s.intents())[0]).toMatchObject({ status: "review", error: expect.stringContaining("возврат") });
    expect((await s.get(orderId)).payments).toHaveLength(0);
    const unknown = await s.t.fetch("/pay/freedompay", { method: "POST", body: freedomNotice("hms-0-nope"), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    expect(xmlFields(await unknown.text()).pg_status).toBe("rejected");
  });

  test("неудачная оплата → «Оплата не прошла», потом успешная — принимается", async () => {
    const s = await setup();
    await s.freedom();
    const orderId = await s.order();
    await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay" });
    const [x] = await s.intents();
    const post = (body: string) => s.t.fetch("/pay/freedompay", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    await post(freedomNotice(x!.invoiceId, { pg_result: "0" }));
    expect((await s.intents())[0]!.status).toBe("failed");
    await post(freedomNotice(x!.invoiceId, { pg_salt: "other" }));
    expect((await s.intents())[0]!.status).toBe("paid");
    expect((await s.get(orderId)).payments).toHaveLength(1);
  });

  test("провайдер не подключён — уведомление не принимается", async () => {
    const s = await setup();
    expect((await s.t.fetch("/pay/freedompay", { method: "POST", body: freedomNotice("hms-1"), headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status).toBe(409);
  });
});

describe("CloudPayments", () => {
  const notice = (invoiceId: string, over: Record<string, string> = {}) =>
    new URLSearchParams({
      TransactionId: "504",
      Amount: "30000.00",
      Currency: "KZT",
      PaymentAmount: "30000.00",
      PaymentCurrency: "KZT",
      DateTime: "2026-10-14 06:00:00",
      CardFirstSix: "400005",
      CardLastFour: "5556",
      CardType: "Visa",
      CardExpDate: "10/28",
      TestMode: "1",
      Status: "Completed",
      OperationType: "Payment",
      GatewayName: "Test",
      InvoiceId: invoiceId,
      ...over,
    }).toString();

  test("счёт: POST /orders/create с Basic-авторизацией, KZT и номером счёта; уведомление Pay с Content-HMAC → оплата, ответ {code:0}", async () => {
    const s = await setup();
    await s.cloud();
    const orderId = await s.order();
    const r = await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "cloudpayments", amount: 30000 });
    expect(r.url).toBe("https://orders.cloudpayments.ru/d/gASGZVgUN21hcpPF");
    const req = seen.find((x) => x.url === "https://api.cloudpayments.ru/orders/create")!;
    expect(req.headers.get("authorization")).toBe(`Basic ${btoa(`pk_test_1:${CP_SECRET}`)}`);
    const [x] = await s.intents();
    expect(JSON.parse(req.body)).toMatchObject({ Amount: 30000, Currency: "KZT", InvoiceId: x!.invoiceId, RequireConfirmation: false, SendEmail: false });

    const body = notice(x!.invoiceId);
    const hmac = await hmacBase64("SHA-256", CP_SECRET, body);
    const bad = await s.t.fetch("/pay/cloudpayments", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": btoa("forged") } });
    expect(bad.status).toBe(403);
    const ok = await s.t.fetch("/pay/cloudpayments", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": hmac } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ code: 0 });
    expect((await s.get(orderId)).status).toBe("paid");
    expect((await s.intents())[0]).toMatchObject({ status: "paid", externalId: "504" });
  });

  test("Fail (Declined) — «оплата не прошла», денег нет; валюта не та — проверка", async () => {
    const s = await setup();
    await s.cloud();
    const orderId = await s.order();
    await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "cloudpayments" });
    const [x] = await s.intents();
    const send = async (body: string) => s.t.fetch("/pay/cloudpayments", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-HMAC": await hmacBase64("SHA-256", CP_SECRET, body) } });
    await send(notice(x!.invoiceId, { Status: "Declined", Reason: "InsufficientFunds", ReasonCode: "5051" }));
    expect((await s.intents())[0]!.status).toBe("failed");
    await send(notice(x!.invoiceId, { Currency: "RUB" }));
    expect((await s.intents())[0]!.status).toBe("review");
    expect((await s.get(orderId)).payments).toHaveLength(0);
  });
});

describe("Kaspi и отправка клиенту", () => {
  test("ссылка Kaspi по шаблону без провайдера; «Отправить клиенту» — в его Telegram тем же путём, что «Клиенту» в заказе", async () => {
    const s = await setup();
    await expect(s.as(s.ids.operator).mutation(api.payments.setKaspi, { template: "https://pay.kaspi.kz/pay/x" })).rejects.toThrow();
    await expect(s.as(s.ids.owner).mutation(api.payments.setKaspi, { template: "https://evil.com/?a={amount}" })).rejects.toThrow("kaspi.kz");
    await s.as(s.ids.owner).mutation(api.payments.setKaspi, { template: "https://pay.kaspi.kz/pay/homemax?amount={amount}" });
    const orderId = await s.order();
    expect((await s.as(s.ids.operator).query(api.payments.forOrder, { orderId }))!.providers).toEqual(["kaspi"]);
    const r = await s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "kaspi" });
    expect(r.url).toBe("https://pay.kaspi.kz/pay/homemax?amount=30000");
    expect(seen.filter((x) => !x.url.startsWith("https://api.telegram.org"))).toHaveLength(0);
    await expect(s.as(s.ids.operator).action(api.payments.createLink, { orderId, provider: "freedompay" })).rejects.toThrow("не подключён");

    await s.t.run((ctx) =>
      ctx.db.insert("conversations", { tenantId: T, channel: "telegram", externalId: "777", clientId: s.ids.client, contactName: "Айгерим", lastMessageAt: new Date().toISOString(), lastText: "…", lastDirection: "in", unread: 0, status: "open" }),
    );
    const sent = await s.as(s.ids.operator).mutation(api.payments.send, { id: r.intentId });
    expect(sent).toEqual({ sent: true, channel: "telegram" });
    await s.flush();
    const tg = seen.find((x) => x.url.startsWith("https://api.telegram.org/"))!;
    expect(JSON.parse(tg.body).text).toContain("https://pay.kaspi.kz/pay/homemax?amount=30000");
    expect((await s.intents())[0]!.sentAt).toBeDefined();
    // Отменённый счёт больше не отправить.
    await s.as(s.ids.operator).mutation(api.payments.cancel, { id: r.intentId });
    await expect(s.as(s.ids.operator).mutation(api.payments.send, { id: r.intentId })).rejects.toThrow("не действует");
  });

  test("счёт не выставить по отменённому заказу и без долга", async () => {
    const s = await setup();
    await s.as(s.ids.owner).mutation(api.payments.setKaspi, { template: "https://pay.kaspi.kz/pay/homemax" });
    const cancelled = await s.order({ status: "cancelled" });
    await expect(s.as(s.ids.operator).action(api.payments.createLink, { orderId: cancelled, provider: "kaspi" })).rejects.toThrow("отменён");
    const paid = await s.order({ status: "paid", payments: [{ id: "p1", amount: 30000, method: "cash", at: new Date().toISOString() }] });
    await expect(s.as(s.ids.operator).action(api.payments.createLink, { orderId: paid, provider: "kaspi" })).rejects.toThrow("нет долга");
  });
});
