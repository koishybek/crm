/// <reference types="vite/client" />
// Кампании и метки рекламы (ТЗ п.6.6, п.28.5): utm из формы сайта и API → заявка → заказ, расходы на кампании,
// заявки/заказы/выручка и CPL/CPO/ROMI по кампании за период.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { monthOf } from "../src/data/analytics";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const DAY = 86400_000;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ok: true, result: {} })),
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
  const sitePost = (body: Record<string, unknown>) =>
    t.fetch("/public/lead", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Айгерим", phone: "+7 701 555 44 33", serviceId: "ac-clean", city: "Алматы", description: "Почистить кондиционер", consent: true, startedAt: Date.now() - 20_000, website: "", ...body }),
    });
  const leadByNumber = (number: number) => t.run((ctx) => ctx.db.query("leads").withIndex("by_number", (q) => q.eq("number", number)).first());
  return { t, ids, as, sitePost, leadByNumber };
}

describe("метки рекламы в заявке", () => {
  test("форма сайта: utm_* из адреса страницы → поля заявки и кампания; при создании заказа — копия в заказ", async () => {
    const s = await setup();
    const res = await s.sitePost({ utm_source: "instagram", utm_medium: "cpc", utm_campaign: "ac-oct", utm_content: "=HYPERLINK(1)", utm_term: "" });
    expect(res.status).toBe(201);
    const { number } = (await res.json()) as { number: number };
    const lead = (await s.leadByNumber(number))!;
    // Формула в начале метки срезана (метки уходят в выгрузки CSV), пустая метка не сохраняется.
    expect(lead.utm).toEqual({ source: "instagram", medium: "cpc", campaign: "ac-oct", content: "HYPERLINK(1)" });
    expect(lead.campaign).toBe("ac-oct");
    const order = await s.as(s.ids.operator).mutation(api.leads.convert, { id: lead._id });
    const o = (await s.t.run((ctx) => ctx.db.get(order.id)))!;
    expect(o.utm).toEqual(lead.utm);
    expect(o.campaign).toBe("ac-oct");
    // В карточке заказа кампания видна.
    const detail = await s.as(s.ids.operator).query(api.orders.detail, { id: order.id });
    expect(detail!.order.campaign).toBe("ac-oct");
  });

  test("API: utm объектом и явная кампания; неверный тип — 400", async () => {
    const s = await setup();
    const { key } = await s.as(s.ids.owner).mutation(api.apiKeys.create, { name: "Реклама" });
    const post = (body: Record<string, unknown>) =>
      s.t.fetch("/api/v1/leads", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ name: "Ерлан", phone: "+77014445566", description: "Не сливает воду", ...body }),
      });
    const r1 = (await (await post({ utm: { source: "google", campaign: "wm-autumn" } })).json()) as { number: number };
    expect((await s.leadByNumber(r1.number))!).toMatchObject({ utm: { source: "google", campaign: "wm-autumn" }, campaign: "wm-autumn" });
    const r2 = (await (await post({ utm_source: "2gis", campaign: "Партнёр 2ГИС", externalId: "x-2" })).json()) as { number: number };
    expect((await s.leadByNumber(r2.number))!).toMatchObject({ utm: { source: "2gis" }, campaign: "Партнёр 2ГИС" });
    expect((await post({ utm: "instagram", externalId: "x-3" })).status).toBe(400);
    expect((await post({ campaign: 5, externalId: "x-4" })).status).toBe(400);
  });
});

