/// <reference types="vite/client" />
// «Состояние системы» (ТЗ п.20 «мониторинг»): отметки подсистем (АТС, AI, напоминания), сводка для владельца
// и правила цвета на экране.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { subsystemView, systemViews, type SubsystemInfo } from "../src/data/systemHealth";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => ({
    owner: await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true }),
    operator: await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true }),
  }));
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const mark = (key: string) => t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", key)).unique());
  return { t, ids, as, mark };
}

const post = (body: string, type = "application/json") => ({ method: "POST", body, headers: { "Content-Type": type } });

describe("отметки подсистем", () => {
  test("АТС: неверный ключ и нечитаемое событие — красная отметка; принятое событие — зелёная", async () => {
    const { t, ids, as, mark } = await setup();
    const secret = await as(ids.owner).mutation(api.calls.regeneratePbxSecret, {});
    expect((await t.fetch("/pbx/events?secret=nope", post(JSON.stringify({ event: "ringing" })))).status).toBe(403);
    expect((await mark("pbx"))?.error).toBe("АТС прислала событие без ключа или с неверным ключом");

    expect((await t.fetch(`/pbx/events?secret=${secret}`, post("{не json"))).status).toBe(400);
    expect((await mark("pbx"))?.error).toBe("АТС прислала событие, которое не удалось прочитать");
    expect((await t.fetch(`/pbx/events?secret=${secret}`, post(JSON.stringify({ callId: "c1" })))).status).toBe(400);
    expect((await mark("pbx"))?.error).toBe("АТС прислала событие без типа (event)");

    expect((await t.fetch(`/pbx/events?secret=${secret}`, post(JSON.stringify({ event: "ringing", callId: "c1", from: "+77071234567" })))).status).toBe(200);
    const pbx = await mark("pbx");
    expect(pbx?.okNote).toBe("Событие АТС принято");
    expect(pbx!.okAt! >= pbx!.errorAt!).toBe(true);
  });

  test("напоминания о сроках отмечают каждый запуск", async () => {
    const { t, mark } = await setup();
    await t.mutation(internal.reminders.run, {});
    expect((await mark("reminders"))?.okNote).toBe("Проверено активных заказов: 0");
  });

  test("AI: сбой провайдера — красная отметка с причиной, удачный разбор — зелёная", async () => {
    const { ids, as, mark } = await setup();
    vi.stubEnv("AI_URL", "https://ai.test");
    vi.stubEnv("AI_SECRET", "secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    await expect(as(ids.operator).action(api.ai.parseText, { text: "Не холодит кондиционер, Алматы" })).rejects.toThrow();
    expect((await mark("ai"))?.error).toBe("Разбор текста: AI не смог обработать запрос");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ summary: "Не холодит кондиционер", serviceId: "ac-repair", city: "Алматы", address: null, when: null, budget: null, urgency: "normal", clientName: null, questions: [] })),
    );
    await as(ids.operator).action(api.ai.parseText, { text: "Не холодит кондиционер, Алматы" });
    expect((await mark("ai"))?.okNote).toBe("Разбор текста");
  });

  test("одна и та же отметка чаще раза в минуту строку не переписывает", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    const { t, mark } = await setup();
    const ok = () => t.mutation(internal.health._mark, { key: "pbx", ok: true, note: "Событие АТС принято" });
    await ok();
    vi.setSystemTime(new Date("2026-10-13T10:00:30Z"));
    await ok();
    expect((await mark("pbx"))?.okAt).toBe("2026-10-13T10:00:00.000Z");
    // Ошибка после успеха пишется сразу, следующий успех — тоже.
    await t.mutation(internal.health._mark, { key: "pbx", ok: false, note: "Неверный ключ" });
    expect((await mark("pbx"))?.errorAt).toBe("2026-10-13T10:00:30.000Z");
    vi.setSystemTime(new Date("2026-10-13T10:00:40Z"));
    await ok();
    expect((await mark("pbx"))?.okAt).toBe("2026-10-13T10:00:40.000Z");
    vi.setSystemTime(new Date("2026-10-13T10:01:41Z"));
    await ok();
    expect((await mark("pbx"))?.okAt).toBe("2026-10-13T10:01:41.000Z");
  });
});

