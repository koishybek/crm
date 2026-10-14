/// <reference types="vite/client" />
// Архив заказов (ТЗ п.27.8, E13): все заказы за всё время — фильтры, поиск, страницы, область руководителя,
// суммы только владельцу.
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import schema from "./schema";
import { parseOrderQuery } from "./lib/orderArchive";
import type { Order, OrderStatus } from "../src/data/types";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const DAY = 86400_000;
const iso = (t: number) => new Date(t).toISOString();
const STATUSES: OrderStatus[] = ["new", "awaiting_executor", "in_progress", "done", "awaiting_payment", "paid", "closed", "cancelled", "refund"];

async function setup() {
  const t = convexTest(schema, modules);
  const now = Date.now();
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель", email: "ac@test.kz", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const ex = await ctx.db.insert("executors", { tenantId: T, name: "Асет Мастеров", phone: "77000000001", city: "Алматы", categories: ["ac", "plumbing"], skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: iso(now) });
    const exUser = await ctx.db.insert("users", { name: "Асет Мастеров", email: "77000000001", role: "executor", executorId: ex, tenantId: T, active: true });
    const client = (name: string, phone: string) => ctx.db.insert("clients", { tenantId: T, name, kind: "person", phone, city: "Алматы", source: "olx", tags: [], createdAt: iso(now), ordersCount: 0, activeCount: 0, lastActivityAt: iso(now) });
    const ivanov = await client("Иванов Пётр", "77071112233");
    const sidorova = await client("Сидорова Анна", "77075556677");
    return { owner, operator, manager, ex, exUser, ivanov, sidorova };
  });
  const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
  return { t, now, ids, as };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** 90 заказов за 180 дней: по два на день, статусы, направления, источники и исполнитель — по кругу. */
async function seed(s: Setup): Promise<Doc<"orders">[]> {
  return s.t.run(async (ctx) => {
    const out: Doc<"orders">[] = [];
    for (let i = 0; i < 90; i++) {
      const status = STATUSES[i % STATUSES.length]!;
      const created = s.now - (180 - i * 2) * DAY;
      const finished = ["done", "awaiting_payment", "paid", "closed"].includes(status);
      const ivanov = i % 3 === 0;
      const id = await ctx.db.insert("orders", {
        tenantId: T,
        number: 3000 + i,
        clientId: ivanov ? s.ids.ivanov : s.ids.sidorova,
        clientName: ivanov ? "Иванов Пётр" : "Сидорова Анна",
        clientPhone: ivanov ? "77071112233" : "77075556677",
        source: i % 4 === 0 ? "phone" : "olx",
        serviceId: i % 2 ? "plumb-leak" : "ac-repair",
        category: i % 2 ? "plumbing" : "ac",
        description: "Тест",
        city: "Алматы",
        address: "ул. Абая, 1",
        deadline: iso(created + DAY),
        priority: "normal",
        status,
        clientPrice: 20000 + i,
        payoutMode: "fixed",
        payoutValue: 10000,
        payments: finished ? [{ id: `p${i}`, amount: 20000 + i, method: "kaspi", at: iso(created + DAY) }] : [],
        payoutPaid: false,
        executorId: i % 5 === 0 ? undefined : s.ids.ex,
        createdAt: iso(created),
        createdBy: s.ids.owner,
        doneAt: finished ? iso(created + DAY) : undefined,
        files: [],
      });
      out.push((await ctx.db.get(id))!);
    }
    return out;
  });
}

/** Все страницы архива подряд — как бесконечная прокрутка. */
async function readAll(s: Setup, who: Id<"users">, filters: Record<string, unknown> = {}, numItems = 20): Promise<{ rows: Order[]; pages: number }> {
  const rows: Order[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages < 100; pages++) {
    const res: { page: Order[]; isDone: boolean; continueCursor: string } = await s.as(who).query(api.orders.list, { paginationOpts: { numItems, cursor }, ...filters });
    rows.push(...res.page);
    if (res.isDone) return { rows, pages };
    cursor = res.continueCursor;
  }
  throw new Error("Слишком много страниц");
}

const numbers = (rows: { number: number }[]) => rows.map((o) => o.number);
const newestFirst = (rows: Doc<"orders">[]) => [...rows].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

