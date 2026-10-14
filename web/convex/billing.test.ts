/// <reference types="vite/client" />
// Подписка компаний (ТЗ §24): «Создать компанию» администратором платформы, приём оплаты и её отмена, напоминания
// за 7 и 1 день, приостановка после льготных дней и возобновление оплатой, права и изоляция оплат.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { MODULES } from "../src/data/plans";
import { addDays, addMonths, paymentPeriod, paymentsCsv, reminderDue, subscriptionStatus, suspendDue, todayAlmaty, type SubscriptionPaymentRow } from "../src/data/billing";
import { toCsv } from "../src/lib/csv";

const modules = Object.fromEntries(Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")));

const A = "alpha";
const B = "beta";
const DAY = 86_400_000;

beforeEach(() => {
  vi.stubEnv("PLATFORM_ADMINS", "admin@alpha.kz");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, result: {} })),
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
    for (const slug of [A, B]) {
      await ctx.db.insert("tenants", { slug, name: `Компания ${slug}`, plan: "standard", modules: [...MODULES], status: "active", createdAt: at });
    }
    const admin = await ctx.db.insert("users", { name: "Админ Платформы", email: "admin@alpha.kz", role: "owner", tenantId: A, active: true });
    const ownerB = await ctx.db.insert("users", { name: "Владелец Бета", email: "owner@beta.kz", role: "owner", tenantId: B, active: true, telegramChatId: "777" });
    const operatorB = await ctx.db.insert("users", { name: "Оператор Бета", email: "op@beta.kz", role: "operator", tenantId: B, active: true });
    return { admin, ownerB, operatorB };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const row = (slug: string) => t.run(async (ctx) => (await ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", slug)).unique())!);
  const patchRow = (slug: string, patch: Record<string, unknown>) =>
    t.run(async (ctx) => {
      const r = (await ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", slug)).unique())!;
      await ctx.db.patch(r._id, patch);
    });
  const bell = (userId: Id<"users">) => t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.userId === userId));
  return { t, ...ids, as, row, patchRow, bell };
}

// ── Правила сроков ───────────────────────────────────────────────────────────

describe("правила сроков (src/data/billing.ts)", () => {
  test("месяцы: 31-е в коротком месяце — последний день; период — с завтра после «оплачено до» или с сегодня", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-11-15", 2)).toBe("2027-01-15");
    // Действует (оплачено до 20.10) — продление со следующего дня.
    expect(paymentPeriod("2026-10-20", "2026-10-14", { months: 1 })).toEqual({ from: "2026-10-21", to: "2026-11-20" });
    // Последний оплаченный день — сегодня: тоже продление, без потери дня.
    expect(paymentPeriod("2026-10-14", "2026-10-14", { months: 1 })).toEqual({ from: "2026-10-15", to: "2026-11-14" });
    // Просрочено или не было — с сегодня.
    expect(paymentPeriod("2026-10-01", "2026-10-14", { months: 1 })).toEqual({ from: "2026-10-14", to: "2026-11-13" });
    expect(paymentPeriod(undefined, "2026-10-14", { until: "2026-12-31" })).toEqual({ from: "2026-10-14", to: "2026-12-31" });
  });

  test("состояние, напоминания и приостановка", () => {
    expect(subscriptionStatus(null, "2026-10-14").state).toBe("unlimited");
    expect(subscriptionStatus("2026-10-30", "2026-10-14")).toEqual({ state: "paid", daysLeft: 16 });
    expect(subscriptionStatus("2026-10-21", "2026-10-14")).toEqual({ state: "ending", daysLeft: 7 });
    expect(subscriptionStatus("2026-10-12", "2026-10-14")).toEqual({ state: "expired", daysLeft: -2 });
    expect(reminderDue("2026-10-22", "2026-10-14", [])).toBeNull();
    expect(reminderDue("2026-10-21", "2026-10-14", [])).toBe(7);
    expect(reminderDue("2026-10-21", "2026-10-14", [7])).toBeNull();
    expect(reminderDue("2026-10-15", "2026-10-14", [7])).toBe(1);
    expect(reminderDue("2026-10-15", "2026-10-14", [7, 1])).toBeNull();
    expect(reminderDue("2026-10-13", "2026-10-14", [])).toBeNull();
    expect(reminderDue(undefined, "2026-10-14", [])).toBeNull();
    expect(suspendDue("2026-10-09", "2026-10-14", 5)).toBe(false);
    expect(suspendDue("2026-10-08", "2026-10-14", 5)).toBe(true);
    expect(suspendDue(undefined, "2030-01-01", 0)).toBe(false);
  });

  test("CSV оплат: формулы в тексте обезврежены, суммы — числа", () => {
    const row: SubscriptionPaymentRow = {
      id: "x",
      tenant: "evil",
      tenantName: "=HYPERLINK(\"http://x\")",
      amount: 15000,
      currency: "KZT",
      method: "kaspi",
      months: 1,
      periodFrom: "2026-10-14",
      periodTo: "2026-11-13",
      paidAt: "2026-10-14T05:00:00.000Z",
      note: "+7 700 оплатил",
      byName: "@admin",
      plan: "standard",
      undoneAt: null,
      canUndo: false,
    };
    const csv = toCsv(paymentsCsv([row], (iso) => iso));
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).toContain(`"'+7 700 оплатил"`);
    expect(csv).toContain(`"'@admin"`);
    expect(csv).toContain(`"15000"`);
    expect(csv).toContain(`"14.10.2026";"13.11.2026"`);
  });
});

