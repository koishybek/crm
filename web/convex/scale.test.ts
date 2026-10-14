/// <reference types="vite/client" />
// Масштаб (E22, E23; ТЗ п.26.6): напоминания о сроках и колокольчик читают только горящие заказы по индексу,
// а не все активные; сотрудники — один раз на запуск. Поведение — как раньше: сверяем с эталоном прежнего алгоритма
// на ~200 заказах (кто, что и в каком порядке получает), а ограничение чтений convex-test доказывает, что полного прохода нет.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { loadCatalog } from "./catalog";
import { almatyStamp } from "./lib/audit";
import { REMINDER_BATCH } from "./reminders";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import type { OrderStatus } from "../src/data/types";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-komfort";
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 86400_000;
const NOW = Date.parse("2026-10-14T06:00:00.000Z");
const iso = (t: number) => new Date(t).toISOString();
/** Сравнение строк по кодам символов — так упорядочивает индекс Convex. */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

afterEach(() => {
  vi.useRealTimers();
});

const ALL_STATUSES: OrderStatus[] = ["new", "awaiting_executor", "assigned", "accepted", "in_progress", "awaiting_client", "done", "awaiting_payment", "paid", "closed", "cancelled", "refund"];
/** Сроки вокруг границ: просрочка, «скоро» для напоминания (≤ 2 ч) и для колокольчика (< 3 ч), дальше — тишина. */
const OFFSETS = [-3 * DAY, -5 * HOUR, -90 * MIN, -MIN, 0, MIN, 30 * MIN, 119 * MIN, 2 * HOUR, 2 * HOUR + MIN, 150 * MIN, 3 * HOUR - MIN, 3 * HOUR, 5 * HOUR, 2 * DAY];

type Ids = Awaited<ReturnType<typeof seedPeople>>;

async function seedPeople(t: ReturnType<typeof convexTest>) {
  return t.run(async (ctx) => {
    const user = (name: string, extra: Partial<Doc<"users">>) => ctx.db.insert("users", { name, email: `${name}@test.kz`, tenantId: T, active: true, ...extra });
    const owner = await user("owner", { role: "owner" });
    const formerOwner = await user("former", { role: "owner", active: false });
    const operator = await user("operator", { role: "operator" });
    const quitOperator = await user("quit", { role: "operator", active: false });
    const acManager = await user("acman", { role: "manager", categories: ["ac"] });
    const plumbManager = await user("plumbman", { role: "manager", categories: ["plumbing"] });
    const ex = async (name: string, categories: string[], withUser: boolean) => {
      const id = await ctx.db.insert("executors", { tenantId: T, name, phone: `7700${name.length}000000`.slice(0, 11), city: "Алматы", categories, skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: iso(NOW) });
      const u = withUser ? await user(name, { role: "executor", executorId: id }) : null;
      return { id, user: u };
    };
    const e1 = await ex("e-one", ["ac"], true);
    const e2 = await ex("e-two", ["plumbing"], true);
    const e3 = await ex("e-three-nouser", ["ac"], false);
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: iso(NOW), ordersCount: 0, activeCount: 0, lastActivityAt: iso(NOW) });
    return { owner, formerOwner, operator, quitOperator, acManager, plumbManager, e1, e2, e3, client };
  });
}

/** ~200 заказов: все статусы, оба направления, сроки у границ окон, часть уже с отметками напоминаний. */
async function seedOrders(t: ReturnType<typeof convexTest>, ids: Ids, count = 204) {
  let seed = 7;
  const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
  return t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      const category = i % 2 ? "plumbing" : "ac";
      const executors = [undefined, category === "ac" ? ids.e1.id : ids.e2.id, ids.e3.id];
      const flags = rnd(5);
      await ctx.db.insert("orders", {
        tenantId: T,
        number: 1000 + i,
        clientId: ids.client,
        clientName: "Клиент",
        clientPhone: "77071234567",
        source: "olx",
        serviceId: category === "ac" ? "ac-repair" : "plumb-leak",
        category,
        description: "Тест",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: iso(NOW + OFFSETS[rnd(OFFSETS.length)]!),
        priority: "normal",
        status: ALL_STATUSES[rnd(ALL_STATUSES.length)]!,
        clientPrice: 10000,
        payoutMode: "fixed",
        payoutValue: 5000,
        payments: [],
        payoutPaid: false,
        executorId: executors[rnd(executors.length)],
        createdAt: iso(NOW - 5 * DAY),
        createdBy: ids.owner,
        files: [],
        ...(flags === 1 ? { soonNotified: true } : flags === 2 ? { soonNotified: true, overdueNotified: true } : {}),
      });
    }
  });
}

