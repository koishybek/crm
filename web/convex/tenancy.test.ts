/// <reference types="vite/client" />
// Изоляция компаний (ТЗ §2.5, §24): две компании с данными. Сотрудник компании B ни одной публичной функцией
// (перебор всех модулей convex/) не получает и не меняет документы компании A; HTTP-входы и кроны работают в своей компании;
// миграция данных до SaaS, регистрация, тарифы, модули и комиссия платформы.
import { convexTest } from "convex-test";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import schema from "./schema";
import { sha256Hex } from "./lib/crypto";
import { GLOBAL_TABLES } from "./lib/tenantDb";
import { MODULES, PLAN_INFO } from "../src/data/plans";
import { netMargin } from "../src/data/logic";
import { sums } from "../src/data/analytics";
import { moneyOf, n, orderFacts } from "../src/data/dailyStats";

const loaders = import.meta.glob("./**/*.*s");
const modules = Object.fromEntries(Object.entries(loaders).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")));
const sources = import.meta.glob("./**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

const SITE = "https://test.convex.site";
const A = "alpha";
const B = "beta";
const MARK: Record<string, string> = { [A]: "АЛЬФАСЕКРЕТ", [B]: "БЕТАСЕКРЕТ" };
const COMPANY_TABLES = Object.keys(schema.tables).filter((t) => !GLOBAL_TABLES.has(t)) as TableNames[];

beforeEach(() => {
  vi.stubEnv("FILES_SIGNING_KEY", "test-files-signing-key");
  vi.stubEnv("CONVEX_SITE_URL", SITE);
  vi.stubEnv("APP_URL", "https://app.test");
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

type T = ReturnType<typeof convexTest>;
type Ids = Partial<Record<TableNames | "_storage", string[]>>;
interface Company {
  slug: string;
  owner: Id<"users">;
  operator: Id<"users">;
  executorUser: Id<"users">;
  executor: Id<"executors">;
  client: Id<"clients">;
  order: Id<"orders">;
  doneOrder: Id<"orders">;
  reviewToken: string;
  docToken: string;
  pbxSecret: string;
  ids: Ids;
}

/** Компания с данными во всех основных таблицах. Метка компании — в именах и текстах: по ней видно утечку. */
async function seedCompany(t: T, slug: string, phoneTail: string, plan: "free" | "standard" | "pro" = "pro"): Promise<Company> {
  const m = MARK[slug]!;
  const at = new Date().toISOString();
  const reviewToken = `${slug}${"r".repeat(32)}`.slice(0, 32);
  const docToken = `${slug}${"d".repeat(40)}`.slice(0, 40);
  const pbxSecret = `${slug}-pbx-secret-0123456789abcdef`;
  return t.run(async (ctx) => {
    const ids: Ids = {};
    const add = (table: TableNames | "_storage", id: string) => {
      const list = ids[table] ?? [];
      list.push(id);
      ids[table] = list;
    };
    const ins = async <K extends TableNames>(table: K, doc: Record<string, unknown>) => {
      const id = await ctx.db.insert(table, { tenantId: slug, ...doc } as never);
      add(table, id);
      return id as Id<K>;
    };
    await ctx.db.insert("tenants", { slug, name: `Компания ${m}`, plan, modules: plan === "pro" ? [...MODULES] : [...PLAN_INFO[plan].modules], status: "active", createdAt: at });
    const owner = await ins("users", { name: `Владелец ${m}`, email: `owner@${slug}.kz`, role: "owner", active: true });
    const operator = await ins("users", { name: `Оператор ${m}`, email: `op@${slug}.kz`, role: "operator", active: true });
    const executor = await ins("executors", { name: `Мастер ${m}`, phone: `7700000${phoneTail}`, city: "Алматы", categories: ["ac"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
    const executorUser = await ins("users", { name: `Мастер ${m}`, email: `7700000${phoneTail}`, phone: `7700000${phoneTail}`, role: "executor", executorId: executor, active: true });
    const phone = `7707000${phoneTail}`;
    const client = await ins("clients", { name: `Клиент ${m}`, kind: "person", phone, city: "Алматы", source: "phone", tags: [], createdAt: at, ordersCount: 2, activeCount: 1, lastActivityAt: at });
    const lead = await ins("leads", { number: 1001, clientId: client, clientName: `Клиент ${m}`, clientPhone: phone, source: "phone", serviceId: "ac-repair", city: "Алматы", description: `${m} заявка`, urgency: "normal", status: "converted", createdAt: at });
    const base = { clientId: client, clientName: `Клиент ${m}`, clientPhone: phone, source: "phone", serviceId: "ac-repair", category: "ac", city: "Алматы", address: `${m} улица`, priority: "normal", payoutMode: "fixed", payoutValue: 10000, files: [], createdAt: at, createdBy: owner };
    const order = await ins("orders", { ...base, number: 1001, leadId: lead, description: `${m} не холодит`, deadline: new Date(Date.now() + 86400_000).toISOString(), status: "accepted", clientPrice: 30000, payments: [], payoutPaid: false, executorId: executor, assignedAt: at });
    const doneOrder = await ins("orders", { ...base, number: 1002, description: `${m} готово`, deadline: at, status: "paid", clientPrice: 20000, payments: [{ id: "p1", amount: 20000, method: "cash", at, by: owner }], payoutPaid: true, executorId: executor, doneAt: at, paidAt: at });
    await ins("messages", { orderId: order, author: { type: "user", id: owner }, channel: "internal", text: `${m} внутреннее`, files: [], at });
    await ins("history", { orderId: order, kind: "created", text: `${m} создан`, actor: { type: "system" }, at });
    await ins("interactions", { clientId: client, kind: "lead", channel: "phone", title: `${m} обращение`, text: `${m}`, at });
    await ins("clientNotes", { clientId: client, authorId: owner, text: `${m} заметка`, at });
    await ins("notifications", { userId: owner, text: `${m} уведомление`, at, read: false, tone: "info" });
    await ins("calls", { direction: "in", from: phone, to: "77270000000", clientId: client, status: "completed", startedAt: at, transcript: `${m} расшифровка`, aiStatus: "none" });
    const conv = await ins("conversations", { channel: "site", externalId: phone, contactName: `Клиент ${m}`, contactPhone: phone, clientId: client, lastMessageAt: at, lastText: `${m} привет`, lastDirection: "in", unread: 1, status: "open" });
    await ins("conversationMessages", { conversationId: conv, direction: "in", kind: "text", text: `${m} привет`, at });
    await ins("reviews", { orderId: doneOrder, executorId: executor, clientId: client, rating: 5, text: `${m} отзыв`, via: "operator", at });
    await ins("reviewRequests", { token: reviewToken, orderId: doneOrder, createdAt: at, expiresAt: new Date(Date.now() + 86400_000).toISOString() });
    await ins("payouts", { executorId: executor, orderIds: [doneOrder], orderNumbers: [1002], amount: 10000, method: "cash", at, by: owner, note: `${m} выплата`, createdAt: at });
    await ins("audit", { at, actorId: owner, actorName: `Владелец ${m}`, action: "order.created", entity: "order", entityId: order, summary: `${m} запись журнала` });
    await ins("apiKeys", { name: `${m} ключ`, prefix: "hms_x", hash: sha256Hex(`${slug}-key`), createdAt: at, createdBy: owner });
    await ins("webhooks", { url: `https://${slug}.example.kz/hook`, events: ["order.created"], secret: "sealed", description: `${m} вебхук`, active: true, failures: 0, createdAt: at, createdBy: owner });
    await ins("settings", { key: "pbxSecret", value: pbxSecret });
    await ins("settings", { key: "siteOrigins", value: JSON.stringify([`https://${slug}.example.kz`]) });
    await ins("counters", { name: "number", value: 1002 });
    await ins("adSpend", { month: at.slice(0, 7), source: "olx", amount: 5000, updatedAt: at, updatedBy: owner });
    await ins("campaignSpend", { month: at.slice(0, 7), campaign: `${m}кампания`, amount: 7000, updatedAt: at, updatedBy: owner });
    await ins("paymentIntents", { orderId: order, provider: "kaspi", invoiceId: `${slug}-inv-1`, amount: 30000, status: "created", url: `https://kaspi.kz/${slug}`, createdAt: at, createdBy: owner, expiresAt: new Date(Date.now() + 86400_000).toISOString(), updatedAt: at });
    const party = { name: `${m} ТОО` };
    await ins("documents", {
      orderId: doneOrder,
      kind: "act",
      number: 1,
      label: `${m}-1`,
      date: at,
      total: 20000,
      data: { seller: party, buyer: party, orderNumber: 1002, lines: [{ name: `${m} работа`, qty: 1, unit: "усл.", price: 20000, sum: 20000 }], total: 20000, totalWords: "двадцать тысяч", paid: 20000, vatNote: "Без НДС" },
      createdAt: at,
      createdBy: owner,
      publicTokenHash: sha256Hex(docToken),
      publicExpiresAt: new Date(Date.now() + 86400_000).toISOString(),
    });
    await ins("integrations", { provider: "email", status: "connected", accountName: `${m}@mail.kz`, connectedAt: at });
    const file = await ctx.storage.store(new Blob([m], { type: "text/plain" }));
    add("_storage", file);
    await ins("uploads", { storageId: file, userId: owner, at, usedAt: at });
    return { slug, owner, operator, executorUser, executor, client, order, doneOrder, reviewToken, docToken, pbxSecret, ids };
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  const a = await seedCompany(t, A, "01");
  const b = await seedCompany(t, B, "02");
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, a, b, as };
}

/** Все документы компании во всех её таблицах (и её строка в реестре) — снимок для сравнения «до/после». */
async function snapshot(t: T, slug: string): Promise<string> {
  return t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of COMPANY_TABLES) {
      // Ошибки интерфейса до входа (экран входа, форма) по правилу пишутся первой компании платформы — это не чужие данные.
      if (table === "clientErrors") continue;
      const rows = (await ctx.db.query(table).collect()).filter((d) => (d as { tenantId?: string }).tenantId === slug);
      if (rows.length) out[table] = rows;
    }
    out.tenants = (await ctx.db.query("tenants").collect()).filter((r) => r.slug === slug);
    return JSON.stringify(out);
  });
}

// ── Аргументы по валидатору функции ──────────────────────────────────────────

type VJson = { type: string; value?: unknown; tableName?: string; keys?: VJson; values?: { fieldType: VJson } };
type Field = { fieldType: VJson; optional: boolean };

/** Значение по валидатору: id — документ компании A той же таблицы (попытка добраться до чужого), остальное — простое. */
function valueOf(v: VJson, ids: Ids): { ok: true; value: unknown } | { ok: false } {
  switch (v.type) {
    case "id": {
      const id = ids[v.tableName as TableNames]?.[0];
      return id ? { ok: true, value: id } : { ok: false };
    }
    case "string":
      return { ok: true, value: "тест" };
    case "number":
      return { ok: true, value: 1 };
    case "boolean":
      return { ok: true, value: true };
    case "null":
      return { ok: true, value: null };
    case "literal":
      return { ok: true, value: v.value };
    case "any":
      return { ok: true, value: {} };
    case "array": {
      const item = valueOf(v.value as VJson, ids);
      return { ok: true, value: item.ok ? [item.value] : [] };
    }
    case "record":
      return { ok: true, value: {} };
    case "union": {
      for (const member of v.value as VJson[]) {
        const r = valueOf(member, ids);
        if (r.ok) return r;
      }
      return { ok: false };
    }
    case "object":
      return objectOf(v.value as Record<string, Field>, ids);
    default:
      return { ok: false };
  }
}

function objectOf(fields: Record<string, Field>, ids: Ids): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const out: Record<string, unknown> = {};
  for (const [key, f] of Object.entries(fields)) {
    if (key === "tenantId") continue;
    // Необязательные — только ссылки на документы: так проверяется больше путей к чужим данным.
    if (f.optional && f.fieldType.type !== "id") continue;
    const r = valueOf(f.fieldType, ids);
    if (!r.ok) {
      if (f.optional) continue;
      return { ok: false };
    }
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

interface PublicFn {
  path: string;
  kind: "query" | "mutation" | "action";
  args: VJson;
}

/** Все публичные query/mutation/action модулей convex/ (как в convex/_generated/api). */
async function publicFunctions(): Promise<PublicFn[]> {
  const out: PublicFn[] = [];
  for (const [path, load] of Object.entries(modules)) {
    const mod = (await load()) as Record<string, unknown>;
    const name = path.replace(/^\.\//, "").replace(/\.(t|j)s$/, "");
    for (const [exp, fn] of Object.entries(mod)) {
      if (typeof fn !== "function") continue;
      const f = fn as unknown as { isQuery?: boolean; isMutation?: boolean; isAction?: boolean; isPublic?: boolean; exportArgs?: () => string };
      if (!f.isPublic || !f.exportArgs) continue;
      const kind = f.isQuery ? "query" : f.isMutation ? "mutation" : f.isAction ? "action" : null;
      if (!kind) continue;
      out.push({ path: `${name}:${exp}`, kind, args: JSON.parse(f.exportArgs()) as VJson });
    }
  }
  return out;
}

const containsForeign = (value: unknown, ids: Ids, mark: string): string | null => {
  const json = JSON.stringify(value ?? null);
  if (json.includes(mark)) return `метка ${mark}`;
  for (const list of Object.values(ids)) for (const id of list ?? []) if (json.includes(id)) return `id ${id}`;
  return null;
};

// ── 1. Перебор всех публичных функций ────────────────────────────────────────

describe("изоляция: сотрудник компании B и все публичные функции", () => {
  test("ни одна query/mutation/action не отдаёт и не меняет документы компании A", { timeout: 300_000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { t, a, b, as } = await setup();
    const fns = await publicFunctions();
    expect(fns.length).toBeGreaterThan(150);
    const before = await snapshot(t, A);
    const leaks: string[] = [];
    const unbound: string[] = [];
    let called = 0;
    for (const fn of fns) {
      const built = fn.args.type === "object" ? objectOf(fn.args.value as Record<string, Field>, a.ids) : fn.args.type === "any" ? { ok: true as const, value: {} } : { ok: false as const };
      if (!built.ok) continue;
      // Владелец B — самая широкая роль; оператор и мастер B — для функций со своими ветками доступа.
      // null — без входа: публичная функция должна отказать («Нужно войти»), а не упасть без компании.
      for (const user of [b.owner, b.operator, b.executorUser, null]) {
        const caller = user ? as(user) : t;
        let result: unknown;
        try {
          const ref = makeFunctionReference(fn.path) as FunctionReference<"query" | "mutation" | "action", "public">;
          result =
            fn.kind === "query"
              ? await caller.query(ref as FunctionReference<"query">, built.value)
              : fn.kind === "mutation"
                ? await caller.mutation(ref as FunctionReference<"mutation">, built.value)
                : await caller.action(ref as FunctionReference<"action">, built.value);
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          if (/Компания не определена/.test(text)) unbound.push(`${fn.path}: ${text.slice(0, 120)}`);
          continue;
        } finally {
          called++;
        }
        const foreign = containsForeign(result, a.ids, MARK[A]!);
        if (foreign) leaks.push(`${fn.path} (${user === null ? "без входа" : user === b.owner ? "владелец" : user === b.operator ? "оператор" : "мастер"}): ${foreign}`);
      }
    }
    expect(called).toBeGreaterThan(200);
    // Отложенные задачи, которые поставили эти вызовы (рассылки, пересчёты), — тоже в своей компании.
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // Ни один документ компании B не получил данных компании A (копирование чужого в своё — тоже утечка).
    const polluted = await t.run(async (ctx) => {
      const out: string[] = [];
      for (const table of COMPANY_TABLES) {
        for (const d of await ctx.db.query(table).collect()) {
          if ((d as { tenantId?: string }).tenantId !== B) continue;
          const found = containsForeign(d, a.ids, MARK[A]!);
          if (found) out.push(`${table}: ${found} ${JSON.stringify(d).slice(0, 300)}`);
        }
      }
      return out;
    });
    expect(polluted).toEqual([]);
    expect(leaks).toEqual([]);
    expect(unbound).toEqual([]);
    expect(await snapshot(t, A)).toBe(before);
  });

  test("явные проверки: списки, карточки, поиск, архив, аналитика, выплаты, журнал, настройки — только своя компания", async () => {
    const { a, b, as } = await setup();
    const bOwner = as(b.owner);
    const own = (x: unknown) => expect(JSON.stringify(x)).not.toContain(MARK[A]!);
    own(await bOwner.query(api.orders.board, {}));
    own(await bOwner.query(api.board.live, {}));
    own(await bOwner.query(api.clients.list, {}));
    own(await bOwner.query(api.executors.list, {}));
    own(await bOwner.query(api.calls.list, {}));
    own(await bOwner.query(api.audit.list, { paginationOpts: { numItems: 50, cursor: null } }));
    own(await bOwner.query(api.payouts.list, {}));
    own(await bOwner.query(api.site.settings, {}));
    own(await bOwner.query(api.tenants.current, {}));
    // Свои данные — видны: защита не прячет всё подряд.
    expect(JSON.stringify(await bOwner.query(api.clients.list, {}))).toContain(MARK[B]!);
    // Чужой документ по id — как несуществующий.
    expect(await bOwner.query(api.orders.detail, { id: a.order })).toBeNull();
    await expect(bOwner.mutation(api.orders.changeStatus, { id: a.order, to: "cancelled", reason: "x" })).rejects.toThrow();
    // Нумерация — у каждой компании своя: новая заявка B — №1003 (после её 1002).
    await bOwner.mutation(api.leads.create, { clientName: "Новый клиент", phone: "+7 701 555 66 77", serviceId: "ac-repair", city: "Алматы", description: "Течёт кондиционер", source: "phone", urgency: "normal" });
  });
});

// ── 2. Входы без пользователя ────────────────────────────────────────────────

describe("входы без пользователя работают в своей компании", () => {
  const post = (t: T, path: string, body: unknown, headers: Record<string, string> = {}) => t.fetch(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const leadForm = { name: "Айгерим", phone: "+7 701 999 88 77", description: "Сломалась стиралка", consent: true, website: "", startedAt: Date.now() - 60_000 };

  test("форма заявки: ?c=<компания> — заявка в этой компании; неизвестная компания — 404; без адреса — первая компания", async () => {
    const { t, a, b } = await setup();
    expect((await post(t, `/public/lead?c=${B}`, leadForm)).status).toBe(201);
    const leadsOf = (slug: string) => t.run(async (ctx) => (await ctx.db.query("leads").collect()).filter((l) => l.tenantId === slug));
    expect((await leadsOf(B)).some((l) => l.description.includes("стиралка"))).toBe(true);
    expect((await leadsOf(A)).some((l) => l.description.includes("стиралка"))).toBe(false);
    // Номер — продолжение нумерации компании B.
    expect((await leadsOf(B)).find((l) => l.description.includes("стиралка"))!.number).toBe(1003);
    expect((await post(t, "/public/lead?c=nope", leadForm)).status).toBe(404);
    expect((await post(t, "/public/lead", { ...leadForm, phone: "+7 701 999 88 66" })).status).toBe(201);
    expect((await leadsOf(A)).some((l) => l.clientPhone === "77019998866")).toBe(true);
    // Справочник формы — по адресу компании; неизвестная — null.
    expect(await t.query(api.catalog.publicList, { company: "nope" })).toBeNull();
    expect((await t.query(api.catalog.publicList, { company: B }))!.services.length).toBeGreaterThan(0);
    void a;
    void b;
  });

  test("REST API: ключ компании B видит только её заказ №1001; ключ без модуля API — 403", async () => {
    const { t, b, as } = await setup();
    const { key } = await as(b.owner).mutation(api.apiKeys.create, { name: "Партнёр", scopes: ["orders:read", "leads:write"] });
    const res = await t.fetch("/api/v1/orders/1001", { headers: { Authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { number: number; createdAt: string };
    expect(body.number).toBe(1001);
    const created = await t.fetch("/api/v1/leads", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Партнёр", phone: "+7 701 444 33 22", description: "Нужен мастер" }) });
    expect(created.status).toBe(201);
    const lead = await t.run(async (ctx) => (await ctx.db.query("leads").collect()).find((l) => l.clientPhone === "77014443322"));
    expect(lead?.tenantId).toBe(B);
    // Модуль API выключили — ключ перестаёт работать.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tenants").collect()).find((r) => r.slug === B)!;
      await ctx.db.patch(row._id, { modules: row.modules.filter((m) => m !== "api") });
    });
    expect((await t.fetch("/api/v1/orders/1001", { headers: { Authorization: `Bearer ${key}` } })).status).toBe(403);
  });

  test("АТС: ключ компании определяет компанию звонка; чужой ключ — 403", async () => {
    const { t, a, b } = await setup();
    const res = await t.fetch("/pbx/events", { method: "POST", headers: { "Content-Type": "application/json", "X-Pbx-Secret": b.pbxSecret }, body: JSON.stringify({ event: "ringing", callId: "c-1", from: "+77015550011", to: "77270000000" }) });
    expect(res.status).toBe(200);
    const call = await t.run(async (ctx) => (await ctx.db.query("calls").collect()).find((c) => c.externalId === "c-1"));
    expect(call?.tenantId).toBe(B);
    expect((await t.fetch("/pbx/events", { method: "POST", headers: { "Content-Type": "application/json", "X-Pbx-Secret": "wrong" }, body: "{}" })).status).toBe(403);
    void a;
  });

  test("ссылки клиента: отзыв и документ открываются в своей компании и не показывают чужих данных", async () => {
    const { t, a, b } = await setup();
    const review = await t.query(api.reviews.byToken, { token: b.reviewToken });
    expect(review.state).not.toBe("invalid");
    expect(JSON.stringify(review)).not.toContain(MARK[A]!);
    const doc = await t.query(api.documents.publicView, { token: a.docToken });
    expect(JSON.stringify(doc)).toContain(MARK[A]!);
    expect(JSON.stringify(doc)).not.toContain(MARK[B]!);
  });

  test("подписанная ссылка на файл: компания в ссылке, подделанная компания — отказ", async () => {
    // Без FILES_SIGNING_KEY у каждой компании свой ключ подписи (в её настройках).
    vi.stubEnv("FILES_SIGNING_KEY", "");
    const { t, b, as } = await setup();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["photo"], { type: "image/jpeg" })));
    await t.run(async (ctx) => {
      await (ctx.db as unknown as { patch: (id: string, v: Record<string, unknown>) => Promise<void> }).patch(storageId, { contentType: "image/jpeg" });
    });
    const ok = await as(b.owner).mutation(api.files.confirmUpload, { storageId });
    expect(ok.ok).toBe(true);
    await as(b.owner).mutation(api.orders.addMessage, { orderId: b.order, text: "фото", files: [{ storageId, name: "photo.jpg" }], channel: "internal" });
    const detail = (await as(b.owner).query(api.orders.detail, { id: b.order }))!;
    const url = JSON.stringify(detail).match(/https:\/\/test\.convex\.site\/files\/[^"]+/)?.[0];
    expect(url).toContain(`c=${B}`);
    const path = url!.slice(SITE.length).replace(/\\u0026/g, "&");
    expect((await t.fetch(path)).status).toBe(200);
    expect((await t.fetch(path.replace(`c=${B}`, `c=${A}`))).status).toBe(403);
  });

  test("загрузку другой компании присвоить нельзя", async () => {
    const { t, a, b, as } = await setup();
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"], { type: "image/png" })));
    await t.run(async (ctx) => {
      await (ctx.db as unknown as { patch: (id: string, v: Record<string, unknown>) => Promise<void> }).patch(storageId, { contentType: "image/png" });
    });
    expect((await as(a.owner).mutation(api.files.confirmUpload, { storageId })).ok).toBe(true);
    expect((await as(b.owner).mutation(api.files.confirmUpload, { storageId })).ok).toBe(false);
  });
});

// ── 3. Кроны ─────────────────────────────────────────────────────────────────

describe("кроны обходят компании", () => {
  test("напоминание о просрочке — каждой компании своё; копия — у каждой своя и только с её данными", async () => {
    vi.useFakeTimers();
    const { t, a, b } = await setup();
    await t.run(async (ctx) => {
      for (const id of [a.order, b.order]) await ctx.db.patch(id, { deadline: new Date(Date.now() - 3600_000).toISOString() });
    });
    await t.mutation(internal.reminders.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const notes = await t.run(async (ctx) => ctx.db.query("notifications").collect());
    const overdue = notes.filter((n) => n.text.startsWith("Просрочка"));
    expect(overdue.filter((n) => n.tenantId === A).every((n) => n.link === `/orders/${a.order}`)).toBe(true);
    expect(overdue.filter((n) => n.tenantId === B).every((n) => n.link === `/orders/${b.order}`)).toBe(true);
    expect(overdue.filter((n) => n.tenantId === A).length).toBeGreaterThan(0);
    expect(overdue.filter((n) => n.tenantId === B).length).toBeGreaterThan(0);

    await t.action(internal.backup.run, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const backups = await t.run(async (ctx) => ctx.db.query("backups").collect());
    // Компания по умолчанию (до миграции у неё нет строки в реестре) тоже обходится — её копия пустая.
    expect(backups.filter((x) => x.tenantId === A || x.tenantId === B)).toHaveLength(2);
    for (const x of backups.filter((y) => y.tenantId === A || y.tenantId === B)) {
      const text = await t.run(async (ctx) => (await ctx.storage.get(x.fileId))!.text());
      const other = x.tenantId === A ? MARK[B]! : MARK[A]!;
      expect(text).toContain(MARK[x.tenantId!]!);
      expect(text).not.toContain(other);
    }
  });
});

describe("все кроны с двумя компаниями", () => {
  test("каждый крон проходит по компаниям без ошибок «компания не определена»", { timeout: 120_000 }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { t } = await setup();
    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.map(String).join(" ")));
    try {
      const mutations = [internal.reminders.run, internal.digest.run, internal.alerts.check, internal.retention.run, internal.exports.cleanup, internal.maintenance.cleanup, internal.files.maintain, internal.stats.tick, internal.stats.reconcileLoads, internal.autoAssign.run, internal.executors._restoreShifts, internal.escalations._pass];
      for (const ref of mutations) await t.mutation(ref, {});
      await t.mutation(internal.executorStats.refreshBatch, {});
      await t.action(internal.escalations.run, {});
      await t.action(internal.channels.olx.sync, {});
      await t.action(internal.backup.run, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);
    } finally {
      spy.mockRestore();
    }
    expect(errors.filter((e) => /Компания не определена|другой компании/.test(e))).toEqual([]);
    // Шаги кронов, упавшие с ошибкой, видны и в «Состоянии системы» компании.
    const marks = await t.run(async (ctx) => (await ctx.db.query("systemStatus").collect()).map((r) => r.error ?? ""));
    expect(marks.filter((e) => /Компания не определена|другой компании/.test(e))).toEqual([]);
  });
});

describe("Telegram-бот из окружения — бот компании по умолчанию", () => {
  test("клиент пишет боту — диалог в компании по умолчанию; сотрудник компании B получает сводку своей компании", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "tg-token");
    const { t, b } = await setup();
    await t.run(async (ctx) => ctx.db.patch(b.owner, { telegramChatId: "5005" }));
    const update = (chatId: number, text: string) => ({ update: { message: { message_id: chatId, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, from: { id: chatId, first_name: "Клиент" }, text } } });
    await t.action(internal.telegram.handleUpdate, update(777, "Течёт кран на кухне"));
    const convs = await t.run(async (ctx) => (await ctx.db.query("conversations").collect()).filter((c) => c.channel === "telegram"));
    expect(convs.map((c) => c.tenantId)).toEqual(["t-komfort"]);
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(String(init?.body ?? ""));
        return Response.json({ ok: true, result: {} });
      }),
    );
    await t.action(internal.telegram.handleUpdate, update(5005, "/orders"));
    expect(sent.join(" ")).not.toContain(MARK[A]!);
  });
});

describe("уведомления онлайн-оплаты", () => {
  test("неизвестная компания в адресе — 404; модуль выключен — 403", async () => {
    const { t } = await setup();
    expect((await t.fetch("/pay/freedompay?c=nope", { method: "POST", body: "pg_order_id=x" })).status).toBe(404);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tenants").collect()).find((r) => r.slug === B)!;
      await ctx.db.patch(row._id, { modules: [] });
    });
    expect((await t.fetch(`/pay/freedompay?c=${B}`, { method: "POST", body: "pg_order_id=x" })).status).toBe(403);
  });
});

// ── 4. Миграция данных до SaaS ───────────────────────────────────────────────

describe("миграция tenants:migrate", () => {
  test("строка «Home Max Service» с тарифом «Про», tenantId во всех документах; повтор ничего не дублирует", async () => {
    vi.useFakeTimers();
    const t = convexTest(schema, modules);
    const at = new Date().toISOString();
    await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@hm.kz", role: "owner", active: true });
      await ctx.db.insert("settings", { key: "x", value: "1" });
      await ctx.db.insert("counters", { name: "number", value: 1001 });
      await ctx.db.insert("notifications", { userId: owner, text: "привет", at, read: false, tone: "info" });
    });
    await t.mutation(internal.tenants.migrate, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.mutation(internal.tenants.migrate, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    await t.run(async (ctx) => {
      const rows = await ctx.db.query("tenants").collect();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ slug: "t-komfort", name: "Home Max Service", plan: "pro", status: "active" });
      expect(rows[0]!.modules).toEqual([...MODULES]);
      expect(rows[0]!.migratedAt).toBeTruthy();
      for (const table of ["users", "settings", "counters", "notifications"] as const) {
        for (const d of await ctx.db.query(table).collect()) expect(d.tenantId).toBe("t-komfort");
      }
      const log = await ctx.db.query("audit").collect();
      expect(log.filter((r) => r.action === "system.tenantMigrated")).toHaveLength(2);
    });
  });
});