describe("архив заказов", () => {
  test("всё время, новые сверху, страницами без пропусков и повторов — в том числе выполненные раньше 45 дней", async () => {
    const s = await setup();
    const all = await seed(s);
    const { rows, pages } = await readAll(s, s.ids.owner, {}, 20);
    expect(pages).toBe(5);
    expect(numbers(rows)).toEqual(numbers(newestFirst(all)));
    // Доска (45 дней) старых выполненных не показывает, архив — показывает.
    const board = await s.as(s.ids.owner).query(api.orders.board, {});
    const old = all.filter((o) => o.doneAt && Date.parse(o.doneAt) < s.now - 60 * DAY);
    expect(old.length).toBeGreaterThan(10);
    expect(board.some((o) => old.some((x) => x._id === o.id))).toBe(false);
    expect(old.every((o) => rows.some((r) => r.id === o._id))).toBe(true);
    // Владелец видит суммы.
    expect(rows.find((o) => o.number === 3003)).toMatchObject({ clientPrice: 20003, payments: [{ amount: 20003 }] });
  });

  test("фильтры: статусы, период по созданию и выполнению, исполнитель, «без исполнителя», источник, направление", async () => {
    const s = await setup();
    const all = await seed(s);
    const expectRows = async (filters: Record<string, unknown>, pick: (o: Doc<"orders">) => boolean, numItems = 7) => {
      const { rows } = await readAll(s, s.ids.owner, filters, numItems);
      const expected = numbers(newestFirst(all.filter(pick)));
      expect(expected.length).toBeGreaterThan(0);
      expect(numbers(rows)).toEqual(expected);
    };
    await expectRows({ statuses: ["paid", "closed"] }, (o) => o.status === "paid" || o.status === "closed");
    const from = iso(s.now - 100 * DAY);
    const to = iso(s.now - 40 * DAY);
    await expectRows({ period: { by: "created", from, to } }, (o) => o.createdAt >= from && o.createdAt <= to);
    await expectRows({ period: { by: "done", from, to } }, (o) => !!o.doneAt && o.doneAt >= from && o.doneAt <= to);
    // Период по выполнению без границ — только выполненные, по дате выполнения.
    const { rows: done } = await readAll(s, s.ids.owner, { period: { by: "done" } }, 9);
    expect(numbers(done)).toEqual(numbers([...all.filter((o) => o.doneAt)].sort((a, b) => (a.doneAt! < b.doneAt! ? 1 : -1))));
    await expectRows({ executorId: "none" }, (o) => !o.executorId);
    await expectRows({ executorId: s.ids.ex, statuses: ["new"] }, (o) => o.executorId === s.ids.ex && o.status === "new");
    await expectRows({ source: "phone", category: "ac" }, (o) => o.source === "phone" && o.category === "ac");
    await expectRows({ statuses: ["cancelled"], period: { by: "created", from } }, (o) => o.status === "cancelled" && o.createdAt >= from);

    await expect(s.as(s.ids.owner).query(api.orders.list, { paginationOpts: { numItems: 10, cursor: null }, period: { by: "created", from: "вчера" } })).rejects.toThrow("Неверная дата");
    await expect(s.as(s.ids.owner).query(api.orders.list, { paginationOpts: { numItems: 10, cursor: null }, period: { by: "created", from: to, to: from } })).rejects.toThrow("Начало периода позже конца");
  });

  test("поиск: номер заказа, телефон и имя клиента — вместе с остальными фильтрами", async () => {
    const s = await setup();
    const all = await seed(s);
    const ivanov = newestFirst(all.filter((o) => o.clientId === s.ids.ivanov));
    expect(numbers((await readAll(s, s.ids.owner, { q: "3042" })).rows)).toEqual([3042]);
    expect(numbers((await readAll(s, s.ids.owner, { q: "№ 3042" })).rows)).toEqual([3042]);
    expect((await readAll(s, s.ids.owner, { q: "3042", statuses: ["new"] })).rows).toEqual([]);
    // Телефон в любом виде — заказы клиента страницами.
    const { rows: byPhone, pages } = await readAll(s, s.ids.owner, { q: "+7 (707) 111-22-33" }, 10);
    expect(numbers(byPhone)).toEqual(numbers(ivanov));
    expect(pages).toBe(3);
    expect(numbers((await readAll(s, s.ids.owner, { q: "87071112233", period: { by: "done" } })).rows)).toEqual(numbers(ivanov.filter((o) => o.doneAt)));
    expect((await readAll(s, s.ids.owner, { q: "77070000000" })).rows).toEqual([]);
    // Имя — через поиск клиентов.
    expect(numbers((await readAll(s, s.ids.owner, { q: "Иванов" })).rows)).toEqual(numbers(ivanov));
    // По имени — последние 50 заказов каждого найденного клиента (вся история — поиском по телефону).
    const sidorova = newestFirst(all.filter((o) => o.clientId === s.ids.sidorova));
    expect(sidorova.length).toBeGreaterThan(50);
    const recent = sidorova.slice(0, 50).filter((o) => o.category === "ac" && o.status === "paid");
    expect(recent.length).toBeGreaterThan(0);
    expect(numbers((await readAll(s, s.ids.owner, { q: "сидорова", category: "ac", statuses: ["paid"] })).rows)).toEqual(numbers(recent));

    expect(parseOrderQuery(" №1024 ")).toEqual({ kind: "number", number: 1024 });
    expect(parseOrderQuery("8 707 111 22 33")).toEqual({ kind: "phone", phone: "77071112233" });
    expect(parseOrderQuery("Иванов 3")).toEqual({ kind: "name", text: "Иванов 3" });
    expect(parseOrderQuery("   ")).toBeNull();
  });

  test("руководитель — только свои направления; оператор и руководитель — без сумм; мастеру архив закрыт", async () => {
    const s = await setup();
    const all = await seed(s);
    const { rows } = await readAll(s, s.ids.manager, {}, 15);
    expect(numbers(rows)).toEqual(numbers(newestFirst(all.filter((o) => o.category === "ac"))));
    expect((await readAll(s, s.ids.manager, { category: "plumbing" })).rows).toEqual([]);
    expect((await readAll(s, s.ids.manager, { q: "3043" })).rows).toEqual([]);
    expect(numbers((await readAll(s, s.ids.manager, { q: "Иванов" })).rows).every((n) => n % 2 === 0)).toBe(true);
    for (const who of [s.ids.manager, s.ids.operator]) {
      const o = (await readAll(s, who, { q: "3006" })).rows[0]!;
      expect(o).toMatchObject({ number: 3006, clientPrice: 0, payoutValue: 0, payments: [], payoutPaid: false });
    }
    await expect(s.as(s.ids.exUser).query(api.orders.list, { paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow("Нет доступа");
    await expect(s.t.query(api.orders.list, { paginationOpts: { numItems: 10, cursor: null } })).rejects.toThrow("Нужно войти");
  });

  test("редкий фильтр не перебирает всю историю за один запрос: страница ограничена чтением, остальное дочитывается", async () => {
    const s = await setup();
    // 1 200 заказов из сайта и один — по телефону, самый старый.
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 1201; i++) {
        await ctx.db.insert("orders", {
          tenantId: T,
          number: 5000 + i,
          clientId: s.ids.sidorova,
          clientName: "Сидорова Анна",
          clientPhone: "77075556677",
          source: i === 0 ? "phone" : "site",
          serviceId: "ac-repair",
          category: "ac",
          description: "Тест",
          city: "Алматы",
          address: "ул. Абая, 1",
          deadline: iso(s.now),
          priority: "normal",
          status: "closed",
          clientPrice: 1000,
          payoutMode: "fixed",
          payoutValue: 500,
          payments: [],
          payoutPaid: true,
          createdAt: iso(s.now - (2000 - i) * 60_000),
          createdBy: s.ids.owner,
          files: [],
        });
      }
    });
    const first = await s.as(s.ids.owner).query(api.orders.list, { paginationOpts: { numItems: 20, cursor: null }, source: "phone" });
    expect(first.page).toEqual([]);
    expect(first.isDone).toBe(false);
    const { rows } = await readAll(s, s.ids.owner, { source: "phone" }, 20);
    expect(numbers(rows)).toEqual([5000]);
  });
});
