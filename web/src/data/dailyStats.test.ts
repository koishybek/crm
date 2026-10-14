// @vitest-environment node
// Паритет предрасчёта (ТЗ §26.6): итоги из dailyStats за любой период совпадают с формулами по сырым заказам и заявкам
// (src/data/analytics.ts, src/data/metrics.ts) — на фикстуре из 300 заказов и 400 заявок.
import { describe, expect, test } from "vitest";
import { doneWithin, operatorRows, paidOutWithin, payoutSummary, receivedWithin, sourceRows, spendWithin, sums, type PaidOutRow, type Span } from "./analytics";
import { doneIn, funnel, leadsIn, ordersCreatedIn, topExecutors, type Slice } from "./metrics";
import { isFinished, payout } from "./logic";
import {
  cashOf,
  dayEnd,
  dayOf,
  dayStart,
  executorRowsOf,
  funnelOfTotals,
  leadFacts,
  mergeCells,
  moneyOf,
  monthOfDay,
  n,
  operatorRowsOf,
  orderFacts,
  repeatOf,
  shiftDay,
  sourceRowsOf,
  summarize,
  summaryWithoutMoney,
  takeMsOf,
  type Cell,
} from "./dailyStats";
import type { Executor, Lead, LeadStatus, Order, OrderStatus, Payment, Refund, SourceId } from "./types";