type Bell = { userId: Id<"users">; text: string; link?: string; tone: string };

/** Эталон: прежний reminders.run — каждый активный заказ, на каждый — список сотрудников заново. */
function legacyReminders(orders: Doc<"orders">[], users: Doc<"users">[], now: number, label: (serviceId: string) => string) {
  const byRole = (role: string) => users.filter((u) => u.role === role).sort((a, b) => a._creationTime - b._creationTime);
  const owners = byRole("owner").map((u) => u._id);
  const staffIds = (category: string) => [...byRole("owner"), ...byRole("operator"), ...byRole("manager").filter((u) => u.categories?.includes(category))].filter((u) => u.active !== false).map((u) => u._id);
  const active = new Map(users.map((u) => [u._id, u.active !== false]));
  const bells: Bell[] = [];
  const notify = (to: Id<"users">[], text: string, link: string, tone: string) => {
    for (const id of new Set(to)) if (active.get(id)) bells.push({ userId: id, text, link, tone });
  };
  const flags = new Map<Id<"orders">, { soonNotified?: boolean; overdueNotified?: boolean }>();
  const audits: { entityId: string; summary: string; meta: unknown }[] = [];
  for (const s of ACTIVE_STATUSES) {
    for (const o of orders.filter((x) => x.status === s).sort((a, b) => cmp(a.deadline, b.deadline) || a._creationTime - b._creationTime)) {
      const t = Date.parse(o.deadline);
      const ex = o.executorId ? users.find((u) => u.executorId === o.executorId)?._id : undefined;
      const lbl = `№${o.number} (${label(o.serviceId)})`;
      const staff = staffIds(o.category);
      if (t < now && !o.overdueNotified) {
        const escalated = [...new Set([...owners, ...staff])];
        flags.set(o._id, { overdueNotified: true, soonNotified: true });
        notify(escalated, `Просрочка: заказ ${lbl}`, `/orders/${o._id}`, "bad");
        if (ex) notify([ex], `Просрочен срок по заказу ${lbl} — сообщите оператору, когда закончите`, `/w/orders/${o._id}`, "bad");
        audits.push({
          entityId: o._id,
          summary: `Заказ №${o.number}: просрочен срок ${almatyStamp(o.deadline)} — уведомлены владелец и ответственные (${escalated.length})${ex ? " и исполнитель" : ""}`,
          meta: { deadline: o.deadline, status: o.status, notified: escalated.length, executorNotified: !!ex },
        });
      } else if (t >= now && t - now <= 2 * HOUR && !o.soonNotified) {
        flags.set(o._id, { soonNotified: true });
        notify(staff, `Скоро срок: заказ ${lbl}`, `/orders/${o._id}`, "warn");
        if (ex) notify([ex], `Через 2 часа срок по заказу ${lbl}`, `/w/orders/${o._id}`, "warn");
      }
    }
  }
  return { bells, flags, audits };
}

/** Эталон: прежний колокольчик — все активные заказы (у мастера — все его заказы), затем фильтр по сроку. */
function legacyAlerts(orders: Doc<"orders">[], me: Doc<"users">, now: number) {
  let pool: Doc<"orders">[];
  if (me.role === "executor") {
    pool = orders.filter((o) => me.executorId && o.executorId === me.executorId).sort((a, b) => cmp(a.status, b.status) || a._creationTime - b._creationTime);
  } else {
    pool = ACTIVE_STATUSES.flatMap((s) => orders.filter((o) => o.status === s).sort((a, b) => cmp(a.deadline, b.deadline) || a._creationTime - b._creationTime));
  }
  const scope = me.role === "manager" ? (me.categories ?? []) : null;
  const active = pool.filter((o) => ACTIVE_STATUSES.includes(o.status) && (!scope || scope.includes(o.category)));
  const base = me.role === "executor" ? "/w/orders/" : "/orders/";
  const late = active.filter((o) => Date.parse(o.deadline) < now);
  const soon = active.filter((o) => {
    const t = Date.parse(o.deadline);
    return t >= now && t - now < 3 * HOUR;
  });
  return [
    ...late.slice(0, 4).map((o) => ({ id: `late-${o._id}`, text: `Просрочка по заказу №${o.number}`, link: base + o._id, tone: "bad" })),
    ...soon.slice(0, 3).map((o) => ({ id: `soon-${o._id}`, text: `Скоро срок: заказ №${o.number}`, link: base + o._id, tone: "warn" })),
  ];
}

