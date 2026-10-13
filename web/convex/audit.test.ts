/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { money } from "../src/lib/format";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const at = new Date().toISOString();
const AI = { summary: "Не холодит кондиционер", extracted: [], questions: [] };
/** convex-test не хранит тип загрузки (Convex берёт его из Content-Type) — проставляем, как сделал бы сервер. */
type RawDb = { patch: (id: string, value: Record<string, unknown>) => Promise<void> };

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Мадина Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель Сантехники", email: "lead@test.kz", role: "manager", categories: ["plumbing"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", {
      tenantId: T,
      name: "Асет Новиков",
      phone: "77000000001",
      city: "Алматы",
      categories: ["ac"],
      skills: [],
      available: true,
      rating: 4.8,
      reviews: 10,
      cooperation: "freelance",
      joinedAt: at,
    });
    const exUser = await ctx.db.insert("users", { name: "Асет Новиков", email: "77000000001", phone: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    return { owner, operator, manager, ex, exUser, client };
  });
  const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });
  const all = () => t.run((ctx) => ctx.db.query("audit").collect());
  /** Записи журнала, которые появились за время fn. */
  const recorded = async (fn: () => Promise<unknown>): Promise<Doc<"audit">[]> => {
    const before = new Set((await all()).map((r) => r._id));
    await fn();
    return (await all()).filter((r) => !before.has(r._id));
  };
  /** Ровно одна новая запись — её и возвращаем. */
  const one = async (fn: () => Promise<unknown>): Promise<Doc<"audit">> => {
    const rows = await recorded(fn);
    expect(rows.map((r) => r.action)).toHaveLength(1);
    return rows[0]!;
  };
  const mkOrder = (over: Partial<Doc<"orders">> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("orders", {
        tenantId: T,
        number: 1001,
        clientId: ids.client,
        clientName: "Клиент Тест",
        clientPhone: "77071234567",
        source: "olx",
        serviceId: "ac-repair",
        category: "ac",
        description: "Не холодит кондиционер",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: new Date(Date.now() + 86400_000).toISOString(),
        priority: "normal",
        status: "new",
        clientPrice: 30000,
        payoutMode: "fixed",
        payoutValue: 21000,
        payments: [],
        payoutPaid: false,
        createdAt: at,
        createdBy: ids.owner,
        files: [],
        ...over,
      }),
    );
  const mkLead = (serviceId: string, number = 2001) =>
    t.run((ctx) =>
      ctx.db.insert("leads", {
        tenantId: T,
        number,
        clientId: ids.client,
        clientName: "Клиент Тест",
        clientPhone: "77071234567",
        source: "phone",
        serviceId,
        city: "Алматы",
        description: "Описание",
        urgency: "normal",
        status: "new",
        operatorId: ids.operator,
        createdAt: at,
      }),
    );
  return { t, ids, as, all, recorded, one, mkOrder, mkLead };
}

type Setup = Awaited<ReturnType<typeof setup>>;
const by = (row: Doc<"audit">) => ({ action: row.action, entity: row.entity, entityId: row.entityId, actorId: row.actorId, actorName: row.actorName });