describe("карточка «Кампании»", () => {
  test("заявки, заказы, выручка, маржа и CPL/CPO/ROMI по кампании за период; заявки без кампании не в счёт", async () => {
    // Середина месяца: заявки «вчера» и расходы месяца — в одном месяце в любой день прогона.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T07:00:00.000Z"));
    const s = await setup();
    const now = Date.now();
    const iso = (ms: number) => new Date(now + ms).toISOString();
    await s.t.run(async (ctx) => {
      const client = await ctx.db.insert("clients", { tenantId: T, name: "К", kind: "person", phone: "77070000001", city: "Алматы", source: "site", tags: [], createdAt: iso(-DAY), ordersCount: 0, activeCount: 0, lastActivityAt: iso(-DAY) });
      const lead = (number: number, campaign: string | undefined, status: "new" | "converted") =>
        ctx.db.insert("leads", { tenantId: T, number, clientId: client, clientName: "К", clientPhone: "77070000001", source: "site", serviceId: "ac-clean", city: "Алматы", description: "—", urgency: "normal", status, createdAt: iso(-DAY), campaign, utm: campaign ? { campaign } : undefined });
      await lead(1, "ac-oct", "converted");
      await lead(2, "ac-oct", "new");
      await lead(3, "ac-oct", "new");
      await lead(4, "ac-oct", "new");
      await lead(5, "wm-autumn", "new");
      await lead(6, undefined, "converted");
      // Выполненный заказ кампании: выручка 40 000, мастеру 28 000 → маржа 12 000.
      await ctx.db.insert("orders", {
        tenantId: T, number: 1, clientId: client, clientName: "К", clientPhone: "77070000001", source: "site", serviceId: "ac-clean", category: "ac", description: "—", city: "Алматы", address: "—",
        deadline: iso(0), priority: "normal", status: "paid", clientPrice: 40000, payoutMode: "fixed", payoutValue: 28000, payments: [{ id: "p", amount: 40000, method: "kaspi", at: iso(-3600_000) }],
        payoutPaid: false, createdAt: iso(-DAY), createdBy: s.ids.owner, doneAt: iso(-7200_000), files: [], campaign: "ac-oct",
      });
    });
    const month = monthOf(now);
    await expect(s.as(s.ids.operator).mutation(api.campaigns.setSpend, { month, items: [{ campaign: "ac-oct", amount: 10000 }] })).rejects.toThrow();
    await s.as(s.ids.owner).mutation(api.campaigns.setSpend, { month, items: [{ campaign: "ac-oct", amount: 10000 }] });
    // Период — весь текущий месяц: в отчёт попадает вся месячная сумма.
    const [y, m] = month.split("-").map(Number) as [number, number];
    const from = new Date(Date.UTC(y, m - 1, 1) - 5 * 3600_000).toISOString();
    const to = new Date(Date.UTC(y, m, 1) - 5 * 3600_000 - 1).toISOString();
    await expect(s.as(s.ids.operator).query(api.campaigns.stats, { from, to })).rejects.toThrow();
    const rows = await s.as(s.ids.owner).query(api.campaigns.stats, { from, to });
    expect(rows.map((r) => r.campaign)).toEqual(["ac-oct", "wm-autumn"]);
    const ac = rows[0]!;
    expect(ac).toMatchObject({ leads: 4, orders: 1, conversion: 0.25, done: 1, revenue: 40000, margin: 12000 });
    expect(ac.spend).toBeCloseTo(10000, 6);
    expect(ac.cpl).toBeCloseTo(2500, 6);
    expect(ac.cpo).toBeCloseTo(10000, 6);
    expect(ac.romi).toBeCloseTo(0.2, 6);
    expect(rows[1]).toMatchObject({ leads: 1, orders: 0, spend: 0, cpl: null, romi: null });

    // Редактор: суммы месяца и кампании из недавних заявок; 0 — строка уходит.
    const editor = await s.as(s.ids.owner).query(api.campaigns.spendMonth, { month });
    expect(editor.rows).toEqual([{ month, campaign: "ac-oct", amount: 10000 }]);
    expect(editor.known).toEqual(["ac-oct", "wm-autumn"]);
    expect(await s.as(s.ids.owner).mutation(api.campaigns.setSpend, { month, items: [{ campaign: "ac-oct", amount: 0 }] })).toEqual({ changed: 1 });
    expect((await s.as(s.ids.owner).query(api.campaigns.spendMonth, { month })).rows).toEqual([]);
  });

  test("период длиннее года и будущий месяц расходов — отказ", async () => {
    const s = await setup();
    await expect(s.as(s.ids.owner).query(api.campaigns.stats, { from: "2024-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" })).rejects.toThrow("не больше года");
    await expect(s.as(s.ids.owner).mutation(api.campaigns.setSpend, { month: "2999-01", items: [{ campaign: "x", amount: 1 }] })).rejects.toThrow();
  });
});
