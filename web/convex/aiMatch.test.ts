/// <reference types="vite/client" />
// AI-подбор исполнителя (ТЗ п.12.7, п.23.1): порядок от LLM среди подходящих по правилам, без данных клиента и имён,
// только с согласия владельца; выключен, не подключён или сбой — рекомендация по правилам.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { buildMatchPrompt, parseMatchAnswer } from "../src/data/aiMatch";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const LLM_URL = "https://llm.test/v1/chat/completions";
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type Sent = { url: string; body: { model?: string; messages?: { role: string; content: string }[] } };
let sent: Sent[] = [];
let reply: () => Response = () => new Response("{}", { status: 200 });

const llmAnswer = (content: Record<string, unknown>) => () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });

beforeEach(() => {
  sent = [];
  vi.stubEnv("LLM_API_KEY", "test-key");
  vi.stubEnv("LLM_BASE_URL", "https://llm.test/v1/");
  vi.stubEnv("LLM_MODEL", "gpt-5.6-luna");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Sent["body"] });
      return reply();
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const at = iso(0);
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const managerOther = await ctx.db.insert("users", { name: "Руководитель сантехники", email: "pl@test.kz", role: "manager", categories: ["plumbing"], tenantId: T, active: true });
    const executor = async (name: string, e: Partial<Doc<"executors">> = {}) => {
      const id = await ctx.db.insert("executors", { tenantId: T, name, phone: `7700${Math.random().toString().slice(2, 9)}`, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 4.8, reviews: 5, cooperation: "freelance", joinedAt: at, ...e });
      await ctx.db.insert("users", { name, email: `${name}@ex.kz`, role: "executor", executorId: id, tenantId: T, active: true });
      return id;
    };
    // По правилам первый — Арман (рейтинг выше при той же истории), второй — Болат.
    const arman = await executor("Арман Первый", { rating: 5, stats90: { done: 10, onTime: 10, cancelled: 0, refusals: 0, updatedAt: at } });
    const bolat = await executor("Болат Второй", { rating: 4.6, stats90: { done: 12, onTime: 12, cancelled: 0, refusals: 0, avgHours: 5, updatedAt: at } });
    await executor("Чужой Астана", { city: "Астана" });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Айгерим Секретная", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 1, activeCount: 1, lastActivityAt: at });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Айгерим Секретная",
      clientPhone: "77071234567",
      source: "olx",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит, код ошибки E4, домофон 45",
      city: "Алматы",
      district: "Бостандыкский",
      address: "ул. Тимирязева, 42, кв. 7",
      deadline: iso(-5 * 3_600_000),
      priority: "urgent",
      status: "awaiting_executor",
      clientPrice: 30000,
      payoutMode: "percent",
      payoutValue: 50,
      payments: [],
      payoutPaid: false,
      createdAt: at,
      createdBy: operator,
      files: [],
      requiredSkills: [],
    });
    return { owner, operator, managerOther, arman, bolat, order };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  const enable = () => as(ids.owner).mutation(api.aiMatch.configure, { enabled: true });
  const ask = (u: Id<"users"> = ids.operator) => as(u).action(api.aiMatch.recommend, { orderId: ids.order });
  return { t, ids, as, enable, ask };
}