describe("сводка «Состояние системы»", () => {
  test("только владелец; подключено ли — по окружению и настройкам, секреты не отдаются", async () => {
    const { ids, as } = await setup();
    await expect(as(ids.operator).query(api.health.overview, {})).rejects.toThrow("Нет доступа");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "123:secret-token");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "hms_bot");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "wh-secret");
    const o = await as(ids.owner).query(api.health.overview, {});
    const by = Object.fromEntries(o.subsystems.map((s) => [s.key, s]));
    expect(Object.keys(by).sort()).toEqual(["ai", "api", "backup", "email", "escalations", "olx", "payments", "pbx", "reminders", "site", "telegram", "whatsapp"]);
    expect(by.payments?.configured).toBe(false);
    expect(by.telegram?.configured).toBe(true);
    expect(by.ai?.configured).toBe(false);
    expect(by.pbx?.configured).toBe(false);
    expect(by.whatsapp?.hint).toContain("WHATSAPP_TOKEN");
    expect(JSON.stringify(o)).not.toContain("secret-token");
  });
});

describe("цвет подсистемы на экране", () => {
  const NOW = Date.parse("2026-10-13T10:00:00Z");
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const view = (s: Partial<SubsystemInfo> & Pick<SubsystemInfo, "key">) => subsystemView({ configured: true, ...s }, NOW);

  test("не подключено — серый, с подсказкой", () => {
    expect(view({ key: "whatsapp", configured: false, hint: "Не заданы: WHATSAPP_TOKEN" })).toMatchObject({ state: "off", detail: "Не заданы: WHATSAPP_TOKEN" });
  });

  test("последняя — ошибка: красный; потом был успех: зелёный", () => {
    expect(view({ key: "ai", mark: { okAt: ago(30), errorAt: ago(5), error: "AI недоступен" } })).toMatchObject({ state: "bad", detail: "AI недоступен" });
    expect(view({ key: "ai", mark: { okAt: ago(1), okNote: "Звонок разобран", errorAt: ago(5), error: "AI недоступен" } })).toMatchObject({ state: "ok", detail: "Звонок разобран" });
  });

  test("регулярная задача давно не отрабатывала — красный; ещё не запускалась — жёлтый", () => {
    expect(view({ key: "reminders", mark: { okAt: ago(20) } }).state).toBe("ok");
    expect(view({ key: "reminders", mark: { okAt: ago(60) } })).toMatchObject({ state: "bad", detail: "Давно не запускалось — проверьте расписание задач Convex" });
    expect(view({ key: "backup", mark: { okAt: ago(27 * 60) } }).state).toBe("bad");
    expect(view({ key: "backup" })).toMatchObject({ state: "warn", detail: "Копий ещё нет — первая будет ночью" });
  });

  test("интеграция в ошибке — красный; работает не полностью — жёлтый; сбои — первыми", () => {
    expect(view({ key: "olx", issue: "Доступ к OLX потерян", mark: { okAt: ago(1) } })).toMatchObject({ state: "bad", detail: "Доступ к OLX потерян" });
    expect(view({ key: "ai", warning: "Расшифровка не настроена", mark: { okAt: ago(1) } })).toMatchObject({ state: "warn" });
    const order = systemViews({ subsystems: [{ key: "site", configured: false }, { key: "ai", configured: true, mark: { okAt: ago(1) } }, { key: "pbx", configured: true, mark: { errorAt: ago(1), error: "x" } }] }, NOW);
    expect(order.map((v) => v.state)).toEqual(["bad", "ok", "off"]);
  });
});
