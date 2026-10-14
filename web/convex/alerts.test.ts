/// <reference types="vite/client" />
// Оповещения владельцу (ТЗ п.26.5): первая ошибка подсистемы после успеха — сразу, в колокольчик, Telegram и на
// email; не чаще раза в час на подсистему; «восстановилось» — одним сообщением; «давно не отрабатывала» — кроном.
// Ошибки интерфейса: без данных людей, с лимитом, одинаковые — одной строкой, список — только владельцу.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { markError, type HealthKey } from "./lib/health";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const MIN = 60_000;
const START = new Date("2026-10-14T05:00:00.000Z").getTime();
type Call = { url: string; body: Record<string, unknown> };
let calls: Call[];

beforeEach(() => {
  calls = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
  vi.stubEnv("TELEGRAM_BOT_USERNAME", "test_bot");
  vi.stubEnv("EMAIL_API_KEY", "re_test");
  vi.stubEnv("EMAIL_FROM", "Home Max Service <noreply@notify.homemax.kz>");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      return String(url).includes("resend") ? Response.json({ id: "email-1" }) : Response.json({ ok: true, result: {} });
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
  const ids = await t.run(async (ctx) => ({
    owner: await ctx.db.insert("users", { name: "Владелец", email: "owner@homemax.kz", role: "owner", tenantId: "t-komfort", active: true, telegramChatId: "111", notifyEmail: true }),
    operator: await ctx.db.insert("users", { name: "Оператор", email: "op@homemax.kz", role: "operator", tenantId: "t-komfort", active: true, telegramChatId: "222" }),
  }));
  const mark = (key: HealthKey, ok: boolean, note: string) => t.mutation(internal.health._mark, { key, ok, note });
  const bell = async (userId: Id<"users">) => (await t.run((ctx) => ctx.db.query("notifications").collect())).filter((n) => n.userId === userId).map((n) => n.text);
  const flush = () => t.finishAllScheduledFunctions(() => {});
  const at = (ms: number) => vi.setSystemTime(START + ms);
  return { t, ids, mark, bell, flush, at };
}

describe("оповещения о сбоях", () => {
  test("первая ошибка после успеха — владельцу в колокольчик, Telegram и на email; операторам — нет; повтор ошибки — тишина", async () => {
    const { ids, mark, bell, flush, at } = await setup();
    await mark("backup", true, "120 записей");
    at(MIN);
    await mark("backup", false, "Копия не создана: нет места");
    await flush();
    expect(await bell(ids.owner)).toEqual(["⚠️ Резервные копии. Сбой: Копия не создана: нет места"]);
    expect(await bell(ids.operator)).toEqual([]);
    const tg = calls.filter((c) => c.url.includes("api.telegram.org"));
    expect(tg.map((c) => String(c.body.chat_id))).toEqual(["111"]);
    const mail = calls.filter((c) => c.url.includes("resend"));
    expect(mail).toHaveLength(1);
    expect(mail[0]?.body.to).toEqual(["owner@homemax.kz"]);

    at(5 * MIN);
    await mark("backup", false, "Копия не создана: таймаут");
    expect(await bell(ids.owner)).toHaveLength(1);
  });

  test("восстановилось — одно сообщение; дальше успехи молча", async () => {
    const { ids, mark, bell, at } = await setup();
    await mark("olx", false, "OLX: 401");
    at(2 * MIN);
    await mark("olx", true, "Синхронизация: новых сообщений нет");
    at(4 * MIN);
    await mark("olx", true, "Синхронизация: новых сообщений 2");
    expect(await bell(ids.owner)).toEqual(["⚠️ OLX. Сбой: OLX: 401", "✅ OLX: восстановилось, снова работает"]);
  });

  test("не чаще раза в час на подсистему: сбой в паузе сообщит крон после паузы; другие подсистемы — сразу", async () => {
    const { t, ids, mark, bell, at } = await setup();
    await mark("pbx", false, "Неверный ключ АТС");
    at(MIN);
    await mark("pbx", true, "Звонок принят");
    at(10 * MIN);
    await mark("pbx", false, "Ошибка разбора события");
    await mark("whatsapp", false, "Meta 401");
    expect(await bell(ids.owner)).toEqual(["⚠️ Телефония (АТС). Сбой: Неверный ключ АТС", "✅ Телефония (АТС): восстановилось, снова работает", "⚠️ WhatsApp. Сбой: Meta 401"]);

    at(30 * MIN);
    await t.mutation(internal.alerts.check, {});
    expect(await bell(ids.owner)).toHaveLength(3);
    at(61 * MIN);
    expect((await t.mutation(internal.alerts.check, {})).alerted).toEqual(["pbx"]);
    expect((await bell(ids.owner)).at(-1)).toBe("⚠️ Телефония (АТС). Сбой: Ошибка разбора события");
    // Об этом сбое уже сообщили — следующий проход молчит.
    at(130 * MIN);
    expect((await t.mutation(internal.alerts.check, {})).alerted).toEqual([]);
  });

  test("давно не отрабатывала: напоминания > 30 мин, копия > 26 ч; OLX — только подключённый", async () => {
    const { t, ids, mark, bell, at } = await setup();
    await mark("reminders", true, "Проверено");
    await mark("backup", true, "Копия");
    await mark("olx", true, "Синхронизация");
    at(29 * MIN);
    expect((await t.mutation(internal.alerts.check, {})).alerted).toEqual([]);
    at(31 * MIN);
    expect((await t.mutation(internal.alerts.check, {})).alerted).toEqual(["reminders"]);
    expect((await bell(ids.owner))[0]).toMatch(/^⚠️ Напоминания о сроках\. Давно не отрабатывало: последний успешный запуск 14\.10\.2026 10:00$/);

    at(27 * 60 * MIN);
    const second = (await t.mutation(internal.alerts.check, {})).alerted;
    expect(second).toContain("backup");
    // OLX не подключён (строки интеграции нет) — его молчание законно.
    expect(second).not.toContain("olx");
    await t.run((ctx) => ctx.db.insert("integrations", { provider: "olx", status: "connected" }));
    expect((await t.mutation(internal.alerts.check, {})).alerted).toEqual(["olx"]);

    // Крон снова отработал — одно «восстановилось».
    await mark("reminders", true, "Проверено снова");
    expect((await bell(ids.owner)).at(-1)).toBe("✅ Напоминания о сроках: восстановилось, снова работает");
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.filter((a) => a.action === "system.alert")).toHaveLength(3);
    expect(journal.filter((a) => a.action === "system.alertRecovered")).toHaveLength(1);
  });
});