/** Детерминированный генератор: одна и та же фикстура при каждом прогоне. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const FIRST = "2026-08-01";
const DAYS = 75;
const HOUR = 3600_000;
const SERVICES: Record<string, string> = { "ac-clean": "ac", "pipe-fix": "plumbing", "socket": "electric" };
const SOURCES: SourceId[] = ["olx", "phone", "whatsapp", "telegram", "site"];
const CITIES = ["Алматы", "Астана"];
const EXECUTORS = ["e1", "e2", "e3", "e4", "e5", "e6"];
const OPERATORS = ["u1", "u2", "u3"];
const STATUSES: OrderStatus[] = ["new", "awaiting_executor", "assigned", "accepted", "in_progress", "awaiting_client", "done", "awaiting_payment", "paid", "paid", "closed", "closed", "cancelled", "refund"];
const iso = (t: number) => new Date(t).toISOString();

interface Fixture {
  leads: Lead[];
  orders: Order[];
  auto: Set<string>;
  registry: PaidOutRow[];
  repeat: Set<string>;
}

function fixture(): Fixture {
  const r = rng(20261014);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const start = dayStart(FIRST);
  const orders: Order[] = [];
  const leads: Lead[] = [];
  const auto = new Set<string>();
  const seenClients = new Set<string>();
  const repeat = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const created = start + Math.floor(r() * (DAYS - 3) * 24) * HOUR + Math.floor(r() * 60) * 60_000;
    const status = pick(STATUSES);
    const serviceId = pick(Object.keys(SERVICES));
    const finished = isFinished({ status }) || status === "refund";
    const assigned = !["new", "awaiting_executor"].includes(status) || r() < 0.2;
    const price = 5000 + Math.floor(r() * 110) * 500;
    const mode = r() < 0.5 ? "fixed" : "percent";
    const doneAt = finished ? created + Math.floor(1 + r() * 60) * HOUR : undefined;
    const payments: Payment[] = [];
    if (finished || (status === "cancelled" && r() < 0.3) || (assigned && r() < 0.2)) {
      const parts = 1 + Math.floor(r() * 2);
      for (let k = 0; k < parts; k++) {
        const at = (doneAt ?? created) + Math.floor(r() * 96) * HOUR;
        payments.push({ id: `p${i}-${k}`, amount: Math.round((price / parts) * (r() < 0.1 ? 1.2 : 1)), method: "kaspi", at: iso(at), ...(r() < 0.1 ? { voidedAt: iso(at + HOUR) } : {}) });
      }
    }
    const refunds: Refund[] = [];
    const paid = payments.filter((p) => !p.voidedAt).reduce((s, p) => s + p.amount, 0);
    if (paid > 0 && (status === "refund" || r() < 0.08)) {
      refunds.push({ id: `r${i}`, amount: status === "refund" ? paid : Math.round(paid / 3), method: "cash", at: iso((doneAt ?? created) + Math.floor(r() * 120) * HOUR), reason: "тест", by: "u1" });
    }
    const payoutPaid = finished && r() < 0.5;
    const clientId = `c${Math.floor(r() * 220)}`;
    const id = `o${i}`;
    const o = {
      id,
      number: 1000 + i,
      clientId,
      clientName: "Клиент",
      clientPhone: "",
      leadId: `l${i}`,
      source: pick(SOURCES),
      serviceId,
      category: SERVICES[serviceId]!,
      city: pick(CITIES),
      createdAt: iso(created),
      deadline: iso(created + Math.floor(4 + r() * 48) * HOUR),
      status,
      clientPrice: price,
      payoutMode: mode,
      payoutValue: mode === "fixed" ? Math.round(price * 0.6) : 55 + Math.floor(r() * 15),
      payments,
      ...(refunds.length ? { refunds } : {}),
      payoutPaid,
      ...(payoutPaid && doneAt ? { payoutPaidAt: iso(doneAt + Math.floor(r() * 200) * HOUR) } : {}),
      ...(assigned ? { executorId: pick(EXECUTORS), assignedAt: iso(created + 30 * 60_000) } : {}),
      ...(doneAt ? { doneAt: iso(doneAt) } : {}),
    } as unknown as Order;
    orders.push(o);
    // Заказы сортируются по времени ниже — «повторный» считаем после сортировки.
    void seenClients;
    const leadAt = created - Math.floor(r() * 48) * HOUR;
    const operatorId = r() < 0.15 ? undefined : pick(OPERATORS);
    leads.push({ id: `l${i}`, source: o.source, serviceId, city: o.city, status: "converted", createdAt: iso(leadAt), orderId: id, operatorId } as unknown as Lead);
    if (operatorId && r() < 0.1) auto.add(`l${i}`);
  }
  for (let i = 300; i < 400; i++) {
    const statuses: LeadStatus[] = ["new", "qualifying", "waiting", "rejected"];
    leads.push({
      id: `l${i}`,
      source: pick(SOURCES),
      serviceId: pick(Object.keys(SERVICES)),
      city: pick(CITIES),
      status: pick(statuses),
      createdAt: iso(start + Math.floor(r() * DAYS * 24) * HOUR),
      operatorId: r() < 0.3 ? undefined : pick(OPERATORS),
    } as unknown as Lead);
  }
  for (const o of [...orders].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    if (seenClients.has(o.clientId)) repeat.add(o.id);
    seenClients.add(o.clientId);
  }
  // Реестр выплат согласован с заказами: одна выплата на мастера и день — сумма выплат её заказов.
  const reg = new Map<string, PaidOutRow>();
  for (const o of orders) {
    if (!o.payoutPaid || !o.payoutPaidAt) continue;
    const k = `${o.executorId}|${o.payoutPaidAt}`;
    const row = reg.get(k) ?? { at: o.payoutPaidAt, amount: 0 };
    row.amount += payout(o);
    reg.set(k, row);
  }
  return { leads, orders, auto, registry: [...reg.values()], repeat };
}

/** Факты всех сущностей → итоги по дням (как convex/stats.ts: statsFacts → dailyStats). */
function dayRows(f: Fixture): Map<string, Cell[]> {
  const byDay = new Map<string, Cell[]>();
  const add = (facts: Map<string, Cell>) => {
    for (const [day, cell] of facts) byDay.set(day, [...(byDay.get(day) ?? []), cell]);
  };
  const orderById = new Map(f.orders.map((o) => [o.id, o]));
  for (const o of f.orders) add(orderFacts(o, { repeat: f.repeat.has(o.id) }));
  for (const l of f.leads) add(leadFacts(l, { category: SERVICES[l.serviceId]!, order: l.orderId ? orderById.get(l.orderId) : null, auto: f.auto.has(l.id) }));
  return new Map([...byDay].map(([day, cells]) => [day, mergeCells(cells)]));
}

const spanOf = (from: string, to: string): Span => ({ from: dayStart(from), to: dayEnd(to) });
function cellsIn(rows: Map<string, Cell[]>, from: string, to: string): Cell[] {
  const out: Cell[] = [];
  for (let d = from; d <= to; d = shiftDay(d, 1)) out.push(...(rows.get(d) ?? []));
  return out;
}

const f = fixture();
const rows = dayRows(f);
const executors = EXECUTORS.map((id) => ({ id, name: id, rating: 4.5, reviews: 0 }));
const db: Slice = { leads: f.leads, orders: f.orders, executors: executors as unknown as Executor[], users: [] };
const PERIODS: [string, string][] = [
  [FIRST, shiftDay(FIRST, DAYS + 10)],
  [shiftDay(FIRST, 10), shiftDay(FIRST, 16)],
  [shiftDay(FIRST, 20), shiftDay(FIRST, 49)],
  [shiftDay(FIRST, 33), shiftDay(FIRST, 33)],
  ["2026-07-01", "2026-07-31"],
];