// ── Создать компанию ─────────────────────────────────────────────────────────

describe("«Создать компанию» на экране «Платформа»", () => {
  const form = { company: "Мастер на час", slug: "master-almaty", city: "Алматы", plan: "standard" as const, ownerName: "Ерлан Сервис", login: "erlan@master.kz" };

  test("только администратор платформы; компания, владелец с временным паролем, справочник, «оплачено до», журнал", async () => {
    const { t, admin, ownerB, as } = await setup();
    await expect(t.action(api.platform.createCompany, form)).rejects.toThrow("Нет доступа");
    await expect(as(ownerB).action(api.platform.createCompany, form)).rejects.toThrow("Нет доступа");
    const paidUntil = addDays(todayAlmaty(), 30);
    const r = await as(admin).action(api.platform.createCompany, { ...form, paidUntil });
    expect(r.slug).toBe("master-almaty");
    expect(r.login).toBe("erlan@master.kz");
    expect(r.password).toMatch(/^[a-z2-9]{10}$/);
    const ownerId = await t.run(async (ctx) => {
      const tenant = (await ctx.db.query("tenants").withIndex("by_slug", (q) => q.eq("slug", r.slug)).unique())!;
      expect(tenant).toMatchObject({ name: "Мастер на час", plan: "standard", status: "active", city: "Алматы", paidUntil });
      const owner = (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", r.login)).unique())!;
      expect(owner).toMatchObject({ role: "owner", tenantId: r.slug, mustChangePassword: true, name: "Ерлан Сервис" });
      expect(tenant.ownerUserId).toBe(owner._id);
      expect((await ctx.db.query("services").collect()).filter((s) => s.tenantId === r.slug).length).toBeGreaterThan(10);
      const log = (await ctx.db.query("audit").collect()).filter((a) => a.action === "settings.companyRegistered");
      expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ tenantId: r.slug, actorName: "Платформа" });
      // Пароль не попадает ни в журнал, ни в документы.
      expect(JSON.stringify(log)).not.toContain(r.password);
      return owner._id;
    });
    // Владелец входит с временным паролем — до смены только экран «Смените пароль».
    const owner = as(ownerId);
    expect(await owner.query(api.users.me, {})).toMatchObject({ mustChangePassword: true });
    await expect(owner.query(api.tenants.company, {})).rejects.toThrow("Сначала смените временный пароль");
    await owner.action(api.users.changeMyPassword, { current: r.password, next: "Свой-надёжный-пароль-1" });
    expect((await owner.query(api.users.me, {}))?.mustChangePassword).toBeUndefined();
    expect(await owner.query(api.tenants.current, {})).toMatchObject({ slug: "master-almaty", plan: "standard" });
  });

  test("адрес и логин уникальны, адрес и дата проверяются", async () => {
    const { admin, as } = await setup();
    const adm = as(admin);
    await adm.action(api.platform.createCompany, form);
    await expect(adm.action(api.platform.createCompany, { ...form, login: "other@master.kz" })).rejects.toThrow("уже занят");
    await expect(adm.action(api.platform.createCompany, { ...form, slug: B, login: "other@master.kz" })).rejects.toThrow("уже занят");
    await expect(adm.action(api.platform.createCompany, { ...form, slug: "t-komfort", login: "other@master.kz" })).rejects.toThrow("уже занят");
    await expect(adm.action(api.platform.createCompany, { ...form, slug: "другой" })).rejects.toThrow("латиница");
    await expect(adm.action(api.platform.createCompany, { ...form, slug: "another-one" })).rejects.toThrow("логин уже занят");
    await expect(adm.action(api.platform.createCompany, { ...form, slug: "another-one", login: "x@y.kz", paidUntil: addDays(todayAlmaty(), -1) })).rejects.toThrow("Оплачено до");
    await expect(adm.action(api.platform.createCompany, { ...form, slug: "another-one", login: "не логин" })).rejects.toThrow("Логин");
  });
});