// ── 5. Регистрация, тарифы, модули, платформа, комиссия ─────────────────────

describe("регистрация компании", () => {
  const form = { company: "Мастер на час", ownerName: "Ерлан", login: "erlan@master.kz", password: "очень-надёжный-пароль-1", city: "Алматы", consent: true, website: "", startedAt: Date.now() - 60_000 };

  test("без SAAS_SIGNUP=1 — по приглашению; с ним — компания, владелец, справочник, тариф «Бесплатный»", async () => {
    const t = convexTest(schema, modules);
    expect(await t.query(api.tenants.signupStatus, {})).toEqual({ open: false });
    await expect(t.action(api.tenants.register, form)).rejects.toThrow("Регистрация по приглашению");
    vi.stubEnv("SAAS_SIGNUP", "1");
    await expect(t.action(api.tenants.register, { ...form, password: "короткий" })).rejects.toThrow();
    await expect(t.action(api.tenants.register, { ...form, website: "http://spam" })).rejects.toThrow("Не удалось");
    await expect(t.action(api.tenants.register, { ...form, startedAt: Date.now() })).rejects.toThrow("Слишком быстро");
    const r = await t.action(api.tenants.register, form);
    expect(r).toEqual({ login: "erlan@master.kz", slug: "master-na-chas" });
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tenants").collect()).find((x) => x.slug === r.slug)!;
      expect(row).toMatchObject({ name: "Мастер на час", plan: "free", status: "active" });
      const owner = (await ctx.db.query("users").collect()).find((u) => u.email === form.login)!;
      expect(owner).toMatchObject({ role: "owner", tenantId: r.slug });
      expect(row.ownerUserId).toBe(owner._id);
      expect((await ctx.db.query("services").collect()).filter((s) => s.tenantId === r.slug).length).toBeGreaterThan(10);
    });
    // Тот же логин второй раз — занят.
    await expect(t.action(api.tenants.register, { ...form, company: "Другая" })).rejects.toThrow("логин уже занят");
    const ownerId = await t.run(async (ctx) => (await ctx.db.query("users").collect()).find((u) => u.email === form.login)!._id);
    const owner = t.withIdentity({ subject: `${ownerId}|s` });
    expect(await owner.query(api.tenants.current, {})).toMatchObject({ slug: "master-na-chas", plan: "free", modules: [] });
    const steps = await owner.query(api.tenants.onboarding, {});
    expect(steps!.map((x) => x.step)).toEqual(["catalog", "staff", "executors", "channels"]);
    expect(steps!.find((x) => x.step === "staff")!.done).toBe(false);
    expect((await owner.query(api.tenants.company, {})).usage.users).toEqual({ used: 1, cap: 3 });
    await owner.mutation(api.tenants.dismissOnboarding, {});
    expect(await owner.query(api.tenants.onboarding, {})).toBeNull();
  });
});

