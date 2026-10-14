/// <reference types="vite/client" />
// Email-копии важных уведомлений (ТЗ п.18, п.19): правило «кому и что», Resend, сбои, переключатель сотрудника.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { notify } from "./lib/domain";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const RESEND = "https://api.resend.com/emails";
type Mail = { to: string[]; subject: string; html: string; text: string; from: string; reply_to?: string; tags?: { name: string; value: string }[] };
type Call = { headers: Headers; mail: Mail; raw: string };
let calls: Call[] = [];
/** Ответ Resend — меняется в тестах сбоев. */
let reply: () => Response;

beforeEach(() => {
  calls = [];
  reply = () => Response.json({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" });
  vi.useFakeTimers();
  vi.stubEnv("EMAIL_API_KEY", "re_test_key");
  vi.stubEnv("EMAIL_FROM", "Home Max Service <noreply@notify.test.kz>");
  vi.stubEnv("EMAIL_REPLY_TO", "info@test.kz");
  vi.stubEnv("APP_URL", "https://app.test/");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) !== RESEND) return new Response("not found", { status: 404 });
      const raw = String(init?.body);
      calls.push({ headers: new Headers(init?.headers), mail: JSON.parse(raw) as Mail, raw });
      return reply();
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
    const user = (name: string, email: string, role: "owner" | "operator" | "manager" | "executor", extra: Record<string, unknown> = {}) =>
      ctx.db.insert("users", { name, email, role, tenantId: T, active: true, ...extra });
    const owner = await user("Владелец Тест", "owner@test.kz", "owner", { notifyEmail: true });
    const operator = await user("Мадина Оператор", "op@test.kz", "operator", { notifyEmail: true });
    const quiet = await user("Тихий Оператор", "quiet@test.kz", "operator");
    const phoneOp = await user("Оператор Телефон", "77015550000", "operator", { notifyEmail: true });
    const manager = await user("Руководитель Кондиционеров", "ac@test.kz", "manager", { categories: ["ac"], notifyEmail: true });
    const away = await user("Уволенный Оператор", "away@test.kz", "operator", { notifyEmail: true, active: false });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const exUser = await user("Асет Мастеров", "77000000001", "executor", { executorId: ex });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Ерлан Секретов", kind: "person", phone: "77071234567", city: "Алматы", source: "phone", tags: [], createdAt: at, ordersCount: 1, activeCount: 1, lastActivityAt: at });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Ерлан Секретов",
      clientPhone: "77071234567",
      source: "phone",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      priority: "normal",
      status: "done",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      executorId: ex,
      createdAt: at,
      createdBy: owner,
      files: [],
    });
    return { owner, operator, quiet, phoneOp, manager, away, ex, exUser, client, order };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const flush = () => t.finishAllScheduledFunctions(vi.runAllTimers);
  const recipients = () => calls.map((c) => c.mail.to[0]).sort();
  const health = () => t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "email")).unique());
  return { t, ids, as, flush, recipients, health };
}