// ── Оплаты ───────────────────────────────────────────────────────────────────

describe("приём оплаты и отмена", () => {
  test("продление: действует — с «оплачено до», просрочена — с сегодня; явная дата; проверки", async () => {
    const { admin, as, row, patchRow, t } = await setup();
    const adm = as(admin);
    const today = todayAlmaty();
    await patchRow(B, { paidUntil: addDays(today, 10) });
    const p1 = await adm.mutation(api.billing.acceptPayment, { slug: B, amount: 15000, method: "kaspi", months: 1, note: "чек 123" });
    const from1 = addDays(today, 11);
    expect(p1.paidUntil).toBe(addDays(addMonths(from1, 1), -1));
    expect((await row(B)).paidUntil).toBe(p1.paidUntil);
    // Просрочена на 3 дня — новый период с сегодня, просроченные дни не «съедают» оплату.
    await patchRow(B, { paidUntil: addDays(today, -3) });
    const p2 = await adm.mutation(api.billing.acceptPayment, { slug: B, amount: 30000, method: "transfer", months: 2 });
    expect(p2.paidUntil).toBe(addDays(addMonths(today, 2), -1));
    // Явная дата — от max(оплачено до, сегодня).
    const until = addDays(p2.paidUntil, 40);
    expect((await adm.mutation(api.billing.acceptPayment, { slug: B, amount: 20000, method: "cash", until })).paidUntil).toBe(until);
    await expect(adm.mutation(api.billing.acceptPayment, { slug: B, amount: 1, method: "cash", until: addDays(until, -1) })).rejects.toThrow("раньше его начала");
    await expect(adm.mutation(api.billing.acceptPayment, { slug: B, amount: 1, method: "cash" })).rejects.toThrow("число месяцев или дату");
    await expect(adm.mutation(api.billing.acceptPayment, { slug: B, amount: 1, method: "cash", months: 1, until })).rejects.toThrow("число месяцев или дату");
    await expect(adm.mutation(api.billing.acceptPayment, { slug: B, amount: -5, method: "cash", months: 1 })).rejects.toThrow("Сумма");
    await expect(adm.mutation(api.billing.acceptPayment, { slug: B, amount: 5, method: "cash", months: 0 })).rejects.toThrow("Месяцев");
    await expect(adm.mutation(api.billing.acceptPayment, { slug: "nope", amount: 5, method: "cash", months: 1 })).rejects.toThrow("не найдена");
    const list = await adm.query(api.billing.payments, { slug: B });
    expect(list.map((p) => p.amount)).toEqual([20000, 30000, 15000]);
    expect(list[2]).toMatchObject({ method: "kaspi", months: 1, note: "чек 123", periodFrom: from1, byName: "Админ Платформы", currency: "KZT", plan: "standard" });
    expect(list.map((p) => p.canUndo)).toEqual([true, false, false]);
    // Журнал — у самой компании, от имени платформы.
    const log = await t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((a) => a.action === "settings.subscription"));
    expect(log.map((a) => [a.tenantId, a.actorName])).toEqual([
      [B, "Платформа"],
      [B, "Платформа"],
      [B, "Платформа"],
    ]);
  });

  test("отмена: только последней, в течение суток, «оплачено до» возвращается прежним", async () => {
    const { t, admin, as, row, patchRow } = await setup();
    const adm = as(admin);
    const prev = addDays(todayAlmaty(), 3);
    await patchRow(B, { paidUntil: prev });
    const first = await adm.mutation(api.billing.acceptPayment, { slug: B, amount: 15000, method: "kaspi", months: 1 });
    const second = await adm.mutation(api.billing.acceptPayment, { slug: B, amount: 15000, method: "kaspi", months: 1 });
    await expect(adm.mutation(api.billing.undoPayment, { slug: B, id: first.id })).rejects.toThrow("более позднюю");
    await adm.mutation(api.billing.undoPayment, { slug: B, id: second.id });
    expect((await row(B)).paidUntil).toBe(first.paidUntil);
    await expect(adm.mutation(api.billing.undoPayment, { slug: B, id: second.id })).rejects.toThrow("уже отменена");
    // Сутки прошли — отменить нельзя.
    await t.run((ctx) => ctx.db.patch(first.id, { paidAt: new Date(Date.now() - DAY - 60_000).toISOString() }));
    await expect(adm.mutation(api.billing.undoPayment, { slug: B, id: first.id })).rejects.toThrow("в течение суток");
    expect((await adm.query(api.billing.payments, { slug: B })).map((p) => [p.undoneAt !== null, p.canUndo])).toEqual([
      [true, false],
      [false, false],
    ]);
    // В течение суток — можно; «оплачено до» — как до первой оплаты.
    await t.run((ctx) => ctx.db.patch(first.id, { paidAt: new Date().toISOString() }));
    await adm.mutation(api.billing.undoPayment, { slug: B, id: first.id });
    expect((await row(B)).paidUntil).toBe(prev);
    // Последняя действующая оплата в списке компаний — нет.
    expect((await adm.query(api.platform.tenants, {})).find((r) => r.slug === B)?.lastPayment).toBeNull();
  });
});

