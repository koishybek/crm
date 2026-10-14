/// <reference types="vite/client" />
// Выгрузки для 1С (ТЗ п.19.8): реестр денег (оплаты, сторно, возвраты, выплаты) в CSV и выполненные заказы
// в CommerceML 2 (XML) — только владелец, через общий механизм выгрузок (подписанная ссылка, журнал).
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { commerceMl, xmlText } from "./lib/commerceml";
import { exportFileName } from "../src/data/exports";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const SITE = "https://test.convex.site";
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString();

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
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: iso(now) });
    const client = await ctx.db.insert("clients", { tenantId: T, name: 'ТОО «Ромашка & Ко» <b>', kind: "company", phone: "77071112233", city: "Алматы", source: "olx", tags: [], createdAt: iso(now), ordersCount: 0, activeCount: 0, lastActivityAt: iso(now) });
    return { owner, operator, ex, client };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  let number = 5000;
  const order = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: ++number,
        clientId: ids.client,
        clientName: 'ТОО «Ромашка & Ко» <b>',
        clientPhone: "77071112233",
        source: "olx",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: iso(now),
        priority: "normal",
        status: "paid",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 20000,
        payments: [],
        payoutPaid: false,
        executorId: ids.ex,
        createdAt: iso(now - 5 * DAY),
        createdBy: ids.owner,
        doneAt: iso(now - 3 * DAY),
        files: [],
        ...over,
      }),
    );
  const range = { from: iso(now - 10 * DAY), to: iso(now) };
  const download = async (url: string) => {
    const res = await t.fetch(url.slice(SITE.length));
    expect(res.status).toBe(200);
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(new Uint8Array(await res.arrayBuffer()));
  };
  return { t, now, ids, as, order, range, download };
}

const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));

describe("1С: реестр денег (CSV)", () => {
  test("оплаты, сторно, возвраты и выплаты за период — по датам денег, даты ДД.ММ.ГГГГ, касса/банк; только владелец", async () => {
    const s = await setup();
    const a = await s.order({
      payments: [
        { id: "p1", amount: 30000, method: "kaspi", at: iso(s.now - 3 * DAY), by: s.ids.operator },
        { id: "p2", amount: 5000, method: "cash", at: iso(s.now - 3 * DAY), voidedAt: iso(s.now - 2 * DAY), voidedBy: s.ids.owner, voidReason: "дубль" },
        { id: "old", amount: 999, method: "cash", at: iso(s.now - 40 * DAY) },
      ],
      refunds: [{ id: "r1", amount: 4000, method: "kaspi", at: iso(s.now - DAY), reason: "скидка", by: s.ids.owner }],
      moneyAt: iso(s.now - DAY),
    });
    await s.t.run((ctx) => ctx.db.insert("payouts", { tenantId: T, executorId: s.ids.ex, orderIds: [a], orderNumbers: [5001], amount: 20000, method: "transfer", at: iso(s.now - DAY), by: s.ids.owner, createdAt: iso(s.now - DAY) }));
    await expect(s.as(s.ids.operator).action(api.exports.create, { kind: "accounting", ...s.range })).rejects.toThrow("Нет доступа");
    const r = await s.as(s.ids.owner).action(api.exports.create, { kind: "accounting", ...s.range });
    expect(r.name).toBe(exportFileName("accounting", s.range));
    expect(r.name.endsWith(".csv")).toBe(true);
    const text = await s.download(r.url);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.replace(/^﻿/, "").split("\r\n").map(cells);
    expect(lines[0]).toEqual(["Дата", "Время", "Вид операции", "Приход/расход", "Номер документа", "Основание", "Контрагент", "Сумма", "Валюта", "Способ оплаты", "Счёт учёта", "Комментарий", "Провёл"]);
    const kinds = lines.slice(1).map((l) => [l[2], l[7], l[10]]);
    expect(kinds).toEqual([
      ["Поступление от покупателя", "30000", "Банк"],
      ["Поступление от покупателя", "5000", "Касса"],
      ["Сторно поступления", "-5000", "Касса"],
      ["Возврат покупателю", "4000", "Банк"],
      ["Выплата исполнителю", "20000", "Банк"],
    ]);
    expect(lines[1]![0]).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(lines[1]![12]).toBe("Мадина Оператор");
    expect(lines[5]![6]).toBe("Асет Мастеров");
    expect(text).not.toContain("999");
    const audit = (await s.t.run((ctx) => ctx.db.query("audit").collect())).find((x) => x.action === "export.created")!;
    expect(audit.summary).toContain("1С");
  });
});

describe("1С: CommerceML 2 (XML)", () => {
  test("выполненные заказы периода — документы реализации услуг; отменённые и вне периода — нет; спецсимволы экранированы", async () => {
    const s = await setup();
    await s.order({ payments: [{ id: "p1", amount: 30000, method: "kaspi", at: iso(s.now - 3 * DAY) }] });
    await s.order({ status: "awaiting_payment", clientPrice: 15500 });
    await s.order({ status: "cancelled", doneAt: undefined });
    await s.order({ doneAt: iso(s.now - 30 * DAY) });
    const r = await s.as(s.ids.owner).action(api.exports.create, { kind: "commerceml", ...s.range });
    expect(r.name.endsWith(".xml")).toBe(true);
    expect(r.rows).toBe(2);
    const xml = await s.download(r.url);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<КоммерческаяИнформация ВерсияСхемы="2.10"');
    expect(xml.match(/<Документ>/g)).toHaveLength(2);
    expect(xml).toContain("<Номер>5001</Номер>");
    expect(xml).toContain("<Номер>5002</Номер>");
    expect(xml).not.toContain("<Номер>5003</Номер>");
    expect(xml).toContain("<Сумма>15500.00</Сумма>");
    expect(xml).toContain("<Значение>Реализация услуг</Значение>");
    expect(xml).toContain("<Значение>Услуга</Значение>");
    expect(xml).toContain("ТОО «Ромашка &amp; Ко» &lt;b&gt;");
    expect(xml).not.toContain("<b>");
  });

  test("сборщик XML: пустой период — корректный пустой файл, управляющие символы убраны", () => {
    expect(commerceMl([], "2026-10-14T07:00:00.000Z")).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<КоммерческаяИнформация ВерсияСхемы="2.10" ДатаФормирования="2026-10-14T12:00:00">\n</КоммерческаяИнформация>\n');
    expect(xmlText("a\u0001b\"'")).toBe("ab&quot;&apos;");
  });
});