describe("журнал: каждое ключевое действие — ровно одна запись с автором и объектом", () => {
  test("заявки: создание (и новый клиент — в той же записи), правка, этапы, отказ с причиной, заказ из заявки", async () => {
    const { ids, as, one, recorded }: Setup = await setup();
    const op = as(ids.operator);
    let leadId: Id<"leads"> | undefined;
    const created = await one(async () => {
      leadId = (await op.mutation(api.leads.create, { clientName: "Ерлан Новый", phone: "+7 701 555 01 47", source: "whatsapp", serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "high" })).id;
    });
    expect(by(created)).toMatchObject({ action: "lead.created", entity: "lead", entityId: leadId, actorId: ids.operator, actorName: "Мадина Оператор" });
    expect(created.actorRole).toBe("operator");
    expect(created.meta).toMatchObject({ newClient: true, source: "whatsapp" });
    expect(created.summary).toContain("новый клиент");

    const updated = await one(() => op.mutation(api.leads.update, { id: leadId!, city: "Астана", urgency: "normal" }));
    expect(by(updated)).toMatchObject({ action: "lead.updated", entity: "lead", entityId: leadId });
    expect(updated.summary).toContain("Алматы → Астана");
    // Сохранили без изменений — записи нет.
    expect(await recorded(() => op.mutation(api.leads.update, { id: leadId!, city: "Астана" }))).toHaveLength(0);

    const status = await one(() => op.mutation(api.leads.setStatus, { id: leadId!, status: "qualifying" }));
    expect(by(status)).toMatchObject({ action: "lead.status", entityId: leadId });
    expect(status.summary).toContain("«Новая» → «Квалификация»");
    const rejected = await one(() => op.mutation(api.leads.setStatus, { id: leadId!, status: "rejected", reason: "Дорого" }));
    expect(by(rejected)).toMatchObject({ action: "lead.rejected", entityId: leadId });
    expect(rejected.summary).toContain("Дорого");
    expect(rejected.meta).toMatchObject({ from: "qualifying", to: "rejected", reason: "Дорого" });

    await op.mutation(api.leads.setStatus, { id: leadId!, status: "qualifying" });
    let orderId: Id<"orders"> | undefined;
    const converted = await one(async () => {
      orderId = (await op.mutation(api.leads.convert, { id: leadId! })).id;
    });
    expect(by(converted)).toMatchObject({ action: "lead.converted", entity: "lead", entityId: leadId, actorId: ids.operator });
    expect(converted.meta).toMatchObject({ orderId });

    // Заявка на уже известного клиента — та же одна запись, без отметки «новый клиент».
    const repeat = await one(() => op.mutation(api.leads.create, { clientName: "Клиент Тест", phone: "77071234567", source: "olx", serviceId: "ac-clean", city: "Алматы", description: "Чистка", urgency: "normal" }));
    expect(repeat.meta).toMatchObject({ newClient: false, clientId: ids.client });
  });

  test("заказ: данные, деньги «было → стало» с маржой, оплата, публикация, назначение, отмена и возврат с причиной", async () => {
    const { ids, as, one, mkOrder } = await setup();
    const owner = as(ids.owner);
    const id = await mkOrder();

    const finance = await one(() => owner.mutation(api.orders.updateFinance, { id, clientPrice: 35000, payoutMode: "fixed", payoutValue: 24000, payoutPaid: false }));
    expect(by(finance)).toMatchObject({ action: "order.finance", entity: "order", entityId: id, actorId: ids.owner });
    for (const v of [30000, 35000, 21000, 24000, 9000, 11000]) expect(finance.summary).toContain(money(v));
    expect(finance.summary).toContain(`цена клиента ${money(30000)} → ${money(35000)}`);
    expect(finance.summary).toContain(`маржа ${money(9000)} → ${money(11000)}`);
    expect(finance.meta).toMatchObject({ before: { clientPrice: 30000, payout: 21000, margin: 9000 }, after: { clientPrice: 35000, payout: 24000, margin: 11000 } });

    const deadline = "2026-12-01T13:00:00.000Z";
    const info = await one(() =>
      owner.mutation(api.orders.updateInfo, { id, serviceId: "ac-repair", description: "Не холодит кондиционер", city: "Алматы", address: "ул. Абая, 10", deadline, priority: "high" }),
    );
    expect(by(info)).toMatchObject({ action: "order.info", entityId: id });
    expect(info.summary).toContain("01.12.2026 18:00"); // срок — по Алматы
    expect(info.summary).toContain("адрес");
    expect(info.meta).toMatchObject({ changes: { address: "изменено", priority: { from: "normal", to: "high" } } });

    const published = await one(() => owner.mutation(api.orders.changeStatus, { id, to: "awaiting_executor" }));
    expect(by(published)).toMatchObject({ action: "order.published", entityId: id });

    const assigned = await one(() => owner.mutation(api.orders.assign, { id, executorId: ids.ex }));
    expect(by(assigned)).toMatchObject({ action: "order.assigned", entityId: id, actorId: ids.owner });

    const cancelled = await one(() => owner.mutation(api.orders.changeStatus, { id, to: "cancelled", reason: "Клиент передумал" }));
    expect(by(cancelled)).toMatchObject({ action: "order.status", entityId: id });
    expect(cancelled.summary).toContain("Клиент передумал");
    expect(cancelled.meta).toMatchObject({ from: "assigned", to: "cancelled", reason: "Клиент передумал" });

    // Оплата, закрывающая долг, сама переводит заказ в «Оплачен» — это всё та же одна запись.
    const done = await mkOrder({ number: 1002, status: "done", executorId: ids.ex });
    const payment = await one(() => owner.mutation(api.orders.addPayment, { id: done, amount: 30000, method: "cash" }));
    expect(by(payment)).toMatchObject({ action: "order.payment", entityId: done });
    expect(payment.meta).toMatchObject({ amount: 30000, method: "cash", status: { from: "done", to: "paid" } });
    const refund = await one(() => owner.mutation(api.orders.changeStatus, { id: done, to: "refund", reason: "Брак работы" }));
    expect(refund.summary).toContain("Брак работы");
  });

  test("исполнитель: «Взять заказ» и каждый шаг — запись от его имени", async () => {
    const { ids, as, one, mkOrder } = await setup();
    const exec = as(ids.exUser);
    const feed = await mkOrder({ status: "awaiting_executor" });
    const taken = await one(() => exec.mutation(api.worker.take, { id: feed }));
    expect(by(taken)).toMatchObject({ action: "order.taken", entity: "order", entityId: feed, actorId: ids.exUser, actorName: "Асет Новиков" });
    expect(taken.actorRole).toBe("executor");
    for (const [action, to] of [
      ["start", "in_progress"],
      ["wait", "awaiting_client"],
      ["resume", "in_progress"],
      ["done", "done"],
    ] as const) {
      const row = await one(() => exec.mutation(api.worker.act, { id: feed, action }));
      expect(by(row)).toMatchObject({ action: "order.status", entityId: feed, actorId: ids.exUser });
      expect(row.meta).toMatchObject({ to });
    }

    const assigned = await mkOrder({ number: 1003, status: "assigned", executorId: ids.ex });
    const accepted = await one(() => exec.mutation(api.worker.act, { id: assigned, action: "accept" }));
    expect(accepted.meta).toMatchObject({ from: "assigned", to: "accepted" });
    const declined = await one(() => exec.mutation(api.worker.act, { id: assigned, action: "decline" }));
    expect(by(declined)).toMatchObject({ action: "order.declined", entityId: assigned, actorId: ids.exUser });

    const off = await one(() => exec.mutation(api.worker.setAvailable, { available: false }));
    expect(by(off)).toMatchObject({ action: "executor.availability", entity: "executor", entityId: ids.ex, actorId: ids.exUser });
  });

  test("клиенты и исполнители: создание, правка, теги, комментарий, выходной", async () => {
    const { ids, as, one, recorded } = await setup();
    const op = as(ids.operator);
    let clientId: Id<"clients"> | undefined;
    const created = await one(async () => {
      clientId = (await op.mutation(api.clients.create, { name: "Гульмира Ахметова", phone: "77019998877", city: "Алматы", source: "site" })).id;
    });
    expect(by(created)).toMatchObject({ action: "client.created", entity: "client", entityId: clientId, actorId: ids.operator });
    const updated = await one(() => op.mutation(api.clients.update, { id: clientId!, name: "Гульмира Ахметова", phone: "77019998877", city: "Астана", source: "site" }));
    expect(by(updated)).toMatchObject({ action: "client.updated", entityId: clientId });
    expect(updated.summary).toContain("Алматы → Астана");
    expect(await recorded(() => op.mutation(api.clients.update, { id: clientId!, name: "Гульмира Ахметова", phone: "77019998877", city: "Астана", source: "site" }))).toHaveLength(0);
    const tags = await one(() => op.mutation(api.clients.setTags, { id: clientId!, tags: ["VIP"] }));
    expect(by(tags)).toMatchObject({ action: "client.tags", entityId: clientId });
    const note = await one(() => op.mutation(api.clients.addNote, { clientId: clientId!, text: "Просила звонить после 18:00" }));
    expect(by(note)).toMatchObject({ action: "client.note", entityId: clientId });
    expect(JSON.stringify(note)).not.toContain("после 18:00"); // текст комментария остаётся в карточке

    const edited = await one(() =>
      op.mutation(api.executors.update, { id: ids.ex, name: "Асет Новиков", phone: "77000000001", city: "Алматы", categories: ["ac", "plumbing"], skills: ["Чистка кондиционеров"], cooperation: "staff" }),
    );
    expect(by(edited)).toMatchObject({ action: "executor.updated", entity: "executor", entityId: ids.ex, actorId: ids.operator });
    expect(edited.summary).toContain("в штате");
    const off = await one(() => op.mutation(api.executors.setAvailable, { id: ids.ex, available: false }));
    expect(by(off)).toMatchObject({ action: "executor.availability", entityId: ids.ex, actorId: ids.operator });
    expect(await recorded(() => op.mutation(api.executors.setAvailable, { id: ids.ex, available: false }))).toHaveLength(0);
  });

  test("правка только написания навыка — тоже правка: сохраняется и пишется в журнал", async () => {
    const { t, ids, as, one } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.ex, { skills: ["мытье окон"] }));
    const row = await one(() =>
      as(ids.operator).mutation(api.executors.update, { id: ids.ex, name: "Асет Новиков", phone: "77000000001", city: "Алматы", categories: ["ac"], skills: ["мытье окон"], cooperation: "freelance" }),
    );
    expect(by(row)).toMatchObject({ action: "executor.updated", entityId: ids.ex });
    expect((await t.run((ctx) => ctx.db.get(ids.ex)))!.skills).toEqual(["Мытьё окон"]);

    const skills = ["монтаж сплит-систем", "Ремонт кондиционеров", "Чистка кондиционеров", "Заправка фреоном", "Мульти-сплит системы", "Промышленный климат"];
    const cat = await one(() => as(ids.owner).mutation(api.catalog.saveCategory, { id: "ac", label: "Кондиционеры", tone: "blue", active: true, skills }));
    expect(cat.summary).toContain("написание");
    const saved = await t.run((ctx) => ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", "ac")).unique());
    expect(saved?.skills).toEqual(skills);
  });

  test("доступы: новый сотрудник и новый пароль — без паролей в журнале; отключение и смена роли", async () => {
    const { t, ids, as, one, all } = await setup();
    const owner = as(ids.owner);

    let creds: { login: string; password: string } | undefined;
    const staff = await one(async () => {
      creds = await owner.action(api.users.createStaff, { name: "Айдана Сервис", login: "aidana@test.kz", role: "operator" });
    });
    const newUser = (await t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", "aidana@test.kz")).unique()))!;
    expect(by(staff)).toMatchObject({ action: "user.created", entity: "user", entityId: newUser._id, actorId: ids.owner });
    expect(JSON.stringify(staff)).not.toContain(creds!.password);

    let reset: { login: string; password: string } | undefined;
    const pwd = await one(async () => {
      reset = await owner.action(api.users.resetPassword, { userId: ids.operator });
    });
    expect(by(pwd)).toMatchObject({ action: "user.password", entity: "user", entityId: ids.operator, actorId: ids.owner });
    expect(reset!.password.length).toBeGreaterThanOrEqual(8);
    for (const row of await all()) expect(JSON.stringify(row)).not.toContain(reset!.password);

    const off = await one(() => owner.mutation(api.users.setActive, { userId: ids.operator, active: false }));
    expect(by(off)).toMatchObject({ action: "user.access", entityId: ids.operator });
    const role = await one(() => owner.mutation(api.users.updateAccess, { userId: ids.manager, role: "manager", categories: ["plumbing", "electric"] }));
    expect(by(role)).toMatchObject({ action: "user.role", entity: "user", entityId: ids.manager, actorId: ids.owner });
    expect(role.meta).toMatchObject({ from: { role: "manager", categories: ["plumbing"] }, to: { role: "manager", categories: ["plumbing", "electric"] } });
    await expect(as(ids.operator).mutation(api.users.updateAccess, { userId: ids.manager, role: "owner" })).rejects.toThrow();
  });

  test("справочник: что именно поменялось — название, цены и доля исполнителя «было → стало»", async () => {
    const { ids, as, one, recorded } = await setup();
    const owner = as(ids.owner);
    const cat = await one(() => owner.mutation(api.catalog.saveCategory, { id: "ac", label: "Климат", tone: "blue", active: true }));
    expect(by(cat)).toMatchObject({ action: "catalog.category", entity: "catalog", entityId: "ac", actorId: ids.owner });
    expect(cat.summary).toContain("«Кондиционеры» → «Климат»");
    expect(await recorded(() => owner.mutation(api.catalog.saveCategory, { id: "ac", label: "Климат", tone: "blue", active: true }))).toHaveLength(0);

    const svc = await one(() =>
      owner.mutation(api.catalog.saveService, { id: "ac-repair", category: "ac", label: "Ремонт кондиционера", icon: "snowflake", priceMin: 25000, priceMax: 40000, payoutPct: 60, examples: [], active: true }),
    );
    expect(by(svc)).toMatchObject({ action: "catalog.service", entity: "catalog", entityId: "ac-repair" });
    expect(svc.summary).toContain(`${money(20000)}–${money(35000)} → ${money(25000)}–${money(40000)}`);
    expect(svc.summary).toContain("70% → 60%");
    const added = await one(() => owner.mutation(api.catalog.saveService, { category: "ac", label: "Демонтаж", icon: "snowflake", priceMin: 5000, priceMax: 9000, payoutPct: 70, examples: [], active: true }));
    expect(added.summary).toContain("Добавлена услуга «Демонтаж»");
  });

  test("звонки: ключ АТС без самого ключа, загрузка записи, привязка к заявке, заявка от AI", async () => {
    vi.useFakeTimers(); // разбор записи AI в фоне здесь не запускаем
    const { t, ids, as, one, mkLead } = await setup();
    const owner = as(ids.owner);

    let secret = "";
    const key = await one(async () => {
      secret = await owner.mutation(api.calls.regeneratePbxSecret, {});
    });
    expect(by(key)).toMatchObject({ action: "integration.pbxSecret", entity: "integration", actorId: ids.owner });
    expect(secret).toHaveLength(40);
    expect(JSON.stringify(key)).not.toContain(secret);

    const storageId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["fake audio"], { type: "audio/mpeg" }));
      await (ctx.db as unknown as RawDb).patch(id, { contentType: "audio/mpeg" });
      return id;
    });
    // Запись сначала подтверждается (files.confirmUpload): прикрепить можно только свою проверенную загрузку.
    await as(ids.operator).mutation(api.files.confirmUpload, { storageId });
    let callId: Id<"calls"> | undefined;
    const uploaded = await one(async () => {
      callId = await as(ids.operator).mutation(api.calls.upload, { storageId, phone: "77071234567" });
    });
    expect(by(uploaded)).toMatchObject({ action: "call.uploaded", entity: "call", entityId: callId, actorId: ids.operator });
    expect(uploaded.summary).not.toContain("77071234567");

    const lead = await mkLead("ac-repair");
    const linked = await one(() => as(ids.operator).mutation(api.calls.linkLead, { id: callId!, leadId: lead }));
    expect(by(linked)).toMatchObject({ action: "call.linked", entity: "call", entityId: callId });
    expect(linked.meta).toMatchObject({ leadId: lead });
    const other = await mkLead("ac-clean", 2002);
    await expect(as(ids.operator).mutation(api.calls.linkLead, { id: callId!, leadId: other })).rejects.toThrow("уже привязан");

    // Заявку из звонка завёл AI — автор записи «AI», а не сотрудник.
    const call = await t.run((ctx) =>
      ctx.db.insert("calls", { tenantId: T, direction: "in", from: "77015550148", to: "", status: "completed", startedAt: at, aiStatus: "pending" }),
    );
    const byAi = await one(() =>
      t.mutation(internal.calls._saveAi, { id: call, status: "done", ai: AI, draft: { serviceId: "ac-repair", city: "Алматы", clientName: "Гульмира" }, autoLead: true }),
    );
    const leadId = (await t.run((ctx) => ctx.db.get(call)))!.leadId;
    expect(by(byAi)).toMatchObject({ action: "lead.created", entity: "lead", entityId: leadId, actorId: undefined, actorName: "AI" });
    expect(byAi.meta).toMatchObject({ callId: call, newClient: true });
  });

  test("импорт — одна запись с числами; просрочка — запись «Система» один раз", async () => {
    const { t, ids, as, one, recorded, mkOrder } = await setup();
    const imported = await one(() =>
      as(ids.operator).mutation(api.imports.clients, {
        rows: [
          { name: "Новый Клиент", phone: "77010000001" },
          { name: "Клиент Тест", phone: "77071234567" },
          { name: "", phone: "123" },
        ],
      }),
    );
    expect(by(imported)).toMatchObject({ action: "system.import", entity: "system", actorId: ids.operator });
    expect(imported.meta).toMatchObject({ kind: "clients", rows: 3, added: 1, skipped: 2, duplicates: 1 });
    expect(JSON.stringify(imported)).not.toContain("77010000001");

    // Исполнители: у каждого нового — своя запись (ему выдан вход), у импорта — итог с числами; паролей нет нигде.
    let res: { created: { password: string }[] } | undefined;
    const rows = await recorded(async () => {
      res = await as(ids.owner).action(api.imports.executors, {
        rows: [
          { name: "Берик Климатов", phone: "77000000009", city: "Алматы", categories: "Кондиционеры" },
          { name: "Без специализации", phone: "77000000010", city: "Алматы", categories: "" },
        ],
      });
    });
    expect(rows.map((r) => r.action).sort()).toEqual(["executor.created", "system.import"]);
    expect(rows.find((r) => r.action === "system.import")!.meta).toMatchObject({ kind: "executors", rows: 2, created: 1, skipped: 1 });
    expect(rows.every((r) => r.actorId === ids.owner)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(res!.created[0]!.password);

    const late = await mkOrder({ status: "in_progress", executorId: ids.ex, deadline: new Date(Date.now() - 3600_000).toISOString() });
    const overdue = await one(() => t.mutation(internal.reminders.run, {}));
    expect(by(overdue)).toMatchObject({ action: "order.overdue", entity: "order", entityId: late, actorId: undefined, actorName: "Система" });
    expect(await recorded(() => t.mutation(internal.reminders.run, {}))).toHaveLength(0);
  });
});

