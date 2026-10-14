/// <reference types="vite/client" />
// Исходящие вебхуки (ТЗ п.20.7, п.26.7): подписка владельца, подпись X-HMS-Signature, повторы с паузами,
// отключение после неудач подряд, защита от SSRF, тестовое событие, точки событий (заявка, статус, оплата).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { verifySignature } from "./lib/webhookEvents";
import { retryDelay } from "./webhooks";
import { WEBHOOK_DISABLE_AFTER, WEBHOOK_MAX_ATTEMPTS } from "../src/data/webhookEvents";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const HOOK = "https://hooks.example.kz/hms";
const INTEGRATIONS_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
type Hit = { url: string; headers: Headers; body: string; at: number };
let hits: Hit[] = [];
/** Ответ получателя — меняется в тестах сбоев. */
let reply: () => Response;

beforeEach(() => {
  hits = [];
  reply = () => new Response("ok", { status: 200 });
  vi.useFakeTimers();
  vi.stubEnv("INTEGRATIONS_KEY", INTEGRATIONS_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).startsWith("https://hooks.example.kz/")) {
        hits.push({ url: String(url), headers: new Headers(init?.headers), body: String(init?.body), at: Date.now() });
        return reply();
      }
      // Уведомления в Telegram и прочее — не предмет теста.
      return Response.json({ ok: true, result: {} });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    return { owner, operator };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const flush = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  const subscribe = (events: string[] = ["lead.created"], url = HOOK) => as(ids.owner).action(api.webhooks.create, { url, events, description: "Сайт" });
  const newLead = () =>
    as(ids.operator).mutation(api.leads.create, { clientName: "Айгерим Нурланова", phone: "+7 707 123 45 67", source: "phone", serviceId: "ac-repair", city: "Алматы", description: "Не холодит, ул. Абая 1", urgency: "normal" });
  const deliveries = () => t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
  const hook = (id: Id<"webhooks">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"webhooks">>;
  return { t, ids, as, flush, subscribe, newLead, deliveries, hook };
}

describe("подписка и подпись", () => {
  test("секрет показывается один раз и хранится зашифрованным; событие подписано HMAC с временем, без персональных данных", async () => {
    const s = await setup();
    const { id, secret } = await s.subscribe(["lead.created"]);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const row = await s.hook(id);
    expect(row.secret.startsWith("enc:v1:")).toBe(true);
    expect(JSON.stringify(row)).not.toContain(secret);
    const view = await s.as(s.ids.owner).query(api.webhooks.list, {});
    expect(JSON.stringify(view)).not.toContain(row.secret);

    const lead = await s.newLead();
    await s.flush();
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    const body = JSON.parse(hit.body) as { id: string; type: string; data: Record<string, unknown> };
    expect(body.type).toBe("lead.created");
    expect(body.data).toMatchObject({ number: lead.number, status: "new", source: "phone", serviceId: "ac-repair", city: "Алматы" });
    expect(hit.body).not.toMatch(/Айгерим|7071234567|Абая|Не холодит/);
    expect(hit.headers.get("x-hms-event")).toBe("lead.created");
    expect(hit.headers.get("x-hms-event-id")).toBe(body.id);

    const sig = hit.headers.get("x-hms-signature")!;
    const nowSec = Math.floor(hit.at / 1000);
    expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(secret, hit.body, sig, nowSec, 300)).toBe(true);
    // Подменённое тело, чужой секрет и старая подпись (повтор перехваченного запроса) не проходят.
    expect(verifySignature(secret, hit.body.replace("new", "old"), sig, nowSec, 300)).toBe(false);
    expect(verifySignature("whsec_other", hit.body, sig, nowSec, 300)).toBe(false);
    expect(verifySignature(secret, hit.body, sig, nowSec + 301, 300)).toBe(false);
    expect((await s.deliveries())[0]).toMatchObject({ status: "ok", attempts: 1, responseCode: 200 });
  });

  test("без ключа шифрования подписку не создать; создаёт только владелец", async () => {
    const s = await setup();
    await expect(s.as(s.ids.operator).action(api.webhooks.create, { url: HOOK, events: ["lead.created"] })).rejects.toThrow("Нет доступа");
    await expect(s.as(s.ids.operator).query(api.webhooks.list, {})).rejects.toThrow();
    vi.stubEnv("INTEGRATIONS_KEY", "");
    await expect(s.subscribe()).rejects.toThrow("INTEGRATIONS_KEY");
    await expect(s.as(s.ids.owner).action(api.webhooks.create, { url: HOOK, events: [] })).rejects.toThrow();
  });

  test("SSRF: только публичный https на порту 443 — при создании и при отправке", async () => {
    const s = await setup();
    for (const url of ["http://hooks.example.kz/hms", "https://127.0.0.1/hook", "https://localhost/hook", "https://10.0.0.5/hook", "https://169.254.169.254/latest", "https://hooks.example.kz:8443/hms", "https://user:pw@hooks.example.kz/", "https://metadata.google.internal/"]) {
      await expect(s.subscribe(["lead.created"], url), url).rejects.toThrow("Адрес не подходит");
    }
    // Адрес подменили в базе — отправка всё равно не пойдёт во внутреннюю сеть.
    const { id } = await s.subscribe(["lead.created"]);
    await s.t.run((ctx) => ctx.db.patch(id, { url: "https://192.168.1.10/hook" }));
    await s.newLead();
    await s.flush();
    expect(hits).toEqual([]);
    const [d] = await s.deliveries();
    expect(d!.error).toContain("внутренней сети");
  });
});

