// Предрасчёт аналитики (ТЗ §26.6, §17, §23.4): итоги по дням Алматы × направление × источник × город, внутри — разбивка
// по мастерам и операторам. Здесь — чистые правила: какие факты даёт заказ и заявка, как они складываются и как из итогов
// получаются строки «Аналитики» и «Главной». Сервер (convex/stats.ts) хранит факты и итоги, экраны читают итоги за период —
// O(дней), а не O(заказов). Формулы денег — из ./logic и ./analytics: здесь они не повторяются.
import { SOURCE_IDS } from "./catalog";
import { byOperatorLoad, leadWaitMs, operatorRowOf, sourceRow, sumsOf, visibleSources, type OperatorRow, type SourceRow } from "./analytics";
import { isFinished, payout, platformFeeOf, revenueOf, type RevenueLike } from "./logic";
import type { Lead, Order, OrderStatus, SourceId } from "./types";

// ── Дни по Алматы ────────────────────────────────────────────────────────────

const DAY_MS = 86400_000;
/** Алматы живёт по UTC+5 круглый год: день отчёта — по нему, а не по часовому поясу сервера или браузера. */
const ALMATY_MS = 5 * 3600_000;
export const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** Дольше года период не берём: 12 месяцев сравнения — отдельный запрос по месячным итогам. */
export const MAX_PERIOD_DAYS = 366;
/** До стольких дней ряд «Динамики» — по дням и читается из дневных итогов; длиннее — по месяцам. */
export const DAILY_SERIES_MAX = 92;

