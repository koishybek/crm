// Аналитика владельца (ТЗ п.17): деньги, стоимость привлечения, работа операторов, выплаты исполнителям.
// Чистые функции — общие для «Аналитики», «Главной» и сервера (convex/analytics.ts), чтобы цифры совпадали везде.
import { SOURCE_IDS } from "./catalog";
import { isFinished, payout, revenueOf, type RevenueLike } from "./logic";
import type { Lead, Order, SourceId } from "./types";

/** Период в миллисекундах, обе границы включительно. */
export interface Span {
  from: number;
  to: number;
}

const inSpan = (iso: string | undefined, s: Span): boolean => {
  if (!iso) return false;
  const t = Date.parse(iso);
  return t >= s.from && t <= s.to;
};

/**
 * Выручку и маржу признаём в момент выполнения работы (статус «Выполнен» и дальше по пути до «Закрыт»).
 * Возврат — не выручка и не маржа: деньги ушли обратно клиенту (E1).
 */
export const doneWithin = <O extends Pick<Order, "status" | "doneAt">>(orders: readonly O[], s: Span): O[] => orders.filter((o) => isFinished(o) && inSpan(o.doneAt, s));

type Money = RevenueLike & Pick<Order, "payoutMode" | "payoutValue">;

/**
 * Выручка, выплаты исполнителям, маржа, число заказов и средний чек. Выручка — за вычетом возвратов по этим заказам
 * (частичный возврат уменьшает выручку и маржу; заказ с полным возвратом сюда не попадает вовсе — doneWithin).
 */
export const sums = (orders: readonly Money[]) => {
  const revenue = orders.reduce((s, o) => s + revenueOf(o), 0);
  const payouts = orders.reduce((s, o) => s + payout(o), 0);
  return { revenue, payouts, margin: revenue - payouts, count: orders.length, avg: orders.length ? revenue / orders.length : 0 };
};

// ── Деньги по датам: получено от клиентов и выплачено мастерам ───────────────

type CashOrder = Pick<Order, "payments" | "refunds">;

/**
 * «Получено» за период — по датам оплат, а не по дате выполнения: оплаты (без сторнированных) минус возвраты,
 * сделанные в этом периоде.
 */
export function receivedWithin(orders: readonly CashOrder[], s: Span): { received: number; refunded: number; net: number } {
  let received = 0;
  let refunded = 0;
  for (const o of orders) {
    for (const p of o.payments) if (!p.voidedAt && inSpan(p.at, s)) received += p.amount;
    for (const r of o.refunds ?? []) if (inSpan(r.at, s)) refunded += r.amount;
  }
  return { received, refunded, net: received - refunded };
}

/** Строка реестра выплат: дата и сумма. */
export interface PaidOutRow {
  at: string;
  amount: number;
}

/** «Выплачено мастерам» за период — по датам выплат из реестра. */
export const paidOutWithin = (rows: readonly PaidOutRow[], s: Span): number => rows.reduce((sum, r) => (inSpan(r.at, s) ? sum + r.amount : sum), 0);

type LeadLike = Pick<Lead, "id" | "source" | "status" | "createdAt" | "orderId" | "operatorId">;
type OrderLike = Pick<Order, "id" | "source" | "status" | "doneAt" | "createdAt"> & Money;

// ── Месяцы по Алматы ─────────────────────────────────────────────────────────