describe("без дублей", () => {
  test("о сбое почты письмом не сообщаем — только колокольчик и Telegram", async () => {
    const { ids, mark, bell, flush } = await setup();
    await mark("email", false, "Resend: HTTP 401");
    await flush();
    expect(await bell(ids.owner)).toEqual(["⚠️ Email. Сбой: Resend: HTTP 401"]);
    // Фоновые отправки соседних сценариев тоже попадают в заглушку — считаем только про этот сбой.
    const about = (host: string) => calls.filter((c) => c.url.includes(host) && JSON.stringify(c.body).includes("Resend: HTTP 401"));
    expect(about("resend")).toHaveLength(0);
    expect(about("api.telegram.org")).toHaveLength(1);
  });

  test("владельцу уже написали сами (OLX отключился) — второго сообщения нет, «восстановилось» — есть", async () => {
    const { t, ids, mark, bell, at } = await setup();
    await t.run((ctx) => markError(ctx, "olx", "Нужно заново подключить OLX", { ownerNotified: true }));
    expect(await bell(ids.owner)).toEqual([]);
    at(61 * MIN);
    expect((await t.mutation(internal.alerts.check, {})).alerted).toEqual([]);
    await mark("olx", true, "Подключён аккаунт Home Max");
    expect(await bell(ids.owner)).toEqual(["✅ OLX: восстановилось, снова работает"]);
  });
});

describe("ошибки интерфейса", () => {
  const report = { message: "", path: "/", build: "abc1234", kind: "error" as const };

  test("без данных людей: почта, телефоны, токены и параметры ссылок вычищены; путь без параметров", async () => {
    const { t, ids } = await setup();
    await t.mutation(api.clientErrors.report, {
      ...report,
      message: "TypeError: нет клиента ivan.petrov@mail.kz, тел. +7 701 123-45-67, токен abcdefghijklmnopqrstuvwxyz0123456789ABCD, https://app.test/orders/1?phone=77011234567",
      path: "/clients/k57abc?phone=77011234567#tab",
    });
    const rows = await t.withIdentity({ subject: `${ids.owner}|s` }).query(api.clientErrors.recent, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toBe("TypeError: нет клиента [email], тел. [номер], токен [токен], https://app.test/orders/1");
    expect(rows[0]?.path).toBe("/clients/k57abc");
    expect(rows[0]?.role).toBeUndefined();
  });

  test("одинаковые — одной строкой со счётчиком; роль вошедшего; список — только владельцу", async () => {
    const { t, ids } = await setup();
    const asOp = t.withIdentity({ subject: `${ids.operator}|s` });
    for (let i = 0; i < 3; i++) await asOp.mutation(api.clientErrors.report, { ...report, message: "Error: boom", path: "/orders" });
    const rows = await t.withIdentity({ subject: `${ids.owner}|s` }).query(api.clientErrors.recent, {});
    expect(rows).toEqual([expect.objectContaining({ message: "Error: boom", count: 3, role: "operator", build: "abc1234" })]);
    await expect(asOp.query(api.clientErrors.recent, {})).rejects.toThrow("Нет доступа");
  });

  test("лимит: от невошедших — не больше 20 за 10 минут, лишнее молча отбрасывается; старше двух недель — уборка", async () => {
    const { t, ids, at } = await setup();
    for (let i = 0; i < 25; i++) await t.mutation(api.clientErrors.report, { ...report, message: `Error: n${i}` });
    const count = async () => (await t.run((ctx) => ctx.db.query("clientErrors").collect())).length;
    expect(await count()).toBe(20);
    at(15 * 86400_000);
    await t.mutation(internal.alerts.check, {});
    expect(await count()).toBe(0);
    expect(await t.withIdentity({ subject: `${ids.owner}|s` }).query(api.clientErrors.recent, {})).toEqual([]);
  });
});
