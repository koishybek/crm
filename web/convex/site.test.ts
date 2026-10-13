/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { normalizeOrigin, originAllowed, parseSiteLead } from "./site";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";

beforeEach(() => {
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
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    return { owner, operator };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, ids, as };
}

const form = (extra: Record<string, unknown> = {}) => ({
  name: "Айгерим",
  phone: "+7 (701) 555-44-33",
  serviceId: "ac-clean",
  city: "Алматы",
  description: "Почистить два кондиционера",
  consent: true,
  startedAt: Date.now() - 20_000,
  website: "",
  ...extra,
});

type T_ = Awaited<ReturnType<typeof setup>>["t"];
const post = (t: T_, body: unknown, headers: Record<string, string> = {}) =>
  t.fetch("/public/lead", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://homemax.kz", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("форма заявки с сайта", () => {
  test("заявка → клиент, заявка «Сайт», диалог «Сайт», уведомление команде и запись в журнале", async () => {
    const { t, ids } = await setup();
    const res = await post(t, form({ utm_source: "instagram", utm_campaign: "ac-oct" }));
    expect(res.status).toBe(201);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://homemax.kz");
    const { number } = (await res.json()) as { number: number };
    const [lead] = await t.run((ctx) => ctx.db.query("leads").collect());
    expect(lead).toMatchObject({ number, source: "site", serviceId: "ac-clean", city: "Алматы", clientPhone: "77015554433", clientName: "Айгерим", description: "Почистить два кондиционера", status: "new" });
    expect(lead!.comment).toBe("Метки рекламы: utm_source=instagram, utm_campaign=ac-oct");
    const client = await t.run((ctx) => ctx.db.get(lead!.clientId));
    expect(client).toMatchObject({ name: "Айгерим", source: "site", phone: "77015554433" });
    const [conv] = await t.run((ctx) => ctx.db.query("conversations").collect());
    expect(conv).toMatchObject({ channel: "site", externalId: "77015554433", leadId: lead!._id, clientId: lead!.clientId, contactName: "Айгерим" });
    const [m] = await t.run((ctx) => ctx.db.query("conversationMessages").collect());
    expect(m!.text).toContain(`Заявка №${number} с сайта`);
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((x) => x.action === "lead.create")).toMatchObject({ actorName: "Сайт", entityId: lead!._id });
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.map((n) => n.userId).sort()).toEqual([ids.owner, ids.operator].sort());
    expect(notes[0]!.text).toContain(`Новая заявка №${number} с сайта`);
    expect((await t.run((ctx) => ctx.db.query("systemStatus").collect())).find((x) => x.key === "site")?.okAt).toBeDefined();
  });

  test("имя-формула не попадает в базу как формула (выгрузки CSV/Excel)", async () => {
    const { t } = await setup();
    expect((await post(t, form({ name: '=HYPERLINK("http://evil.example","Нажми")' }))).status).toBe(201);
    const [client] = await t.run((ctx) => ctx.db.query("clients").collect());
    expect(client!.name).toBe('HYPERLINK("http://evil.example","Нажми")');
  });

  test("та же заявка повторно в течение 10 минут — тот же номер, без дубля", async () => {
    const { t } = await setup();
    const a = (await (await post(t, form())).json()) as { number: number };
    const again = await post(t, form({ phone: "87015554433" }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { number: number }).number).toBe(a.number);
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(1);
  });

  test("ловушка для ботов, слишком быстрая отправка, без согласия, не казахстанский номер — отказ, заявки нет", async () => {
    const { t } = await setup();
    const cases: [Record<string, unknown>, string][] = [
      [{ website: "http://spam.example" }, "Не удалось отправить"],
      [{ startedAt: Date.now() - 1000 }, "Слишком быстро"],
      [{ startedAt: undefined }, "Обновите страницу"],
      [{ consent: false }, "согласие"],
      [{ phone: "+7 995 123 45 67" }, "казахстанский номер"],
      [{ phone: "12345" }, "казахстанский номер"],
      [{ name: "" }, "Укажите имя"],
      [{ description: "а".repeat(2001) }, "не длиннее 2000"],
      [{ name: 42 }, "ожидалась строка"],
    ];
    for (const [patch, error] of cases) {
      const res = await post(t, form(patch));
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain(error);
    }
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(0);
  });

  test("лимиты: 3 разные заявки с номера в час, 60 заявок в минуту на всех", async () => {
    const { t } = await setup();
    for (const d of ["Почистить кондиционер", "Заправить кондиционер", "Установить кондиционер"]) expect((await post(t, form({ description: d }))).status).toBe(201);
    const fourth = await post(t, form({ description: "Перенести кондиционер" }));
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("retry-after")).toBe("60");
    expect(((await fourth.json()) as { error: string }).error).toContain("уже есть заявки");
    // Общий лимит: счётчик уже на пределе.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("rateLimits").withIndex("by_key", (q) => q.eq("key", "site:all")).unique();
      await ctx.db.patch(row!._id, { count: 60 });
    });
    const flood = await post(t, form({ phone: "+77019998877" }));
    expect(flood.status).toBe(429);
    expect(await t.run((ctx) => ctx.db.query("leads").collect())).toHaveLength(3);
  });

  test("CORS: preflight; при заданном APP_URL чужой сайт — 403, своё приложение и сайты из настроек — можно", async () => {
    const { t, as, ids } = await setup();
    const pre = await t.fetch("/public/lead", { method: "OPTIONS", headers: { Origin: "https://homemax.kz", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://homemax.kz");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect(pre.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");

    vi.stubEnv("APP_URL", "https://app.homemax.kz/");
    expect((await post(t, form(), { Origin: "https://evil.example" })).status).toBe(403);
    expect((await t.fetch("/public/lead", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect((await post(t, form(), { Origin: "https://homemax.kz" })).status).toBe(403);
    const own = await post(t, form({ description: "С самой формы /zayavka" }), { Origin: "https://app.homemax.kz" });
    expect(own.status).toBe(201);
    expect(own.headers.get("access-control-allow-origin")).toBe("https://app.homemax.kz");

    await expect(as(ids.operator).mutation(api.site.setOrigins, { origins: ["homemax.kz"] })).rejects.toThrow("Нет доступа");
    await expect(as(ids.owner).mutation(api.site.setOrigins, { origins: ["не адрес сайта ::"] })).rejects.toThrow("Не похоже на адрес сайта");
    expect(await as(ids.owner).mutation(api.site.setOrigins, { origins: ["homemax.kz", " https://www.homemax.kz/contacts ", ""] })).toEqual(["https://homemax.kz", "https://www.homemax.kz"]);
    expect((await post(t, form({ description: "С сайта компании" }), { Origin: "https://www.homemax.kz" })).status).toBe(201);
    const settings = await as(ids.owner).query(api.site.settings, {});
    expect(settings).toMatchObject({ origins: ["https://homemax.kz", "https://www.homemax.kz"], appUrl: "https://app.homemax.kz" });
  });

  test("тело больше 10 КБ, не JSON и неверный JSON — отказ", async () => {
    const { t } = await setup();
    expect((await post(t, form({ description: "x".repeat(11_000) }))).status).toBe(413);
    expect((await post(t, "name=1", { "Content-Type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post(t, "{not json")).status).toBe(400);
    expect((await post(t, "[1,2]")).status).toBe(400);
  });

  test("справочник для формы — без входа, только названия активных услуг, без цен", async () => {
    const { t } = await setup();
    const list = await t.query(api.catalog.publicList, {});
    expect(list.categories.length).toBeGreaterThan(0);
    expect(list.services.some((s) => s.id === "ac-clean")).toBe(true);
    expect(list.services.some((s) => s.id === "other")).toBe(false);
    for (const s of list.services) expect(Object.keys(s).sort()).toEqual(["category", "id", "label"]);
  });
});

describe("проверки формы без базы", () => {
  test("часы клиента спешат на минуту — заявка принимается; на час — просим проверить время", () => {
    const now = Date.now();
    expect(parseSiteLead(form({ startedAt: now + 60_000 }), now).ok).toBe(true);
    const far = parseSiteLead(form({ startedAt: now + 3600_000 }), now);
    expect(far.ok).toBe(false);
  });

  test("адрес сайта нормализуется до origin; без настроек принимаем всех, localhost — всегда", () => {
    expect(normalizeOrigin("homemax.kz")).toBe("https://homemax.kz");
    expect(normalizeOrigin("http://localhost:5190/zayavka")).toBe("http://localhost:5190");
    expect(normalizeOrigin("ftp://x.kz")).toBeNull();
    expect(originAllowed("https://any.kz", { app: null, sites: [] })).toBe(true);
    expect(originAllowed("https://any.kz", { app: "https://app.kz", sites: [] })).toBe(false);
    expect(originAllowed("http://localhost:5190", { app: "https://app.kz", sites: [] })).toBe(true);
    expect(originAllowed(null, { app: "https://app.kz", sites: [] })).toBe(true);
  });
});