// ── Ежедневная проверка ──────────────────────────────────────────────────────

describe("крон подписки: напоминания и приостановка", () => {
  test("за 7 и за 1 день — по одному разу владельцу и администраторам платформы", async () => {
    vi.useFakeTimers({ now: Date.now(), shouldAdvanceTime: true });
    const { t, admin, ownerB, operatorB, patchRow, bell } = await setup();
    const start = Date.now();
    await patchRow(B, { paidUntil: addDays(todayAlmaty(start), 7) });
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 1, suspended: 0 });
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 0, suspended: 0 });
    const owner7 = await bell(ownerB);
    expect(owner7).toHaveLength(1);
    expect(owner7[0]!.text).toContain("осталось 7 дней");
    expect(owner7[0]!.text).toContain("Продлите — напишите нам");
    expect((await bell(admin)).map((n) => n.text)).toEqual([expect.stringContaining("Компания «Компания beta»: подписка до")]);
    expect(await bell(operatorB)).toHaveLength(0);
    // Через 3 дня — ничего нового; за день до конца — второе напоминание, и тоже один раз.
    vi.setSystemTime(start + 3 * DAY);
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 0, suspended: 0 });
    vi.setSystemTime(start + 6 * DAY);
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 1, suspended: 0 });
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 0, suspended: 0 });
    const texts = (await bell(ownerB)).map((n) => n.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("осталось 1 день");
    expect(await bell(admin)).toHaveLength(2);
    // Новый срок — напоминания заново.
    await patchRow(B, { paidUntil: addDays(todayAlmaty(), 7) });
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 1, suspended: 0 });
  });

  test("после льготных дней — приостановка с текстом «Как оплатить»; оплата возобновляет, её отмена — снова пауза", async () => {
    const { t, admin, ownerB, as, row, patchRow } = await setup();
    const adm = as(admin);
    await adm.mutation(api.billing.saveSettings, { graceDays: 5, howToPay: "Kaspi Gold +7 701 000 00 00", prices: { free: 0, standard: 15000, pro: 30000 } });
    const today = todayAlmaty();
    // Ровно 5 льготных дней прошло — ещё работает.
    await patchRow(B, { paidUntil: addDays(today, -5) });
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 0, suspended: 0 });
    expect((await row(B)).status).toBe("active");
    await patchRow(B, { paidUntil: addDays(today, -6) });
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 0, suspended: 1 });
    expect(await row(B)).toMatchObject({ status: "suspended", suspendedFor: "unpaid" });
    // Данные на месте, сотрудники — на экране «Доступ отключён» с причиной и способом оплаты.
    const owner = as(ownerB);
    expect(await owner.query(api.users.me, {})).toBeNull();
    expect(await owner.query(api.billing.blocked, {})).toEqual({ company: "Компания beta", unpaid: true, paidUntil: addDays(today, -6), howToPay: "Kaspi Gold +7 701 000 00 00" });
    await expect(owner.query(api.clients.list, {})).rejects.toThrow("приостановлена");
    expect(await t.run(async (ctx) => (await ctx.db.query("users").collect()).filter((u) => u.tenantId === B).length)).toBe(2);
    const log = await t.run(async (ctx) => (await ctx.db.query("audit").collect()).filter((a) => a.action === "settings.subscription" && a.tenantId === B));
    expect(log[0]).toMatchObject({ actorName: "Система" });
    // Оплата — работа возобновляется сразу.
    const pay = await adm.mutation(api.billing.acceptPayment, { slug: B, amount: 15000, method: "kaspi", months: 1 });
    expect(pay.reactivated).toBe(true);
    expect(await row(B)).toMatchObject({ status: "active", paidUntil: addDays(addMonths(today, 1), -1) });
    expect((await row(B)).suspendedFor).toBeUndefined();
    expect(await owner.query(api.users.me, {})).not.toBeNull();
    expect(await owner.query(api.billing.blocked, {})).toBeNull();
    expect(await owner.query(api.billing.mine, {})).toMatchObject({ plan: "standard", status: { state: "paid" } });
    // Ошиблись — отменили: срок прежний, и он уже за льготными днями — снова пауза.
    await adm.mutation(api.billing.undoPayment, { slug: B, id: pay.id });
    expect(await row(B)).toMatchObject({ status: "suspended", suspendedFor: "unpaid", paidUntil: addDays(today, -6) });
  });

  test("без «оплачено до» — бессрочно; компанию администратора платформы и приостановленную вручную крон и оплата не трогают", async () => {
    const { t, admin, as, row, patchRow } = await setup();
    const adm = as(admin);
    // Демо-компания без строки и компания без срока.
    await t.run((ctx) => ctx.db.insert("tenants", { slug: "t-komfort", name: "Home Max Service", plan: "pro", modules: [...MODULES], status: "active", createdAt: new Date().toISOString() }));
    const old = addDays(todayAlmaty(), -400);
    await patchRow(A, { paidUntil: old });
    expect(await t.mutation(internal.billing.run, {})).toEqual({ reminded: 0, suspended: 0 });
    expect((await row("t-komfort")).status).toBe("active");
    expect((await row(A)).status).toBe("active");
    expect((await row(B)).status).toBe("active");
    // Приостановлена администратором — оплата продлевает срок, но работу не возобновляет.
    await adm.mutation(api.platform.update, { slug: B, status: "suspended" });
    expect((await row(B)).suspendedFor).toBe("manual");
    const pay = await adm.mutation(api.billing.acceptPayment, { slug: B, amount: 15000, method: "card", months: 1 });
    expect(pay.reactivated).toBe(false);
    expect((await row(B)).status).toBe("suspended");
    await adm.mutation(api.platform.update, { slug: B, status: "active" });
    expect((await row(B)).suspendedFor).toBeUndefined();
    // Владелец видит свой срок (компанию администратора крон не приостанавливает, но просрочку показывает).
    expect(await adm.query(api.billing.mine, {})).toMatchObject({ paidUntil: old, status: { state: "expired" } });
  });
});

