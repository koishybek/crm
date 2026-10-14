// Метрики для «Главной» и «Аналитики» — одни и те же формулы, чтобы цифры совпадали между экранами.
// Деньги, стоимость привлечения и работа операторов — в ./analytics (их считает и сервер).
import { doneWithin, sums } from "./analytics";
import { funnelOf, isPaidOrder } from "./dailyStats";
import { isFinished } from "./logic";
import type { DB } from "./types";
import { addDays, startOfDay } from "../lib/format";
import type { Trend } from "../components/ui";

export { sums };

/** Минимум данных для формул: заявки и заказы за период + справочники. */
export type Slice = Pick<DB, "leads" | "orders" | "executors" | "users">;

export type PeriodId = "today" | "7d" | "30d" | "90d";
export const PERIODS: { id: PeriodId; label: string; prev: string }[] = [
  { id: "today", label: "Сегодня", prev: "к вчера" },
  { id: "7d", label: "Последние 7 дней", prev: "к прошлой неделе" },
  { id: "30d", label: "Последние 30 дней", prev: "к прошлым 30 дням" },
  { id: "90d", label: "Последние 90 дней", prev: "к прошлым 90 дням" },
];

export interface Range {
  from: number;
  to: number;
}

export function rangeOf(p: PeriodId, now = Date.now()): { cur: Range; prev: Range; days: number } {
  const today = startOfDay(new Date(now)).getTime();
  const days = p === "today" ? 1 : p === "7d" ? 7 : p === "30d" ? 30 : 90;
  const from = today - (days - 1) * 86400_000;
  // Прошлый период — та же длина и та же «прошедшая часть» последнего дня, чтобы сравнение было честным.
  const elapsed = now - today;
  return {
    days,
    cur: { from, to: now },
    prev: { from: from - days * 86400_000, to: from - days * 86400_000 + (days - 1) * 86400_000 + elapsed },
  };
}

const inR = (iso: string | undefined, r: Range) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return t >= r.from && t <= r.to;
};

/** Выручку признаём в момент выполнения работы (статус «Выполнен» и дальше); возвраты — не выручка. */
export const doneIn = (db: Slice, r: Range) => doneWithin(db.orders, r);
export const leadsIn = (db: Slice, r: Range) => db.leads.filter((l) => inR(l.createdAt, r));
export const ordersCreatedIn = (db: Slice, r: Range) => db.orders.filter((o) => inR(o.createdAt, r));

export function trend(cur: number, prev: number, caption: string, goodWhenUp = true): Trend {
  if (prev === 0) {
    const diff = cur - prev;
    return { value: diff === 0 ? "0" : `${diff > 0 ? "+" : ""}${diff}`, up: diff >= 0, good: goodWhenUp ? diff >= 0 : diff <= 0, caption };
  }
  const p = Math.round(((cur - prev) / prev) * 100);
  return { value: `${p > 0 ? "+" : ""}${p}%`, up: p >= 0, good: goodWhenUp ? p >= 0 : p <= 0, caption };
}

export function funnel(db: Slice, r: Range) {
  const leads = leadsIn(db, r);
  const byId = new Map(db.orders.map((o) => [o.id, o]));
  const orders = leads.filter((l) => l.orderId).map((l) => byId.get(l.orderId!)!);
  return funnelOf({
    leads: leads.length,
    qualified: leads.filter((l) => l.status !== "new").length,
    withOrder: orders.length,
    orderDone: orders.filter((o) => isFinished(o)).length,
    orderPaid: orders.filter(isPaidOrder).length,
  });
}

export function dailySeries(db: Slice, r: Range, days: number) {
  const out: { day: Date; orders: number; revenue: number; leads: number }[] = [];
  const first = startOfDay(new Date(r.from));
  for (let i = 0; i < days; i++) {
    const d = addDays(first, i);
    const dr = { from: d.getTime(), to: addDays(d, 1).getTime() - 1 };
    out.push({ day: d, orders: ordersCreatedIn(db, dr).length, revenue: sums(doneIn(db, dr)).revenue, leads: leadsIn(db, dr).length });
  }
  return out;
}

export function topExecutors(db: Slice, r: Range, limit = 5) {
  const done = doneIn(db, r);
  return db.executors
    .map((e) => {
      const mine = done.filter((o) => o.executorId === e.id);
      return { e, ...sums(mine), late: mine.filter((o) => o.doneAt && o.doneAt > o.deadline).length };
    })
    .filter((x) => x.count > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}