const sortBells = (rows: Bell[]) => [...rows].sort((a, b) => cmp(`${a.userId}|${a.link}|${a.text}`, `${b.userId}|${b.link}|${b.text}`));

describe("напоминания о сроках на ~200 заказах", () => {
  test("те же уведомления, отметки и записи журнала, что у прежнего алгоритма; пачками, без повторов", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const t = convexTest(schema, modules);
    const ids = await seedPeople(t);
    await seedOrders(t, ids);
    const { orders, users, label } = await t.run(async (ctx) => {
      const cat = await loadCatalog(ctx);
      return { orders: await ctx.db.query("orders").collect(), users: await ctx.db.query("users").collect(), label: Object.fromEntries(cat.services.map((s) => [s.id, s.label])) };
    });
    const expected = legacyReminders(orders, users, NOW, (id) => label[id] ?? id);
    // На данных действительно есть и просрочки, и «скоро срок», и их больше одной пачки.
    expect(expected.audits.length).toBeGreaterThan(5);
    expect(expected.bells.some((b) => b.tone === "warn")).toBe(true);
    expect(expected.flags.size).toBeGreaterThan(REMINDER_BATCH);

    // Первый запуск — ровно одна пачка, остальное — продолжением сразу после него.
    await t.mutation(internal.reminders.run, {});
    const afterFirst = await t.run(async (ctx) => (await ctx.db.query("orders").collect()).filter((o) => o.soonNotified !== orders.find((x) => x._id === o._id)!.soonNotified || o.overdueNotified !== orders.find((x) => x._id === o._id)!.overdueNotified));
    expect(afterFirst).toHaveLength(REMINDER_BATCH);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await t.run(async (ctx) => ({
      orders: await ctx.db.query("orders").collect(),
      bells: await ctx.db.query("notifications").collect(),
      audits: (await ctx.db.query("audit").collect()).filter((a) => a.action === "order.overdue"),
    }));
    expect(sortBells(after.bells.map((n) => ({ userId: n.userId, text: n.text, link: n.link, tone: n.tone })))).toEqual(sortBells(expected.bells));
    for (const o of after.orders) {
      const before = orders.find((x) => x._id === o._id)!;
      const patch = expected.flags.get(o._id) ?? {};
      expect({ soon: o.soonNotified, overdue: o.overdueNotified }).toEqual({ soon: patch.soonNotified ?? before.soonNotified, overdue: patch.overdueNotified ?? before.overdueNotified });
    }
    const audits = after.audits.map((a) => ({ entityId: a.entityId, summary: a.summary, meta: a.meta, actorName: a.actorName }));
    expect(audits.sort((a, b) => cmp(a.entityId!, b.entityId!))).toEqual(expected.audits.map((a) => ({ ...a, actorName: "Система" })).sort((a, b) => cmp(a.entityId, b.entityId)));

    // Повторный запуск ничего не повторяет.
    await t.mutation(internal.reminders.run, {});
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toHaveLength(after.bells.length);
  });

  test("читает только горящие заказы: сотни активных с далёким сроком и история мастера не читаются", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Прежний проход по всем активным заказам (и три запроса сотрудников на каждый), как и колокольчик мастера
    // по всей его истории, в этот лимит не укладывались.
    const t = convexTest({ schema, modules, transactionLimits: { documentsRead: 150 } });
    const ids = await seedPeople(t);
    await t.run(async (ctx) => {
      for (let i = 0; i < 405; i++) {
        // 0–4 горят (два просрочены, три — в ближайшие 2 часа), 5–204 — активные со сроком через 3–6 дней,
        // 205–404 — закрытые заказы мастера e-one (его история).
        const burning = i < 5;
        const history = i >= 205;
        await ctx.db.insert("orders", {
          tenantId: T,
          number: 2000 + i,
          clientId: ids.client,
          clientName: "Клиент",
          clientPhone: "77071234567",
          source: "olx",
          serviceId: "ac-repair",
          category: i % 2 ? "plumbing" : "ac",
          description: "Тест",
          city: "Алматы",
          address: "ул. Абая, 1",
          deadline: iso(i < 2 ? NOW - HOUR - i * MIN : burning ? NOW + 30 * MIN + i * MIN : history ? NOW - 10 * DAY : NOW + (3 + (i % 4)) * DAY),
          priority: "normal",
          status: history ? "closed" : ACTIVE_STATUSES[i % ACTIVE_STATUSES.length]!,
          clientPrice: 10000,
          payoutMode: "fixed",
          payoutValue: 5000,
          payments: [],
          payoutPaid: false,
          executorId: i < 3 || history ? ids.e1.id : undefined,
          createdAt: iso(NOW - 20 * DAY),
          createdBy: ids.owner,
          files: [],
        });
      }
    });
    await t.mutation(internal.reminders.run, {});
    const flagged = await t.run(async (ctx) => {
      let n = 0;
      for (const s of ACTIVE_STATUSES) n += (await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s).lte("deadline", iso(NOW + 2 * HOUR))).collect()).filter((o) => o.soonNotified).length;
      return n;
    });
    expect(flagged).toBe(5);
    const mark = await t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "reminders")).unique());
    expect(mark?.okNote).toBe("Проверено активных заказов: 5");

    // Колокольчик владельца, оператора, руководителя и мастера тоже не читает всё подряд.
    const bell = async (who: Id<"users">) => (await t.withIdentity({ subject: `${who}|s` }).query(api.notifications.mine, { now: NOW }))!.alerts.map((a) => a.text);
    expect(await bell(ids.owner)).toEqual(["Просрочка по заказу №2000", "Просрочка по заказу №2001", "Скоро срок: заказ №2002", "Скоро срок: заказ №2003", "Скоро срок: заказ №2004"]);
    expect(await bell(ids.operator)).toHaveLength(5);
    expect(await bell(ids.acManager)).toEqual(["Просрочка по заказу №2000", "Скоро срок: заказ №2002", "Скоро срок: заказ №2004"]);
    // У мастера порядок — как в индексе by_executor: статусы по алфавиту («awaiting_executor» раньше «new»).
    expect(await bell(ids.e1.user!)).toEqual(["Просрочка по заказу №2001", "Просрочка по заказу №2000", "Скоро срок: заказ №2002"]);
  });
});