describe("журнал: чтение", () => {
  /** Записи с известным временем: минута за минутой, самая новая — последняя. */
  async function seedRows(s: Setup) {
    const base = Date.parse("2026-10-01T05:00:00.000Z");
    const rows: { actorId?: Id<"users">; actorName: string; entity: Doc<"audit">["entity"]; summary: string }[] = [
      { actorId: s.ids.operator, actorName: "Мадина Оператор", entity: "lead", summary: "Заявка №2001: Ремонт кондиционера" },
      { actorName: "AI", entity: "lead", summary: "Заявка №2002: звонок разобран AI" },
      { actorId: s.ids.owner, actorName: "Владелец Тест", entity: "order", summary: "Заказ №1001: цена клиента 30 000 ₸ → 35 000 ₸" },
      { actorId: s.ids.operator, actorName: "Мадина Оператор", entity: "client", summary: "Клиент Ёлкин Е.: теги +«VIP»" },
      { actorName: "Система", entity: "order", summary: "Заказ №1001: просрочен срок" },
    ];
    return s.t.run(async (ctx) => {
      const out: Id<"audit">[] = [];
      for (const [i, r] of rows.entries()) {
        out.push(await ctx.db.insert("audit", { tenantId: T, at: new Date(base + i * 60_000).toISOString(), action: `${r.entity}.test`, ...r }));
      }
      return out;
    });
  }
  const page = (numItems: number, cursor: string | null = null) => ({ numItems, cursor });

  test("журнал целиком — только владельцу", async () => {
    const s = await setup();
    await seedRows(s);
    for (const who of [s.ids.operator, s.ids.manager, s.ids.exUser]) {
      await expect(s.as(who).query(api.audit.list, { paginationOpts: page(10) })).rejects.toThrow("Нет доступа");
    }
    const res = await s.as(s.ids.owner).query(api.audit.list, { paginationOpts: page(10) });
    expect(res.page).toHaveLength(5);
  });

  test("страницы: новые сверху, без повторов и пропусков", async () => {
    const s = await setup();
    const inserted = await seedRows(s);
    const owner = s.as(s.ids.owner);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const res: { page: { id: string; at: string }[]; isDone: boolean; continueCursor: string } = await owner.query(api.audit.list, { paginationOpts: page(2, cursor) });
      seen.push(...res.page.map((r) => r.id));
      if (res.isDone) break;
      cursor = res.continueCursor;
    }
    expect(seen).toEqual([...inserted].reverse());
    const first = await owner.query(api.audit.list, { paginationOpts: page(2) });
    expect(first.page.map((r) => r.summary)).toEqual(["Заказ №1001: просрочен срок", "Клиент Ёлкин Е.: теги +«VIP»"]);
    expect(first.page[0]).toEqual(expect.objectContaining({ actorName: "Система", entity: "order" }));
    expect(first.page[0]).not.toHaveProperty("meta");
  });

  test("фильтры: период, кто, тип объекта и текст без учёта регистра", async () => {
    const s = await setup();
    await seedRows(s);
    const owner = s.as(s.ids.owner);
    const summaries = async (args: { from?: string; to?: string; actorId?: Id<"users"> | "system"; entity?: Doc<"audit">["entity"]; q?: string }) =>
      (await owner.query(api.audit.list, { paginationOpts: page(50), ...args })).page.map((r) => r.summary);

    expect(await summaries({ entity: "order" })).toEqual(["Заказ №1001: просрочен срок", "Заказ №1001: цена клиента 30 000 ₸ → 35 000 ₸"]);
    expect(await summaries({ actorId: s.ids.operator })).toEqual(["Клиент Ёлкин Е.: теги +«VIP»", "Заявка №2001: Ремонт кондиционера"]);
    expect(await summaries({ actorId: "system" })).toEqual(["Заказ №1001: просрочен срок", "Заявка №2002: звонок разобран AI"]);
    expect(await summaries({ from: "2026-10-01T05:01:00.000Z", to: "2026-10-01T05:03:00.000Z" })).toHaveLength(3);
    expect(await summaries({ q: "заказ 1001" })).toHaveLength(2);
    expect(await summaries({ q: "ЦЕНА КЛИЕНТА" })).toEqual(["Заказ №1001: цена клиента 30 000 ₸ → 35 000 ₸"]);
    expect(await summaries({ q: "елкин" })).toEqual(["Клиент Ёлкин Е.: теги +«VIP»"]);
    expect(await summaries({ q: "кондиционера", actorId: "system" })).toEqual([]);
    await expect(summaries({ from: "вчера" })).rejects.toThrow("Неверная дата");
  });

  test("«История» объекта: владелец — всё, оператор — рабочие объекты, руководитель — свои заявки и заказы, исполнитель — ничего", async () => {
    const s = await setup();
    const acOrder = await s.mkOrder();
    const pipeOrder = await s.mkOrder({ number: 1002, serviceId: "leak-fix", category: "plumbing" });
    const acLead = await s.mkLead("ac-repair");
    const pipeLead = await s.mkLead("leak-fix", 2002);
    await s.t.run(async (ctx) => {
      const row = (entity: Doc<"audit">["entity"], entityId: string, minute: number) =>
        ctx.db.insert("audit", { tenantId: T, at: `2026-10-01T05:0${minute}:00.000Z`, actorName: "Система", action: `${entity}.test`, entity, entityId, summary: `${entity} ${minute}` });
      await row("order", acOrder, 1);
      await row("order", acOrder, 2);
      await row("order", pipeOrder, 3);
      await row("lead", acLead, 4);
      await row("lead", pipeLead, 5);
      await row("client", s.ids.client, 6);
      await row("user", s.ids.operator, 7);
    });
    const history = (who: Id<"users">, entity: Doc<"audit">["entity"], entityId: string) => s.as(who).query(api.audit.forEntity, { entity, entityId });

    // Новые сверху.
    expect((await history(s.ids.owner, "order", acOrder))!.map((r) => r.summary)).toEqual(["order 2", "order 1"]);
    expect(await history(s.ids.owner, "user", s.ids.operator)).toHaveLength(1);

    expect(await history(s.ids.operator, "client", s.ids.client)).toHaveLength(1);
    expect(await history(s.ids.operator, "lead", acLead)).toHaveLength(1);
    await expect(history(s.ids.operator, "user", s.ids.operator)).rejects.toThrow("Нет доступа");

    expect(await history(s.ids.manager, "order", pipeOrder)).toHaveLength(1);
    expect(await history(s.ids.manager, "lead", pipeLead)).toHaveLength(1);
    expect(await history(s.ids.manager, "order", acOrder)).toBeNull();
    expect(await history(s.ids.manager, "lead", acLead)).toBeNull();
    await expect(history(s.ids.manager, "client", s.ids.client)).rejects.toThrow("Нет доступа");

    for (const [entity, id] of [
      ["order", acOrder],
      ["lead", acLead],
      ["executor", s.ids.ex],
    ] as const) {
      await expect(history(s.ids.exUser, entity, id)).rejects.toThrow("Нет доступа");
    }
  });
});