describe("AI-подбор исполнителя", () => {
  test("по умолчанию выключен: рекомендация по правилам, в LLM ничего не уходит", async () => {
    const { ids, as, ask } = await setup();
    expect(await as(ids.operator).query(api.aiMatch.settings, {})).toEqual({ enabled: false, connected: true });
    const r = await ask();
    expect(r.source).toBe("rules");
    expect(r.note).toContain("выключен владельцем");
    expect(r.items.map((x) => x.executorId)).toEqual([ids.arman, ids.bolat]);
    expect(r.items[1]!.why).toContain("вовремя 100% · отказов 0");
    // Сумму мастера оператор не видит (ТЗ п.5.12: выплаты и маржа — по праву), владелец — видит.
    expect(r.items[0]!.payout).toBeUndefined();
    expect((await ask(ids.owner)).items[0]!.payout).toBe(15000);
    expect(sent).toHaveLength(0);
  });

  test("включает только владелец, с записью в журнал", async () => {
    const { t, ids, as, enable } = await setup();
    await expect(as(ids.operator).mutation(api.aiMatch.configure, { enabled: true })).rejects.toThrow("Нет доступа");
    expect(await enable()).toEqual({ enabled: true, connected: true });
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((a) => a.action === "settings.aiMatch")?.summary).toContain("включён");
  });

  test("включён: порядок и объяснение от LLM (та же модель, только роль user), без данных клиента и имён мастеров", async () => {
    const { t, ids, enable, ask } = await setup();
    await enable();
    reply = llmAnswer({ order: ["К2", "K1"], reasons: { К2: "Сдаёт всё вовремя, свободен", К1: "Высокий рейтинг" }, summary: "Срочный заказ — важнее надёжность." });
    const r = await ask();
    expect(r).toMatchObject({ source: "ai", summary: "Срочный заказ — важнее надёжность." });
    expect(r.items.map((x) => [x.executorId, x.why])).toEqual([
      [ids.bolat, "Сдаёт всё вовремя, свободен"],
      [ids.arman, "Высокий рейтинг"],
    ]);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(LLM_URL);
    expect(sent[0]!.body.model).toBe("gpt-5.6-luna");
    const messages = sent[0]!.body.messages!;
    expect(messages.map((m) => m.role)).toEqual(["user"]);
    const prompt = messages[0]!.content;
    expect(prompt).toContain("Ремонт кондиционера");
    expect(prompt).toContain("город Алматы, район Бостандыкский");
    expect(prompt).toContain("срочность срочно");
    expect(prompt).toContain("К1:");
    expect(prompt).toContain("К2:");
    for (const secret of ["Айгерим", "Секретная", "77071234567", "Тимирязева", "кв. 7", "E4", "домофон", "Арман", "Болат", "Чужой", "30000", "30 000"]) {
      expect(prompt).not.toContain(secret);
    }
    const journal = await t.run((ctx) => ctx.db.query("audit").collect());
    expect(journal.find((a) => a.action === "order.aiMatch")?.summary).toContain("Заказ №1001");
    const health = await t.run((ctx) => ctx.db.query("systemStatus").collect());
    expect(health.find((h) => h.key === "ai")).toBeTruthy();
  });

  test("сбой LLM или неразборчивый ответ — рекомендация по правилам с объяснением", async () => {
    const { ids, enable, ask } = await setup();
    await enable();
    reply = () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503 });
    let r = await ask();
    expect(r.source).toBe("rules");
    expect(r.note).toContain("AI не ответил");
    expect(r.items.map((x) => x.executorId)).toEqual([ids.arman, ids.bolat]);

    reply = llmAnswer({ order: ["кто-то другой"], summary: "?" });
    r = await ask();
    expect(r.source).toBe("rules");
  });

  test("AI не подключён — по правилам, без запроса", async () => {
    const { enable, ask } = await setup();
    await enable();
    vi.stubEnv("LLM_API_KEY", "");
    const r = await ask();
    expect(r).toMatchObject({ source: "rules", note: "AI не подключён — рекомендация по правилам." });
    expect(sent).toHaveLength(0);
  });

  test("права: исполнителю — нет доступа, руководителю чужого направления — тоже", async () => {
    const { t, ids, ask } = await setup();
    const exUser = await t.run(async (ctx) => (await ctx.db.query("users").withIndex("by_executor", (q) => q.eq("executorId", ids.arman)).first())!._id);
    await expect(ask(exUser)).rejects.toThrow("Нет доступа");
    await expect(ask(ids.managerOther)).rejects.toThrow();
  });
});

describe("подсказка и ответ LLM", () => {
  test("ответ: чужие и повторные метки отбрасываются, пропущенные — в конец по правилам", () => {
    expect(parseMatchAnswer({ order: ["К3", "К3", "К9", "к1"], reasons: { К3: "  быстро ", К9: "нет" } }, ["К1", "К2", "К3"])).toEqual({
      order: ["К3", "К1", "К2"],
      reasons: { К3: "быстро" },
      summary: "",
    });
    expect(parseMatchAnswer({ order: "К1" }, ["К1"])).toBeNull();
  });

  test("подсказка — только услуга, место, срок, навыки и обезличенные показатели", () => {
    const prompt = buildMatchPrompt(
      { service: "Чистка кондиционера", category: "Кондиционеры", city: "Астана", hoursLeft: -2, priority: "high", requiredSkills: ["VRF"] },
      [{ label: "К1", state: "busy", load: 2, rating: 4.9, reviews: 30, matchedSkills: 1, stats: { done: 2, onTime: 2, cancelled: 0, refusals: 1 }, districtOnly: true }],
    );
    expect(prompt).toContain("город Астана; срок просрочен на 2 ч; срочность высокая; нужны навыки: VRF");
    expect(prompt).toContain("К1: на заказе; заказов в работе: 2; рейтинг 4.9 (оценок: 30); совпало навыков: 1; за 90 дней сдано 2, отмен 0, отказов 1; работает только в своих районах");
  });
});