export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** Раньше этого месяца расходы не вносим — защита от опечаток в годе. */
export const FIRST_MONTH = "2020-01";
const DAY_MS = 86400_000;
/** Алматы живёт по UTC+5 круглый год: границы дней и месяцев — по нему, а не по часовому поясу сервера. */
const ALMATY_MS = 5 * 3600_000;
const almatyDay = (t: number): number => Math.floor((t + ALMATY_MS) / DAY_MS);
const MONTH_NAMES = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** Месяц (YYYY-MM) момента t по Алматы. */
export function monthOf(t: number): string {
  const d = new Date(t + ALMATY_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Предыдущий месяц: «2026-01» → «2025-12». */
function prevMonth(month: string): string {
  const m = MONTH_RE.exec(month);
  if (!m) return month;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** «октябрь 2026». */
export function monthLabel(month: string): string {
  const m = MONTH_RE.exec(month);
  return m ? `${MONTH_NAMES[Number(m[2]) - 1]} ${m[1]}` : month;
}

/** Текущий месяц и n − 1 предыдущих, новые первыми — для выбора в редакторе расходов. */
export function recentMonths(now: number, n: number): string[] {
  const out = [monthOf(now)];
  while (out.length < n) out.push(prevMonth(out[out.length - 1]!));
  return out;
}

/** Первый и последний день месяца (номера суток по Алматы) и число дней в нём. */
function monthDays(month: string): { first: number; last: number; days: number } {
  const m = MONTH_RE.exec(month);
  if (!m) return { first: 0, last: -1, days: 0 };
  const first = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) / DAY_MS;
  const next = Date.UTC(Number(m[1]), Number(m[2]), 1) / DAY_MS;
  return { first, last: next - 1, days: next - first };
}

// ── Расходы на рекламу и стоимость привлечения ───────────────────────────────

/** Расход на рекламу по источнику за месяц (YYYY-MM), ₸. */
export interface AdSpendRow {
  month: string;
  source: SourceId;
  amount: number;
}

/**
 * Расходы за период по источникам. Месячная сумма делится поровну на дни месяца, а день периода
 * засчитывается целиком (и сегодняшний тоже): за 7 дней октября — 7/31 октябрьской суммы.
 */
export function spendWithin(rows: readonly AdSpendRow[], s: Span): Partial<Record<SourceId, number>> {
  const first = almatyDay(s.from);
  const last = almatyDay(s.to);
  const out: Partial<Record<SourceId, number>> = {};
  for (const r of rows) {
    const m = monthDays(r.month);
    const overlap = Math.min(last, m.last) - Math.max(first, m.first) + 1;
    if (overlap <= 0 || m.days === 0 || r.amount <= 0) continue;
    out[r.source] = (out[r.source] ?? 0) + (r.amount * overlap) / m.days;
  }
  return out;
}

/** Стоимость заявки (CPL), заказа (CPO) и окупаемость рекламы ROMI = (маржа − расходы) / расходы. null — нет расходов или делить не на что. */
export interface Costs {
  cpl: number | null;
  cpo: number | null;
  romi: number | null;
}

export function costs(spend: number, leads: number, orders: number, marginSum: number): Costs {
  if (spend <= 0) return { cpl: null, cpo: null, romi: null };
  return { cpl: leads > 0 ? spend / leads : null, cpo: orders > 0 ? spend / orders : null, romi: (marginSum - spend) / spend };
}

/** Источник заявок за период: заявки, заказы из них, деньги и стоимость привлечения. */
export interface SourceRow extends Costs {
  source: SourceId;
  /** Заявки периода. */
  leads: number;
  /** Сколько заявок периода стали заказом. */
  orders: number;
  conversion: number;
  /** Заказы источника, выполненные за период (возвраты не считаются), — по ним выручка, маржа и средний чек. */
  done: number;
  revenue: number;
  margin: number;
  avg: number;
  /** Расходы на рекламу за период — доля месячных сумм. */
  spend: number;
}

export function sourceRows(leads: readonly LeadLike[], orders: readonly OrderLike[], spend: Partial<Record<SourceId, number>>, s: Span): SourceRow[] {
  const periodLeads = leads.filter((l) => inSpan(l.createdAt, s));
  const done = doneWithin(orders, s);
  return SOURCE_IDS.map((source): SourceRow => {
    const mine = periodLeads.filter((l) => l.source === source);
    const converted = mine.filter((l) => l.status === "converted").length;
    const money = sums(done.filter((o) => o.source === source));
    const spent = spend[source] ?? 0;
    return {
      source,
      leads: mine.length,
      orders: converted,
      conversion: mine.length ? converted / mine.length : 0,
      done: money.count,
      revenue: money.revenue,
      margin: money.margin,
      avg: money.avg,
      spend: spent,
      ...costs(spent, mine.length, converted, money.margin),
    };
  })
    .filter((x) => x.leads > 0 || x.done > 0 || x.spend > 0)
    .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads);
}

/** Итог по всем источникам — те же формулы на суммах. */
export function sourceTotals(rows: readonly SourceRow[]): Omit<SourceRow, "source" | "avg"> {
  const t = rows.reduce(
    (a, r) => ({ spend: a.spend + r.spend, leads: a.leads + r.leads, orders: a.orders + r.orders, done: a.done + r.done, revenue: a.revenue + r.revenue, margin: a.margin + r.margin }),
    { spend: 0, leads: 0, orders: 0, done: 0, revenue: 0, margin: 0 },
  );
  return { ...t, conversion: t.leads ? t.orders / t.leads : 0, ...costs(t.spend, t.leads, t.orders, t.margin) };
}

// ── Работа операторов ────────────────────────────────────────────────────────

export interface OperatorRow {
  /** Кому засчитаны заявки; нет — заявки, которые пришли сами: бот, сайт, API, AI. */
  userId?: string;
  leads: number;
  /** Сколько из них стали заказом. */
  converted: number;
  conversion: number;
  /** Выручка и маржа выполненных заказов из этих заявок (отмены и возвраты не считаются). */
  revenue: number;
  margin: number;
  /** Медиана времени «заявка → заказ», мс; null — заказов из этих заявок ещё нет. */
  medianMs: number | null;
}

export function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

function operatorRow(userId: string | undefined, leads: readonly LeadLike[], orderById: ReadonlyMap<string, OrderLike>): OperatorRow {
  const pairs = leads.flatMap((l) => {
    const o = l.status === "converted" && l.orderId ? orderById.get(l.orderId) : undefined;
    return o ? [{ l, o }] : [];
  });
  const converted = leads.filter((l) => l.status === "converted").length;
  const money = sums(pairs.map((p) => p.o).filter((o) => isFinished(o)));
  return {
    userId,
    leads: leads.length,
    converted,
    conversion: leads.length ? converted / leads.length : 0,
    revenue: money.revenue,
    margin: money.margin,
    medianMs: median(pairs.map((p) => Math.max(0, Date.parse(p.o.createdAt) - Date.parse(p.l.createdAt)))),
  };
}

/**
 * Работа операторов за период: заявки, конверсия, деньги из этих заявок и как быстро заявка становится заказом.
 * Заявки, которые завела система (бот Telegram, сайт, API, AI), — отдельной строкой: каналы записывают их
 * на владельца, и без этого он выглядел бы самым загруженным оператором.
 */
export function operatorRows(leads: readonly LeadLike[], orders: readonly OrderLike[], auto: ReadonlySet<string>, s: Span): { rows: OperatorRow[]; auto: OperatorRow | null } {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const byUser = new Map<string, LeadLike[]>();
  const system: LeadLike[] = [];
  for (const l of leads) {
    if (!inSpan(l.createdAt, s)) continue;
    if (auto.has(l.id)) system.push(l);
    else byUser.set(l.operatorId, [...(byUser.get(l.operatorId) ?? []), l]);
  }
  const rows = [...byUser].map(([id, list]) => operatorRow(id, list, orderById)).sort((a, b) => b.leads - a.leads || b.converted - a.converted);
  return { rows, auto: system.length ? operatorRow(undefined, system, orderById) : null };
}

/** «35 мин», «4,5 ч», «2,5 дн» — для медианы «заявка → заказ». */
export function durationText(ms: number): string {
  const min = ms / 60_000;
  if (min < 60) return `${Math.max(1, Math.round(min))} мин`;
  const h = min / 60;
  const one = (x: number) => (Math.round(x * 10) / 10).toLocaleString("ru-RU");
  if (h < 48) return `${h < 10 ? one(h) : Math.round(h)} ч`;
  return `${one(h / 24)} дн`;
}

// ── Выплаты исполнителям ─────────────────────────────────────────────────────

type PayoutLike = Pick<Order, "status" | "doneAt" | "payoutPaid"> & Money & { executorId?: string };

export interface PayoutSummary {
  /** Начислено за заказы, выполненные в периоде; из них уже выплачено и ещё нет. */
  period: { accrued: number; paid: number; unpaid: number; orders: number };
  /** Долг исполнителям сейчас — за все выполненные и не выплаченные заказы; по мастерам, больший долг — выше. */
  owed: { total: number; orders: number; executors: { id: string; amount: number; orders: number }[] };
}

/** orders — без повторов: заказы, выполненные в периоде, и все выполненные, но не выплаченные. */
export function payoutSummary(orders: readonly PayoutLike[], s: Span): PayoutSummary {
  const done = doneWithin(orders, s);
  const accrued = done.reduce((x, o) => x + payout(o), 0);
  const paid = done.filter((o) => o.payoutPaid).reduce((x, o) => x + payout(o), 0);
  const unpaid = orders.filter((o) => isFinished(o) && !o.payoutPaid && o.executorId);
  const byExecutor = new Map<string, { amount: number; orders: number }>();
  for (const o of unpaid) {
    const cur = byExecutor.get(o.executorId!) ?? { amount: 0, orders: 0 };
    byExecutor.set(o.executorId!, { amount: cur.amount + payout(o), orders: cur.orders + 1 });
  }
  return {
    period: { accrued, paid, unpaid: accrued - paid, orders: done.length },
    owed: {
      total: unpaid.reduce((x, o) => x + payout(o), 0),
      orders: unpaid.length,
      executors: [...byExecutor].map(([id, x]) => ({ id, ...x })).sort((a, b) => b.amount - a.amount),
    },
  };
}