// ── Права и изоляция ─────────────────────────────────────────────────────────

describe("права и изоляция оплат", () => {
  test("не администратор платформы — отказ во всех функциях платформы; оплаты видны только платформе", async () => {
    const { t, admin, ownerB, operatorB, as } = await setup();
    const pay = await as(admin).mutation(api.billing.acceptPayment, { slug: A, amount: 99_000, method: "transfer", months: 3, note: "АЛЬФАОПЛАТА" });
    for (const caller of [t, as(ownerB), as(operatorB)]) {
      await expect(caller.query(api.billing.settings, {})).rejects.toThrow(/Нет доступа/);
      await expect(caller.mutation(api.billing.saveSettings, { graceDays: 1, howToPay: "x", prices: { free: 0, standard: 0, pro: 0 } })).rejects.toThrow(/Нет доступа/);
      await expect(caller.query(api.billing.payments, { slug: A })).rejects.toThrow(/Нет доступа/);
      await expect(caller.query(api.billing.exportPayments, {})).rejects.toThrow(/Нет доступа/);
      await expect(caller.mutation(api.billing.acceptPayment, { slug: B, amount: 1, method: "cash", months: 12 })).rejects.toThrow(/Нет доступа/);
      await expect(caller.mutation(api.billing.undoPayment, { slug: A, id: pay.id })).rejects.toThrow(/Нет доступа/);
      await expect(caller.query(api.platform.tenants, {})).rejects.toThrow(/Нет доступа/);
      await expect(caller.mutation(api.platform.update, { slug: B, status: "active" })).rejects.toThrow(/Нет доступа/);
      await expect(caller.action(api.platform.createCompany, { company: "Х компания", slug: "x-company", city: "Алматы", plan: "pro", ownerName: "Хан", login: "x@x.kz" })).rejects.toThrow(/Нет доступа/);
    }
    // Своё владельцу B — без чужих оплат; оператору — ничего.
    expect(JSON.stringify(await as(ownerB).query(api.billing.mine, {}))).not.toContain("АЛЬФА");
    expect(await as(operatorB).query(api.billing.mine, {})).toBeNull();
    expect(await t.query(api.billing.blocked, {})).toBeNull();
    // Оплата — документ компании A: из компании B её не видно, и отменить её «как оплату B» нельзя.
    const docs = await t.run(async (ctx) => ctx.db.query("subscriptionPayments").collect());
    expect(docs.map((d) => d.tenantId)).toEqual([A]);
    expect(await as(admin).query(api.billing.payments, { slug: B })).toEqual([]);
    await expect(as(admin).mutation(api.billing.undoPayment, { slug: B, id: pay.id })).rejects.toThrow("Оплата не найдена");
    expect((await as(admin).query(api.billing.exportPayments, {})).map((p) => [p.tenant, p.amount])).toEqual([[A, 99_000]]);
  });
});