describe("доставка", () => {
  test("сбой — повтор с удвоением паузы, успех сбрасывает счётчик неудач", async () => {
    const s = await setup();
    const { id } = await s.subscribe();
    let n = 0;
    reply = () => (++n <= 2 ? new Response("down", { status: 503 }) : new Response("ok", { status: 200 }));
    await s.newLead();
    await s.flush();
    expect(hits).toHaveLength(3);
    // Паузы: 1 минута, потом 2.
    expect(hits[1]!.at - hits[0]!.at).toBeGreaterThanOrEqual(retryDelay(1));
    expect(hits[2]!.at - hits[1]!.at).toBeGreaterThanOrEqual(retryDelay(2));
    expect(retryDelay(2)).toBe(2 * retryDelay(1));
    // Все попытки — одно событие (тот же id) с номером попытки.
    expect(new Set(hits.map((h) => JSON.parse(h.body).id)).size).toBe(1);
    expect(hits.map((h) => h.headers.get("x-hms-attempt"))).toEqual(["1", "2", "3"]);
    expect((await s.deliveries())[0]).toMatchObject({ status: "ok", attempts: 3, responseCode: 200 });
    expect((await s.hook(id)).failures).toBe(0);
  });

  test(`${WEBHOOK_MAX_ATTEMPTS} попыток — и событие помечается недоставленным; подписка пока работает`, async () => {
    const s = await setup();
    const { id } = await s.subscribe();
    reply = () => new Response("err", { status: 500 });
    await s.newLead();
    await s.flush();
    expect(hits).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect((await s.deliveries())[0]).toMatchObject({ status: "failed", attempts: WEBHOOK_MAX_ATTEMPTS, responseCode: 500, error: "Получатель ответил HTTP 500" });
    expect(await s.hook(id)).toMatchObject({ active: true, failures: WEBHOOK_MAX_ATTEMPTS });
  });

  test("перенаправление — неудача: адрес подписки должен быть конечным", async () => {
    const s = await setup();
    await s.subscribe();
    reply = () => new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/" } });
    await s.newLead();
    await s.flush();
    expect(hits).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect((await s.deliveries())[0]!.error).toContain("перенаправлением");
  });

  test(`${WEBHOOK_DISABLE_AFTER} неудач подряд — подписка отключается, владелец получает уведомление, очередь не отправляется`, async () => {
    const s = await setup();
    const { id } = await s.subscribe();
    await s.t.run((ctx) => ctx.db.patch(id, { failures: WEBHOOK_DISABLE_AFTER - 1 }));
    reply = () => new Response("err", { status: 500 });
    await s.newLead();
    await s.flush();
    expect(hits).toHaveLength(1);
    const w = await s.hook(id);
    expect(w).toMatchObject({ active: false, failures: WEBHOOK_DISABLE_AFTER });
    expect(w.disabledReason).toContain(`${WEBHOOK_DISABLE_AFTER} неудачных попыток`);
    expect((await s.deliveries())[0]).toMatchObject({ status: "failed" });
    const bell = await s.t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", s.ids.owner)).collect());
    expect(bell.map((n) => n.text).join("\n")).toContain("Вебхук hooks.example.kz отключён");
    const audit = await s.t.run((ctx) => ctx.db.query("audit").collect());
    expect(audit.some((a) => a.action === "integration.webhookDisabled" && a.actorName === "Система")).toBe(true);

    // Выключенной подписке новые события не идут; включили снова — счётчик с нуля.
    await s.newLead();
    await s.flush();
    expect(hits).toHaveLength(1);
    await s.as(s.ids.owner).mutation(api.webhooks.update, { id, active: true });
    const back = await s.hook(id);
    expect(back).toMatchObject({ active: true, failures: 0 });
    expect(back.disabledAt).toBeUndefined();
  });

  test("тестовое событие: одна попытка, без повторов и без счёта неудач", async () => {
    const s = await setup();
    const { id } = await s.subscribe(["order.paid"]);
    await s.as(s.ids.owner).mutation(api.webhooks.sendTest, { id });
    await s.flush();
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ type: "webhook.test", data: { webhookId: id } });
    reply = () => new Response("err", { status: 500 });
    await s.as(s.ids.owner).mutation(api.webhooks.sendTest, { id });
    await s.flush();
    expect(hits).toHaveLength(2);
    const view = await s.as(s.ids.owner).query(api.webhooks.list, {});
    expect(view.deliveries.map((d) => [d.event, d.status])).toEqual([
      ["webhook.test", "failed"],
      ["webhook.test", "ok"],
    ]);
    expect((await s.hook(id)).failures).toBe(0);
    await expect(s.as(s.ids.operator).mutation(api.webhooks.sendTest, { id })).rejects.toThrow();
  });
});