/** «2026-10-14» — день по Алматы для ISO-момента. Мусор — пустая строка. */
export function dayOf(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? "" : new Date(t + ALMATY_MS).toISOString().slice(0, 10);
}
/** Сегодня по Алматы. */
export const todayDay = (now = Date.now()): string => new Date(now + ALMATY_MS).toISOString().slice(0, 10);
/** Начало дня по Алматы, мс UTC. */
export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`) - ALMATY_MS;
/** Последняя миллисекунда дня по Алматы. */
export const dayEnd = (day: string): number => dayStart(day) + DAY_MS - 1;
/** День ± n суток. */
export const shiftDay = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** Сколько дней от from до to включительно. */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
export const monthOfDay = (day: string): string => day.slice(0, 7);
/** Первый и последний день месяца YYYY-MM. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return { first: `${month}-01`, last: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
}
/** Месяц ± n. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

// ── Счётчики ─────────────────────────────────────────────────────────────────

/**
 * Итоги ячейки. Заявки — по дню заявки (воронка — по тем же заявкам, с текущим статусом их заказов); created — заказы
 * по дню создания; done…accruedPaid — выполненные по дню выполнения (возврат — не выполненный, как в doneWithin);
 * received/refunded — по датам оплат и возвратов; paidOut — выплачено мастерам по дате выплаты; cancelled — по дню отмены.
 */
export const TOTAL_KEYS = [
  "leads",
  "qualified",
  "converted",
  "withOrder",
  "orderDone",
  "orderPaid",
  "created",
  "done",
  "revenue",
  "payouts",
  "late",
  "accruedPaid",
  "repeatDone",
  "repeatRevenue",
  "cancelled",
  "received",
  "refunded",
  "paidOut",
  "fee",
] as const;
export type TotalKey = (typeof TOTAL_KEYS)[number];
/** По мастеру: выполнено, деньги, опоздания, отмены, отказы, время до взятия и на работу (сумма мс и сколько замеров). */
export const EX_KEYS = ["done", "revenue", "payouts", "fee", "late", "accruedPaid", "paidOut", "cancelled", "refusals", "takeMs", "takeN", "workMs", "workN"] as const;
export type ExKey = (typeof EX_KEYS)[number];
/** По оператору: его заявки, сколько стали заказом и деньги выполненных заказов из них. */
export const OP_KEYS = ["leads", "converted", "revenue", "payouts", "fee"] as const;
export type OpKey = (typeof OP_KEYS)[number];

export type Counts<K extends string> = Partial<Record<K, number>>;
/** Деньги — руководителю направления и оператору их не отдаём (сервер вырезает ключи целиком). */
export const MONEY_KEYS: ReadonlySet<string> = new Set(["revenue", "payouts", "accruedPaid", "repeatRevenue", "received", "refunded", "paidOut"]);

export interface ExCell {
  id: string;
  c: Counts<ExKey>;
}
export interface OpCell {
  /** Сотрудник; пусто — заявки, которые пришли сами и которых никто не взял (как operatorRows). */
  id: string;
  c: Counts<OpKey>;
  /** «Заявка → заказ», мс — для медианы (её нельзя сложить, поэтому храним сами замеры, по возрастанию). */
  waits: number[];
}
export interface Dims {
  category: string;
  source: SourceId;
  city: string;
}
export interface Cell extends Dims {
  t: Counts<TotalKey>;
  ex: ExCell[];
  op: OpCell[];
}

export const n = <K extends string>(c: Counts<K>, k: K): number => c[k] ?? 0;
function bump<K extends string>(c: Counts<K>, k: K, by = 1): void {
  if (by) c[k] = (c[k] ?? 0) + by;
}
function addCounts<K extends string>(into: Counts<K>, from: Counts<K>): void {
  for (const k of Object.keys(from) as K[]) bump(into, k, from[k] ?? 0);
}
/** Ключ разреза: направление, источник, город. */
export const dimsKey = (d: Dims): string => `${d.category}\u0001${d.source}\u0001${d.city}`;

function exOf(cell: Cell, id: string): ExCell {
  let e = cell.ex.find((x) => x.id === id);
  if (!e) cell.ex.push((e = { id, c: {} }));
  return e;
}
function opOf(cell: Cell, id: string): OpCell {
  let o = cell.op.find((x) => x.id === id);
  if (!o) cell.op.push((o = { id, c: {}, waits: [] }));
  return o;
}

/** Ячейки фактов одной сущности по дням. */
class Days {
  readonly cells = new Map<string, Cell>();
  constructor(private readonly dims: Dims) {}
  /** Ячейка дня момента iso; нет даты — null (факт без даты не учитываем). */
  at(iso: string | undefined): Cell | null {
    const day = iso ? dayOf(iso) : "";
    if (!day) return null;
    let c = this.cells.get(day);
    if (!c) this.cells.set(day, (c = { ...this.dims, t: {}, ex: [], op: [] }));
    return c;
  }
}

// ── Факты заказа ─────────────────────────────────────────────────────────────

export type FactOrder = Pick<
  Order,
  "status" | "category" | "source" | "city" | "createdAt" | "doneAt" | "deadline" | "clientPrice" | "payoutMode" | "payoutValue" | "payments" | "refunds" | "payoutPaid" | "payoutPaidAt" | "executorId" | "assignedAt" | "platformFee"
>;

/** Смена статуса из истории заказа. byExecutor — мастер, который сам сделал этот шаг (отказ). */
export interface OrderEvent {
  at: string;
  from?: OrderStatus;
  to?: OrderStatus;
  byExecutor?: string;
}

export interface OrderContext {
  events?: readonly OrderEvent[];
  /** У клиента уже был заказ раньше этого — заказ повторного клиента. */
  repeat?: boolean;
}

/** Отказ мастера — шаг из «Назначен»/«Принят» обратно в ленту, сделанный самим мастером. */
const REFUSED_FROM: readonly OrderStatus[] = ["assigned", "accepted"];

const lastMove = (events: readonly OrderEvent[], to: OrderStatus, notAfter?: string): OrderEvent | undefined =>
  events.filter((e) => e.to === to && (!notAfter || e.at <= notAfter)).sort((a, b) => a.at.localeCompare(b.at)).pop();

/**
 * Время до взятия (ТЗ 17.10): от последней публикации в ленту до назначения мастера. Заказ, назначенный мимо ленты, —
 * без замера.
 */
export function takeMsOf(o: Pick<Order, "assignedAt">, events: readonly OrderEvent[]): number | null {
  if (!o.assignedAt) return null;
  const pub = lastMove(events, "awaiting_executor", o.assignedAt);
  if (!pub) return null;
  return Math.max(0, Date.parse(o.assignedAt) - Date.parse(pub.at));
}

/** Факты заказа по дням: создан, выполнен (с деньгами), оплаты и возвраты, выплата мастеру, отмена и отказы мастеров. */
export function orderFacts(o: FactOrder, x: OrderContext = {}): Map<string, Cell> {
  const days = new Days({ category: o.category, source: o.source, city: o.city });
  const events = x.events ?? [];
  const created = days.at(o.createdAt);
  if (created) bump(created.t, "created");

  const done = isFinished(o) ? days.at(o.doneAt) : null;
  if (done && o.doneAt) {
    const revenue = revenueOf(o);
    const pay = payout(o);
    const fee = platformFeeOf(o);
    const late = o.doneAt > o.deadline ? 1 : 0;
    const paid = o.payoutPaid ? pay : 0;
    bump(done.t, "done");
    bump(done.t, "revenue", revenue);
    bump(done.t, "payouts", pay);
    if (fee) bump(done.t, "fee", fee);
    bump(done.t, "late", late);
    bump(done.t, "accruedPaid", paid);
    if (x.repeat) {
      bump(done.t, "repeatDone");
      bump(done.t, "repeatRevenue", revenue);
    }
    if (o.executorId) {
      const e = exOf(done, o.executorId).c;
      bump(e, "done");
      bump(e, "revenue", revenue);
      bump(e, "payouts", pay);
      if (fee) bump(e, "fee", fee);
      bump(e, "late", late);
      bump(e, "accruedPaid", paid);
      const take = takeMsOf(o, events);
      if (take !== null) {
        bump(e, "takeMs", take);
        bump(e, "takeN");
      }
      const work = o.assignedAt ? Date.parse(o.doneAt) - Date.parse(o.assignedAt) : NaN;
      if (work >= 0) {
        bump(e, "workMs", work);
        bump(e, "workN");
      }
    }
  }

  for (const p of o.payments) if (!p.voidedAt) bump(days.at(p.at)?.t ?? {}, "received", p.amount);
  for (const r of o.refunds ?? []) bump(days.at(r.at)?.t ?? {}, "refunded", r.amount);

  // Выплата мастеру — по дате выплаты из реестра: сумма заказа в выплате после неё уже не меняется (orders.updateFinance).
  const paidOut = o.payoutPaid ? days.at(o.payoutPaidAt) : null;
  if (paidOut) {
    bump(paidOut.t, "paidOut", payout(o));
    if (o.executorId) bump(exOf(paidOut, o.executorId).c, "paidOut", payout(o));
  }

  if (o.status === "cancelled") {
    const c = days.at(lastMove(events, "cancelled")?.at ?? o.createdAt);
    if (c) {
      bump(c.t, "cancelled");
      if (o.executorId) bump(exOf(c, o.executorId).c, "cancelled");
    }
  }

  for (const ev of events) {
    if (!ev.byExecutor || ev.to !== "awaiting_executor" || !ev.from || !REFUSED_FROM.includes(ev.from)) continue;
    const c = days.at(ev.at);
    if (c) bump(exOf(c, ev.byExecutor).c, "refusals");
  }
  normalize(days.cells.values());
  return days.cells;
}

// ── Факты заявки ─────────────────────────────────────────────────────────────

/** operatorId — пусто у заявок, которые пришли сами и которых ещё никто не взял. */
export type FactLead = Pick<Lead, "status" | "source" | "city" | "createdAt" | "orderId"> & { operatorId?: string };
export type LeadOrder = Pick<Order, "status" | "createdAt" | "payoutMode" | "payoutValue" | "platformFee"> & RevenueLike;

export interface LeadContext {
  /** Направление услуги заявки (по справочнику). */
  category: string;
  /** Заказ, в который превратилась заявка. */
  order?: LeadOrder | null;
  /** Заявка пришла сама и её не засчитываем оператору (analytics.autoLeadIds). */
  auto?: boolean;
}

/** Заказ заявки дошёл до оплаты: «Оплачен» или уже «Закрыт». */
export const isPaidOrder = (o: Pick<Order, "status">): boolean => o.status === "paid" || o.status === "closed";

/** Факты заявки — все в день заявки: воронка, источник и работа оператора (как funnel, sourceRows, operatorRows). */
export function leadFacts(l: FactLead, x: LeadContext): Map<string, Cell> {
  const days = new Days({ category: x.category, source: l.source, city: l.city });
  const c = days.at(l.createdAt);
  if (!c) return days.cells;
  const order = l.orderId ? x.order : null;
  const converted = l.status === "converted";
  bump(c.t, "leads");
  if (l.status !== "new") bump(c.t, "qualified");
  if (converted) bump(c.t, "converted");
  if (l.orderId) bump(c.t, "withOrder");
  if (order && isFinished(order)) bump(c.t, "orderDone");
  if (order && isPaidOrder(order)) bump(c.t, "orderPaid");

  const op = opOf(c, x.auto || !l.operatorId ? "" : l.operatorId);
  bump(op.c, "leads");
  if (converted) bump(op.c, "converted");
  if (converted && order) {
    op.waits.push(leadWaitMs(l.createdAt, order.createdAt));
    if (isFinished(order)) {
      bump(op.c, "revenue", revenueOf(order));
      bump(op.c, "payouts", payout(order));
      if (platformFeeOf(order)) bump(op.c, "fee", platformFeeOf(order));
    }
  }
  normalize(days.cells.values());
  return days.cells;
}

// ── Сложение ─────────────────────────────────────────────────────────────────

/** Порядок внутри ячейки — по id, замеры — по возрастанию: одинаковые факты всегда записываются одинаково. */
function normalize(cells: Iterable<Cell>): void {
  for (const c of cells) {
    c.ex.sort((a, b) => a.id.localeCompare(b.id));
    c.op.sort((a, b) => a.id.localeCompare(b.id));
    for (const o of c.op) o.waits.sort((a, b) => a - b);
  }
}

/** Сложить ячейки с одинаковыми направлением, источником и городом (день из фактов, месяц из дней). */
export function mergeCells(cells: Iterable<Cell>): Cell[] {
  const by = new Map<string, Cell>();
  for (const c of cells) {
    const k = dimsKey(c);
    let into = by.get(k);
    if (!into) by.set(k, (into = { category: c.category, source: c.source, city: c.city, t: {}, ex: [], op: [] }));
    addCounts(into.t, c.t);
    for (const e of c.ex) addCounts(exOf(into, e.id).c, e.c);
    for (const o of c.op) {
      const to = opOf(into, o.id);
      addCounts(to.c, o.c);
      to.waits.push(...o.waits);
    }
  }
  const out = [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, c]) => c);
  normalize(out);
  return out;
}

/** Одинаковы ли две ячейки — чтобы не переписывать неизменившиеся строки. */
export function sameCell(a: Cell, b: Cell): boolean {
  return canon(pickCell(a)) === canon(pickCell(b));
}
const pickCell = (c: Cell): Cell => ({ category: c.category, source: c.source, city: c.city, t: c.t, ex: c.ex, op: c.op });
function canon(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canon).join(",")}]`;
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined && o[k] !== 0)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