describe("правило email", () => {
  test("письмо — копия только важных событий и только тем, кто включил, активен и входит по email", async () => {
    const s = await setup();
    // Новая заявка: сотрудникам направления, кроме автора.
    await s.as(s.ids.operator).mutation(api.leads.create, { clientName: "Ерлан", phone: "77015550147", source: "phone", serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "normal" });
    await s.flush();
    expect(s.recipients()).toEqual(["ac@test.kz", "owner@test.kz"]);
    expect(calls[0]!.mail.subject).toMatch(/^Новая заявка №\d+: /);
    expect(calls.every((c) => c.mail.tags?.[0]?.value === "lead_new")).toBe(true);

    // Новое сообщение клиента — важным не считается: колокольчик есть, письма нет.
    calls = [];
    await s.t.mutation(internal.inbox.ingest, { channel: "whatsapp", externalId: "77019998877", contactPhone: "77019998877", text: "Здравствуйте", kind: "text" });
    await s.flush();
    const bells = await s.t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", s.ids.owner)).collect());
    expect(bells.some((n) => n.text.startsWith("Новое сообщение"))).toBe(true);
    expect(calls).toHaveLength(0);

    // Оплата — только владельцу.
    await s.as(s.ids.operator).mutation(api.orders.addPayment, { id: s.ids.order, amount: 5000, method: "cash" });
    await s.flush();
    expect(s.recipients()).toEqual(["owner@test.kz"]);
    expect(calls[0]!.mail.subject).toMatch(/^Оплата по заказу №1001: 5\s?000 ₸$/);
  });

  test("в письме нет данных клиента; HTML экранирован; заголовки Resend и ключ идемпотентности", async () => {
    const s = await setup();
    await s.t.mutation(internal.bot._createLead, { chatId: "777", phone: "+7 701 222 33 44", name: "Ерлан Секретов", description: "Течёт кран" });
    await s.flush();
    const bell = (await s.t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", s.ids.owner)).collect())).find((n) => n.text.startsWith("Новая заявка"))!;
    expect(bell.text).toContain("Ерлан Секретов"); // в колокольчике имя есть
    const toOwner = calls.find((c) => c.mail.to[0] === "owner@test.kz")!;
    expect(toOwner.raw).not.toContain("Секретов");
    expect(toOwner.raw).not.toContain("70122233");
    expect(toOwner.mail.subject).toMatch(/^Новая заявка №\d+ из Telegram: /);
    expect(toOwner.mail.html).toContain(`href="https://app.test/leads?open=${bell.link!.split("=")[1]}"`);
    expect(toOwner.headers.get("authorization")).toBe("Bearer re_test_key");
    expect(toOwner.headers.get("user-agent")).toBe("home-max-service/1.0");
    expect(toOwner.headers.get("idempotency-key")).toBe(`notification/${bell._id}`);
    expect(toOwner.mail).toMatchObject({ from: "Home Max Service <noreply@notify.test.kz>", reply_to: "info@test.kz" });

    // Текст события с HTML и переводом строки: в теме — одна строка, в HTML — экранировано.
    calls = [];
    await s.t.run((ctx) => notify(ctx, [s.ids.owner], 'Заказ №1001: <script>alert("x")</script>\r\nBcc: evil@x.kz', { link: "/orders/abc", email: { kind: "payment" } }));
    await s.flush();
    const mail = calls[0]!.mail;
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(mail.text).toContain("Открыть заказ: https://app.test/orders/abc");
  });

  test("низкая оценка — письмо владельцу и руководителю без слов клиента", async () => {
    const s = await setup();
    expect(await s.t.mutation(internal.reviews._submit, { orderId: s.ids.order, rating: 2, text: "Мастер нахамил, Ерлан Секретов недоволен", via: "telegram" })).toEqual({ ok: true });
    await s.flush();
    expect(s.recipients()).toEqual(["ac@test.kz", "owner@test.kz"]);
    expect(calls[0]!.mail.subject).toBe("Низкая оценка 2★ по заказу №1001 — мастер Асет М.");
    expect(calls.every((c) => !c.raw.includes("нахамил"))).toBe(true);
  });
});

describe("«Дублировать на email»", () => {
  test("только себе, только с email-логином и только сотрудникам; в журнал", async () => {
    const s = await setup();
    await s.as(s.ids.quiet).mutation(api.users.setNotifyEmail, { on: true });
    const users = await s.t.run(async (ctx) => ({ quiet: await ctx.db.get(s.ids.quiet), operator: await ctx.db.get(s.ids.operator), owner: await ctx.db.get(s.ids.owner) }));
    expect(users.quiet?.notifyEmail).toBe(true);
    expect(users.operator?.notifyEmail).toBe(true);
    expect(users.owner?.notifyEmail).toBe(true);
    await s.as(s.ids.operator).mutation(api.users.setNotifyEmail, { on: false });
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.operator)))?.notifyEmail).toBe(false);
    expect((await s.t.run((ctx) => ctx.db.get(s.ids.quiet)))?.notifyEmail).toBe(true); // чужой флаг не тронут

    await expect(s.as(s.ids.phoneOp).mutation(api.users.setNotifyEmail, { on: true })).rejects.toThrow("входите по телефону");
    await expect(s.as(s.ids.exUser).mutation(api.users.setNotifyEmail, { on: true })).rejects.toThrow("Нет доступа");
    await expect(s.t.mutation(api.users.setNotifyEmail, { on: true })).rejects.toThrow("Нужно войти");

    const rows = (await s.t.run((ctx) => ctx.db.query("audit").collect())).filter((r) => r.action === "user.notifyEmail");
    expect(rows.map((r) => r.actorId)).toEqual([s.ids.quiet, s.ids.operator]);

    expect(await s.as(s.ids.quiet).query(api.email.mine, {})).toEqual({ configured: true, canUse: true, on: true });
    expect(await s.as(s.ids.phoneOp).query(api.email.mine, {})).toMatchObject({ canUse: false });
  });
});