describe("тарифы и модули", () => {
  test("модуль выключен — функция отказывает понятным текстом; лимит тарифа — тоже", async () => {
    const t = convexTest(schema, modules);
    const b = await seedCompany(t, B, "02", "free");
    const owner = t.withIdentity({ subject: `${b.owner}|s` });
    await expect(owner.mutation(api.documents.issue, { orderId: b.doneOrder, kind: "act" })).rejects.toThrow(/доступно на тарифе/);
    await expect(owner.mutation(api.apiKeys.create, { name: "x" })).rejects.toThrow(/доступно на тарифе/);
    await expect(owner.query(api.campaigns.stats, { from: new Date(0).toISOString(), to: new Date().toISOString() })).rejects.toThrow(/доступно на тарифе/);
    // «Бесплатный»: до 3 сотрудников — владелец и оператор уже есть, третий можно, четвёртого — нет.
    await t.run(async (ctx) => {
      await ctx.db.insert("users", { name: "Третий", email: "third@beta.kz", role: "operator", active: true, tenantId: B });
    });
    await expect(owner.action(api.users.createStaff, { name: "Четвёртый", login: "fourth@beta.kz", role: "operator" })).rejects.toThrow("не больше 3 сотрудников");
  });
});

describe("экран «Платформа» и комиссия платформы", () => {
  test("только PLATFORM_ADMINS; смена тарифа включает модули тарифа; запись в журнале компании", async () => {
    const { t, a, b, as } = await setup();
    await expect(as(a.owner).query(api.platform.tenants, {})).rejects.toThrow("Нет доступа");
    vi.stubEnv("PLATFORM_ADMINS", "owner@alpha.kz");
    const rows = await as(a.owner).query(api.platform.tenants, {});
    expect(rows.map((r) => r.slug).sort()).toEqual([A, B, "t-komfort"].sort());
    await as(a.owner).mutation(api.platform.update, { slug: B, plan: "standard" });
    await expect(as(a.owner).mutation(api.platform.update, { slug: A, status: "suspended" })).rejects.toThrow("Свою компанию");
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tenants").collect()).find((r) => r.slug === B)!;
      expect(row.plan).toBe("standard");
      expect(row.modules).toEqual([...PLAN_INFO.standard.modules]);
      const log = (await ctx.db.query("audit").collect()).filter((r) => r.action === "settings.plan");
      expect(log.map((r) => r.tenantId)).toEqual([B]);
    });
    // Приостановленная компания — ни данных, ни действий.
    await as(a.owner).mutation(api.platform.update, { slug: B, status: "suspended" });
    expect(await as(b.owner).query(api.users.me, {})).toBeNull();
    await expect(as(b.owner).query(api.clients.list, {})).rejects.toThrow("приостановлена");
  });

  test("комиссия: снимок при выполнении заказа, в аналитике вычитается из маржи", async () => {
    const { t, b, as } = await setup();
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tenants").collect()).find((r) => r.slug === B)!;
      await ctx.db.patch(row._id, { platformFee: { mode: "percent", value: 10 } });
    });
    const exec = as(b.executorUser);
    await exec.mutation(api.worker.act, { id: b.order, action: "start" });
    await exec.mutation(api.worker.act, { id: b.order, action: "done" });
    const order = await t.run((ctx) => ctx.db.get(b.order));
    expect(order!.platformFee).toBe(3000);
    // Условия поменяли — у выполненного заказа комиссия прежняя.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("tenants").collect()).find((r) => r.slug === B)!;
      await ctx.db.patch(row._id, { platformFee: { mode: "fixed", value: 99 } });
    });
    const done = (await t.run((ctx) => ctx.db.get(b.order)))!;
    expect(done.platformFee).toBe(3000);
    // Маржа — одна формула для карточки, сырых заказов и предрасчёта: 30 000 − 10 000 мастеру − 3 000 комиссии.
    expect(netMargin(done)).toBe(17_000);
    expect(sums([done])).toMatchObject({ revenue: 30_000, payouts: 10_000, fee: 3_000, margin: 17_000 });
    const cell = [...orderFacts(done).values()].find((c) => n(c.t, "done") === 1)!;
    expect(moneyOf(cell.t)).toMatchObject({ fee: 3_000, margin: 17_000 });
  });
});

// ── 6. Код: модули берут конструкторы с изоляцией ────────────────────────────

describe("конструкторы функций", () => {
  test("ни один модуль не берёт query/mutation/action из _generated/server напрямую (кроме lib/functions.ts)", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.includes(".test.") && !path.includes("_generated") && !path.endsWith("lib/functions.ts"))
      .filter(([, src]) => /import\s*\{[^}]*\b(query|mutation|internalQuery|internalMutation|action|internalAction)\b[^}]*\}\s*from\s*"[./]+_generated\/server"/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  test("константы TENANT в коде больше нет", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !path.includes(".test."))
      .filter(([, src]) => /\bTENANT\b/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});