// ── Фильтры и итог периода ───────────────────────────────────────────────────

export interface StatsFilter {
  category?: string;
  source?: SourceId;
  city?: string;
  /** Направления руководителя; null — все. */
  scope?: readonly string[] | null;
}

export const matchesFilter = (d: Dims, f: StatsFilter): boolean =>
  (!f.scope || f.scope.includes(d.category)) && (!f.category || d.category === f.category) && (!f.source || d.source === f.source) && (!f.city || d.city === f.city);

/** Итог периода: всё вместе, по источникам, по направлениям, по мастерам и операторам. */
export interface StatsSummary {
  t: Counts<TotalKey>;
  sources: { source: SourceId; t: Counts<TotalKey> }[];
  categories: { category: string; t: Counts<TotalKey> }[];
  executors: ExCell[];
  operators: OpCell[];
}

export function summarize(cells: readonly Cell[], opts: { operators?: boolean } = {}): StatsSummary {
  const total: Counts<TotalKey> = {};
  const sources = new Map<SourceId, Counts<TotalKey>>();
  const categories = new Map<string, Counts<TotalKey>>();
  const all: Cell = { category: "", source: "olx", city: "", t: total, ex: [], op: [] };
  for (const c of cells) {
    addCounts(total, c.t);
    addCounts(sources.get(c.source) ?? sources.set(c.source, {}).get(c.source)!, c.t);
    addCounts(categories.get(c.category) ?? categories.set(c.category, {}).get(c.category)!, c.t);
    for (const e of c.ex) addCounts(exOf(all, e.id).c, e.c);
    if (opts.operators) {
      for (const o of c.op) {
        const to = opOf(all, o.id);
        addCounts(to.c, o.c);
        to.waits.push(...o.waits);
      }
    }
  }
  normalize([all]);
  return {
    t: total,
    sources: SOURCE_IDS.filter((s) => sources.has(s)).map((source) => ({ source, t: sources.get(source)! })),
    categories: [...categories].sort(([a], [b]) => a.localeCompare(b)).map(([category, t]) => ({ category, t })),
    executors: all.ex,
    operators: all.op,
  };
}