describe("dailyStats: паритет с формулами по сырым данным", () => {
  test("фикстура реалистичная: 300 заказов, 400 заявок, есть возвраты, сторно, выплаты и отмены", () => {
    expect(f.orders).toHaveLength(300);
    expect(f.leads).toHaveLength(400);
    expect(f.orders.some((o) => o.refunds?.length)).toBe(true);
    expect(f.orders.some((o) => o.payments.some((p) => p.voidedAt))).toBe(true);
    expect(f.orders.some((o) => o.status === "cancelled")).toBe(true);
    expect(f.registry.length).toBeGreaterThan(10);
  });

  test.each(PERIODS)("деньги, касса, выплаты и воронка за %s — %s", (from, to) => {
    const s = spanOf(from, to);
    const sum = summarize(cellsIn(rows, from, to), { operators: true });
    expect(moneyOf(sum.t)).toEqual(sums(doneWithin(f.orders, s)));
    expect(cashOf(sum.t)).toEqual(receivedWithin(f.orders, s));
    expect(n(sum.t, "paidOut")).toBe(paidOutWithin(f.registry, s));
    const pay = payoutSummary(f.orders, s).period;
    expect({ accrued: n(sum.t, "payouts"), paid: n(sum.t, "accruedPaid"), orders: n(sum.t, "done") }).toEqual({ accrued: pay.accrued, paid: pay.paid, orders: pay.orders });
    expect(funnelOfTotals(sum.t)).toEqual(funnel(db, s));
    expect(n(sum.t, "leads")).toBe(leadsIn(db, s).length);
    expect(n(sum.t, "created")).toBe(ordersCreatedIn(db, s).length);
  });

  test.each(PERIODS)("источники, операторы, мастера и направления за %s — %s", (from, to) => {
    const s = spanOf(from, to);
    const sum = summarize(cellsIn(rows, from, to), { operators: true });
    const spend = spendWithin(
      [
        { month: "2026-08", source: "olx", amount: 310_000 },
        { month: "2026-09", source: "site", amount: 90_000 },
      ],
      s,
    );
    expect(sourceRowsOf(sum, spend)).toEqual(sourceRows(f.leads, f.orders, spend, s));

    const raw = operatorRows(f.leads, f.orders, f.auto, s);
    const pre = operatorRowsOf(sum);
    const byUser = (x: { userId?: string }, y: { userId?: string }) => (x.userId ?? "").localeCompare(y.userId ?? "");
    expect([...pre.rows].sort(byUser)).toEqual([...raw.rows].sort(byUser));
    expect(pre.auto).toEqual(raw.auto);

    const top = topExecutors(db, s, 100);
    const table = executorRowsOf(sum, executors, true).filter((x) => x.done > 0);
    expect(table.map((x) => ({ id: x.id, count: x.done, revenue: x.revenue, margin: x.margin, late: x.late })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      top.map((x) => ({ id: x.e.id, count: x.count, revenue: x.revenue, margin: x.margin, late: x.late })).sort((a, b) => a.id.localeCompare(b.id)),
    );

    const done = doneIn(db, s);
    const byCat = Object.fromEntries([...new Set(done.map((o) => o.category))].map((c) => [c, sums(done.filter((o) => o.category === c)).margin]));
    expect(Object.fromEntries(sum.categories.filter((c) => n(c.t, "done") > 0).map((c) => [c.category, moneyOf(c.t).margin]))).toEqual(byCat);
  });

  test("ряд по дням: заявки, созданные заказы и выручка каждого дня — как dailySeries", () => {
    for (let d = FIRST; d < shiftDay(FIRST, DAYS); d = shiftDay(d, 1)) {
      const t = summarize(rows.get(d) ?? []).t;
      const r = { from: dayStart(d), to: dayEnd(d) };
      expect([n(t, "leads"), n(t, "created"), n(t, "revenue")]).toEqual([leadsIn(db, r).length, ordersCreatedIn(db, r).length, sums(doneIn(db, r)).revenue]);
    }
  });

  test("месяц из дней = те же итоги, что и дни месяца (месячные итоги для длинных периодов)", () => {
    const august = [...rows].filter(([d]) => monthOfDay(d) === "2026-08").flatMap(([, c]) => c);
    const month = mergeCells(august);
    expect(summarize(month, { operators: true })).toEqual(summarize(august, { operators: true }));
  });

  test("повторные клиенты: доля выполненных заказов и выручки от клиентов, у которых заказ уже был", () => {
    const s = spanOf(FIRST, shiftDay(FIRST, DAYS + 10));
    const done = doneWithin(f.orders, s);
    const rep = done.filter((o) => f.repeat.has(o.id));
    const t = summarize(cellsIn(rows, FIRST, shiftDay(FIRST, DAYS + 10))).t;
    const r = repeatOf(t);
    expect(r.orders).toBe(rep.length);
    expect(r.share).toBeCloseTo(rep.length / done.length, 10);
    expect(r.revenue).toBe(sums(rep).revenue);
    expect(r.revenueShare).toBeCloseTo(sums(rep).revenue / sums(done).revenue, 10);
    expect(r.orders).toBeGreaterThan(0);
  });

  test("без денег: ни одного денежного ключа в итогах, разбивках и у мастеров; операторов нет", () => {
    const sum = summaryWithoutMoney(summarize(cellsIn(rows, FIRST, shiftDay(FIRST, DAYS)), { operators: true }));
    const keys = [sum.t, ...sum.sources.map((x) => x.t), ...sum.categories.map((x) => x.t), ...sum.executors.map((e) => e.c)].flatMap((c) => Object.keys(c));
    for (const k of ["revenue", "payouts", "accruedPaid", "repeatRevenue", "received", "refunded", "paidOut"]) expect(keys).not.toContain(k);
    expect(keys).toContain("done");
    expect(sum.operators).toEqual([]);
    const table = executorRowsOf(sum, executors, false);
    expect(table.every((x) => x.revenue === undefined && x.accrued === undefined && x.paidOut === undefined)).toBe(true);
  });
});

describe("dailyStats: факты мастера (ТЗ 17.10)", () => {
  const base = {
    category: "ac",
    source: "olx" as SourceId,
    city: "Алматы",
    clientPrice: 20000,
    payoutMode: "fixed" as const,
    payoutValue: 12000,
    payments: [],
    payoutPaid: false,
  };

  test("отказ мастера — в день отказа ему, отмена — в день отмены текущему мастеру", () => {
    const facts = orderFacts(
      { ...base, status: "cancelled", createdAt: "2026-10-01T05:00:00.000Z", deadline: "2026-10-02T05:00:00.000Z", executorId: "e2", assignedAt: "2026-10-02T04:00:00.000Z" },
      {
        events: [
          { at: "2026-10-01T06:00:00.000Z", from: "new", to: "awaiting_executor" },
          { at: "2026-10-01T22:00:00.000Z", from: "accepted", to: "awaiting_executor", byExecutor: "e1" },
          { at: "2026-10-03T20:00:00.000Z", from: "assigned", to: "cancelled" },
        ],
      },
    );
    // 22:00 UTC 1 октября — уже 2 октября по Алматы; 20:00 UTC 3-го — 4 октября.
    expect(facts.get("2026-10-02")!.ex).toEqual([{ id: "e1", c: { refusals: 1 } }]);
    expect(facts.get("2026-10-04")!.t).toEqual({ cancelled: 1 });
    expect(facts.get("2026-10-04")!.ex).toEqual([{ id: "e2", c: { cancelled: 1 } }]);
    expect(facts.get("2026-10-01")!.t).toEqual({ created: 1 });
  });

  test("время до взятия — от последней публикации до назначения; вовремя и с опозданием", () => {
    const events = [
      { at: "2026-10-01T06:00:00.000Z", from: "new" as const, to: "awaiting_executor" as const },
      { at: "2026-10-01T07:00:00.000Z", from: "assigned" as const, to: "awaiting_executor" as const, byExecutor: "e1" },
      { at: "2026-10-01T09:00:00.000Z", from: "awaiting_executor" as const, to: "accepted" as const },
    ];
    expect(takeMsOf({ assignedAt: "2026-10-01T07:30:00.000Z" }, events)).toBe(30 * 60_000);
    expect(takeMsOf({ assignedAt: "2026-10-01T05:00:00.000Z" }, events)).toBeNull();
    const late = orderFacts(
      { ...base, status: "paid", createdAt: "2026-10-01T05:00:00.000Z", deadline: "2026-10-01T10:00:00.000Z", doneAt: "2026-10-01T12:00:00.000Z", executorId: "e3", assignedAt: "2026-10-01T07:30:00.000Z" },
      { events },
    );
    const ex = late.get(dayOf("2026-10-01T12:00:00.000Z"))!.ex.find((e) => e.id === "e3")!.c;
    expect(ex).toMatchObject({ done: 1, late: 1, takeMs: 30 * 60_000, takeN: 1, workMs: 4.5 * HOUR, workN: 1, revenue: 20000, payouts: 12000 });
    const rows = executorRowsOf(summarize([...late.values()]), [{ id: "e3", name: "Мастер", rating: 4.8, reviews: 3 }], true);
    expect(rows[0]).toMatchObject({ done: 1, late: 1, onTime: 0, avgTakeMs: 30 * 60_000, avgWorkMs: 4.5 * HOUR, accrued: 12000, margin: 8000, rating: 4.8, reviews: 3 });
  });
});