describe("колокольчик на ~200 заказах", () => {
  test("горящие сроки — те же и в том же порядке, что у прежнего полного прохода", async () => {
    const t = convexTest(schema, modules);
    const ids = await seedPeople(t);
    await seedOrders(t, ids);
    const { orders, users } = await t.run(async (ctx) => ({ orders: await ctx.db.query("orders").collect(), users: await ctx.db.query("users").collect() }));
    const people = [ids.owner, ids.operator, ids.acManager, ids.plumbManager, ids.e1.user!, ids.e2.user!];
    let alerts = 0;
    for (const id of people) {
      const me = users.find((u) => u._id === id)!;
      for (const now of [NOW, NOW + 90 * MIN, NOW - DAY]) {
        const got = await t.withIdentity({ subject: `${id}|s` }).query(api.notifications.mine, { now });
        expect(got!.alerts).toEqual(legacyAlerts(orders, me, now));
        alerts += got!.alerts.length;
      }
    }
    expect(alerts).toBeGreaterThan(20);
    // «Сейчас» не дата — горящих сроков нет, но уведомления на месте.
    const odd = await t.withIdentity({ subject: `${ids.owner}|s` }).query(api.notifications.mine, { now: Number.NaN });
    expect(odd).toMatchObject({ alerts: [] });
  });
});