/** Без денег: ключи сумм вырезаны целиком (руководитель направления, оператор). */
export function withoutMoney<K extends string>(c: Counts<K>): Counts<K> {
  return Object.fromEntries(Object.entries(c).filter(([k]) => !MONEY_KEYS.has(k))) as Counts<K>;
}
export function summaryWithoutMoney(s: StatsSummary): StatsSummary {
  return {
    t: withoutMoney(s.t),
    sources: s.sources.map((x) => ({ ...x, t: withoutMoney(x.t) })),
    categories: s.categories.map((x) => ({ ...x, t: withoutMoney(x.t) })),
    executors: s.executors.map((e) => ({ id: e.id, c: withoutMoney(e.c) })),
    operators: [],
  };
}

// ── Строки экранов из итогов ─────────────────────────────────────────────────

/** Шаги воронки по заявкам периода — одна разметка для сырых данных (./metrics) и итогов. */
export function funnelOf(c: { leads: number; qualified: number; withOrder: number; orderDone: number; orderPaid: number }) {
  return [
    { label: "Заявки", value: c.leads },
    { label: "Квалифицированы", value: c.qualified },
    { label: "Заказы", value: c.withOrder },
    { label: "Выполнены", value: c.orderDone },
    { label: "Оплачены", value: c.orderPaid },
  ];
}
export const funnelOfTotals = (t: Counts<TotalKey>) =>
  funnelOf({ leads: n(t, "leads"), qualified: n(t, "qualified"), withOrder: n(t, "withOrder"), orderDone: n(t, "orderDone"), orderPaid: n(t, "orderPaid") });