describe("события", () => {
  test("заявка → заказ → оплата: lead.status_changed, order.created, order.status_changed, order.paid — только подписанным", async () => {
    const s = await setup();
    await s.subscribe(["lead.status_changed", "order.created", "order.status_changed", "order.paid"]);
    const lead = await s.newLead();
    await s.flush();
    expect(hits).toEqual([]); // на lead.created не подписаны
    const order = await s.as(s.ids.operator).mutation(api.leads.convert, { id: lead.id });
    await s.t.run((ctx) => ctx.db.patch(order.id, { status: "awaiting_payment", clientPrice: 30000, doneAt: new Date().toISOString() }));
    await s.as(s.ids.owner).mutation(api.orders.addPayment, { id: order.id, amount: 30000, method: "kaspi" });
    await s.flush();
    const events = hits.map((h) => JSON.parse(h.body) as { type: string; data: Record<string, unknown> });
    expect(events.map((e) => e.type).sort()).toEqual(["lead.status_changed", "order.created", "order.paid", "order.status_changed"]);
    expect(events.find((e) => e.type === "lead.status_changed")!.data).toMatchObject({ status: "converted", previousStatus: "new" });
    expect(events.find((e) => e.type === "order.status_changed")!.data).toMatchObject({ status: "paid", previousStatus: "awaiting_payment" });
    // Ни денег, ни клиента в событиях заказа.
    for (const e of events) expect(JSON.stringify(e)).not.toMatch(/30000|clientPrice|payout|Айгерим|7071234567/);
  });
});