describe("сбои отправки", () => {
  test("Resend отвечает 500: уведомление на месте, повторы тем же ключом и телом, итог — в мониторинге", async () => {
    const s = await setup();
    reply = () => Response.json({ statusCode: 500, name: "application_error", message: "Internal error for owner@test.kz" }, { status: 500 });
    await s.as(s.ids.operator).mutation(api.orders.addPayment, { id: s.ids.order, amount: 5000, method: "kaspi" });
    const bells = await s.t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", s.ids.owner)).collect());
    expect(bells.map((n) => n.text)).toEqual([expect.stringContaining("Оплата по заказу №1001")]);
    await s.flush();
    expect(calls).toHaveLength(4); // первая попытка и три повтора
    expect(new Set(calls.map((c) => c.headers.get("idempotency-key"))).size).toBe(1);
    expect(new Set(calls.map((c) => c.raw)).size).toBe(1);
    const h = await s.health();
    expect(h?.error).toContain("HTTP 500 application_error");
    expect(h?.error).not.toContain("owner@test.kz");
    expect(h?.okAt).toBeUndefined();
  });

  test("ключ отклонён (401) — без повторов, понятная ошибка; потом письмо прошло — «работает»", async () => {
    const s = await setup();
    reply = () => Response.json({ statusCode: 401, name: "restricted_api_key", message: "nope" }, { status: 401 });
    await s.t.run((ctx) => notify(ctx, [s.ids.owner], "Просрочка: заказ №1001", { link: "/orders/x", email: { kind: "order_overdue" } }));
    await s.flush();
    expect(calls).toHaveLength(1);
    expect((await s.health())?.error).toContain("EMAIL_API_KEY");
    reply = () => Response.json({ id: "ok" });
    await s.t.run((ctx) => notify(ctx, [s.ids.owner], "Просрочка: заказ №1002", { link: "/orders/y", email: { kind: "order_overdue" } }));
    await s.flush();
    expect((await s.health())?.okAt).toBeDefined();
  });

  test("без EMAIL_API_KEY и EMAIL_FROM: письма не ставятся, send честно отвечает «не настроено»", async () => {
    vi.stubEnv("EMAIL_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    const s = await setup();
    await s.as(s.ids.operator).mutation(api.orders.addPayment, { id: s.ids.order, amount: 5000, method: "kaspi" });
    await s.flush();
    expect(calls).toHaveLength(0);
    expect(await s.t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", s.ids.owner)).collect())).toHaveLength(1);
    const r = await s.t.action(internal.email.send, { to: "owner@test.kz", subject: "Тест", text: "Тест", html: "<p>Тест</p>" });
    expect(r).toEqual({ status: "skipped", reason: "Email не настроен: не заданы EMAIL_API_KEY, EMAIL_FROM" });
    expect(await s.health()).toBeNull();
    expect(await s.as(s.ids.owner).query(api.email.settings, {})).toMatchObject({ configured: false, missing: ["EMAIL_API_KEY", "EMAIL_FROM"] });
  });
});

describe("тестовый деплоймент", () => {
  test("EMAIL_REDIRECT_TO: все письма — на тестовый адрес; адрес с ошибкой — не шлём никому", async () => {
    vi.stubEnv("EMAIL_REDIRECT_TO", "delivered@resend.dev");
    const s = await setup();
    await s.t.run((ctx) => notify(ctx, [s.ids.owner, s.ids.manager], "Просрочка: заказ №1001", { link: "/orders/x", email: { kind: "order_overdue" } }));
    await s.flush();
    expect(s.recipients()).toEqual(["delivered@resend.dev", "delivered@resend.dev"]);

    calls = [];
    vi.stubEnv("EMAIL_REDIRECT_TO", "не-адрес");
    await s.t.run((ctx) => notify(ctx, [s.ids.owner], "Просрочка: заказ №1002", { link: "/orders/y", email: { kind: "order_overdue" } }));
    await s.flush();
    expect(calls).toHaveLength(0);
    expect(await s.as(s.ids.owner).query(api.email.settings, {})).toMatchObject({ configured: false, missing: ["EMAIL_REDIRECT_TO"] });
  });
});

describe("карточка владельца", () => {
  test("настройки и проверочное письмо — только владельцу", async () => {
    const s = await setup();
    const card = await s.as(s.ids.owner).query(api.email.settings, {});
    expect(card).toMatchObject({ configured: true, missing: [], from: "Home Max Service <noreply@notify.test.kz>", replyTo: "info@test.kz" });
    // Включили, активны и входят по email — без телефона-логина и отключённого.
    expect(card.subscribers.sort()).toEqual(["Владелец Т.", "Мадина О.", "Руководитель К."]);
    await expect(s.as(s.ids.operator).query(api.email.settings, {})).rejects.toThrow("Нет доступа");

    expect(await s.as(s.ids.owner).action(api.email.sendTest, {})).toEqual({ status: "sent" });
    expect(s.recipients()).toEqual(["owner@test.kz"]);
    await expect(s.as(s.ids.operator).action(api.email.sendTest, {})).rejects.toThrow("Нет доступа");
  });
});