/** Деньги выполненных заказов: выручка, начислено мастерам, маржа, число и средний чек — как sums(doneWithin(...)). */
export const moneyOf = (t: Counts<TotalKey>) => sumsOf(n(t, "revenue"), n(t, "payouts"), n(t, "done"), n(t, "fee"));

/** «Получено от клиентов» за период — как receivedWithin. */
export const cashOf = (t: Counts<TotalKey>) => ({ received: n(t, "received"), refunded: n(t, "refunded"), net: n(t, "received") - n(t, "refunded") });

/** Источники за период — как sourceRows; spend — расходы на рекламу за период. */
export function sourceRowsOf(s: StatsSummary, spend: Partial<Record<SourceId, number>> = {}): SourceRow[] {
  const by = new Map(s.sources.map((x) => [x.source, x.t]));
  return visibleSources(
    SOURCE_IDS.map((source) => {
      const t = by.get(source) ?? {};
      return sourceRow(source, { leads: n(t, "leads"), converted: n(t, "converted"), done: n(t, "done"), revenue: n(t, "revenue"), payouts: n(t, "payouts"), fee: n(t, "fee") }, spend[source] ?? 0);
    }),
  );
}

/** Операторы за период — как operatorRows. */
export function operatorRowsOf(s: StatsSummary): { rows: OperatorRow[]; auto: OperatorRow | null } {
  const row = (o: OpCell) => operatorRowOf(o.id || undefined, { leads: n(o.c, "leads"), converted: n(o.c, "converted"), revenue: n(o.c, "revenue"), payouts: n(o.c, "payouts"), fee: n(o.c, "fee"), waits: o.waits });
  const auto = s.operators.find((o) => !o.id);
  return { rows: s.operators.filter((o) => o.id && n(o.c, "leads") > 0).map(row).sort(byOperatorLoad), auto: auto && n(auto.c, "leads") > 0 ? row(auto) : null };
}

/** Мастер в таблице исполнителей (ТЗ 17.10). Деньги — только когда они пришли с сервера (владелец). */
export interface ExecutorRow {
  id: string;
  name: string;
  rating: number;
  reviews: number;
  done: number;
  late: number;
  /** Доля сданных вовремя; null — сданных нет. */
  onTime: number | null;
  cancelled: number;
  refusals: number;
  /** Среднее время от публикации до взятия и от назначения до сдачи, мс; null — замеров нет. */
  avgTakeMs: number | null;
  avgWorkMs: number | null;
  revenue?: number;
  margin?: number;
  accrued?: number;
  paidOut?: number;
}

export interface ExecutorMeta {
  id: string;
  name: string;
  rating: number;
  reviews: number;
}

export function executorRowsOf(s: StatsSummary, meta: readonly ExecutorMeta[], money: boolean): ExecutorRow[] {
  const by = new Map(s.executors.map((e) => [e.id, e.c]));
  const known = new Map(meta.map((m) => [m.id, m]));
  // Все мастера области — и те, у кого за период ничего не было; плюс удалённые, если за ними есть цифры.
  const ids = [...new Set([...meta.map((m) => m.id), ...s.executors.map((e) => e.id)])];
  return ids.map((id): ExecutorRow => {
    const c = by.get(id) ?? {};
    const m = known.get(id) ?? { id, name: "Исполнитель удалён", rating: 0, reviews: 0 };
    const done = n(c, "done");
    const row: ExecutorRow = {
      ...m,
      done,
      late: n(c, "late"),
      onTime: done ? (done - n(c, "late")) / done : null,
      cancelled: n(c, "cancelled"),
      refusals: n(c, "refusals"),
      avgTakeMs: n(c, "takeN") ? n(c, "takeMs") / n(c, "takeN") : null,
      avgWorkMs: n(c, "workN") ? n(c, "workMs") / n(c, "workN") : null,
    };
    if (!money) return row;
    const sums = sumsOf(n(c, "revenue"), n(c, "payouts"), done, n(c, "fee"));
    return { ...row, revenue: sums.revenue, margin: sums.margin, accrued: sums.payouts, paidOut: n(c, "paidOut") };
  });
}

/** Повторные клиенты: доля выполненных заказов от клиентов, у которых уже был заказ, и их выручка. */
export function repeatOf(t: Counts<TotalKey>): { orders: number; share: number; revenue: number; revenueShare: number } {
  const done = n(t, "done");
  const revenue = n(t, "revenue");
  return {
    orders: n(t, "repeatDone"),
    share: done ? n(t, "repeatDone") / done : 0,
    revenue: n(t, "repeatRevenue"),
    revenueShare: revenue > 0 ? n(t, "repeatRevenue") / revenue : 0,
  };
}

// ── Ответ сервера ────────────────────────────────────────────────────────────

/** Точка «Динамики»: день (YYYY-MM-DD) или месяц (YYYY-MM). */
export interface SeriesPoint {
  period: string;
  t: Counts<TotalKey>;
}

export interface StatsFreshness {
  /** Когда показатели впервые собраны целиком; null — ещё ни разу (идёт первый пересчёт). */
  builtAt: string | null;
  rebuilding: boolean;
  /** Изменений в очереди на пересчёт (до 1000). */
  pending: number;
}

/** «Аналитика» за период: итог, прошлый период той же длины, ряд по дням или месяцам. Деньги — только владельцу. */
export interface StatsReport {
  money: boolean;
  from: string;
  to: string;
  days: number;
  prevFrom: string;
  prevTo: string;
  grain: "day" | "month";
  cur: StatsSummary;
  prev: Counts<TotalKey>;
  series: SeriesPoint[];
  executors: ExecutorMeta[];
  /** Расходы на рекламу за период по источникам (владельцу). */
  spend: Partial<Record<SourceId, number>>;
}

/** Месяц для сравнения «по месяцам». */
export interface MonthPoint {
  month: string;
  t: Counts<TotalKey>;
}
