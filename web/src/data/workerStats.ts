// Деньги и показатели мастера: заработок за месяц, «к выплате», разбивка по неделям, счётчики профиля.
// Одни формулы для экранов «Доход», «Мои заказы», «Профиль» и для сервера (convex/executorApp.ts).
import type { OrderStatus } from "./types";
import { DAY_MS, monthKeyAlmaty, weekStartAlmaty, type Moment } from "./workerTime";

/** Поля заказа, которых хватает для подсчёта денег мастера: подходит и WorkerOrder, и документ базы с посчитанной выплатой. */
export interface EarningOrder {
  status: OrderStatus;
  payout: number;
  payoutPaid: boolean;
  deadline: string;
  createdAt: string;
  assignedAt?: string;
  doneAt?: string;
}

/** Работа сдана — деньги заработаны: «Выполнен», «Ожидает оплаты», «Оплачен», «Закрыт». */
export const EARNING_STATUSES: readonly OrderStatus[] = ["done", "awaiting_payment", "paid", "closed"];
/** Заказ в работе у мастера. */
export const ACTIVE_WORK_STATUSES: readonly OrderStatus[] = ["assigned", "accepted", "in_progress", "awaiting_client"];
/** Заказ завершён без денег мастеру. */
export const VOID_STATUSES: readonly OrderStatus[] = ["cancelled", "refund"];

export const isEarning = (o: Pick<EarningOrder, "status">) => EARNING_STATUSES.includes(o.status);
export const isActiveWork = (o: Pick<EarningOrder, "status">) => ACTIVE_WORK_STATUSES.includes(o.status);
export const isVoid = (o: Pick<EarningOrder, "status">) => VOID_STATUSES.includes(o.status);
/** Закрытые заказы для вкладки «Завершённые»: сданные, отменённые и возвраты. */
export const isClosedForWorker = (o: Pick<EarningOrder, "status">) => isEarning(o) || isVoid(o);

/** К какой дате относим заказ в деньгах: сдача работы, иначе назначение, иначе создание. */
export const earnedAt = (o: Pick<EarningOrder, "doneAt" | "assignedAt" | "createdAt">): string => o.doneAt ?? o.assignedAt ?? o.createdAt;

export interface MonthIncome {
  /** «2026-10». */
  month: string;
  /** Σ выплат за сданные в этом месяце заказы. */
  earned: number;
  /** Сколько заказов сдано в этом месяце. */
  count: number;
}

/** «Заработано в октябре»: сданные заказы с датой сдачи в этом месяце по Алматы; отмены и возвраты не считаем. */
export function monthIncome(orders: readonly EarningOrder[], month: string): MonthIncome {
  let earned = 0;
  let count = 0;
  for (const o of orders) {
    if (!isEarning(o) || monthKeyAlmaty(earnedAt(o)) !== month) continue;
    earned += o.payout;
    count += 1;
  }
  return { month, earned, count };
}

export interface PayoutBalance {
  /** Клиент оплатил («Оплачен», «Закрыт»), выплаты мастеру ещё не было — компания должна мастеру. */
  toPay: number;
  toPayCount: number;
  /** Работа сдана («Выполнен», «Ожидает оплаты»), клиент ещё не оплатил. */
  awaitingClient: number;
  awaitingClientCount: number;
}

/** Остатки по всем заказам мастера, без привязки к месяцу. */
export function payoutBalance(orders: readonly EarningOrder[]): PayoutBalance {
  const out: PayoutBalance = { toPay: 0, toPayCount: 0, awaitingClient: 0, awaitingClientCount: 0 };
  for (const o of orders) {
    if (o.payoutPaid) continue;
    if (o.status === "paid" || o.status === "closed") {
      out.toPay += o.payout;
      out.toPayCount += 1;
    } else if (o.status === "done" || o.status === "awaiting_payment") {
      out.awaitingClient += o.payout;
      out.awaitingClientCount += 1;
    }
  }
  return out;
}

export interface WeekIncome {
  /** Понедельник 00:00 по Алматы, UTC-мс. */
  start: number;
  total: number;
  count: number;
}

/** Заработок по неделям (пн–вс по Алматы): `weeks` последних недель, старые слева, последняя — текущая. */
export function weeklyIncome(orders: readonly EarningOrder[], now: Moment, weeks = 6): WeekIncome[] {
  const current = weekStartAlmaty(now);
  const out: WeekIncome[] = Array.from({ length: weeks }, (_, i) => ({ start: current - (weeks - 1 - i) * 7 * DAY_MS, total: 0, count: 0 }));
  const byStart = new Map(out.map((w) => [w.start, w]));
  for (const o of orders) {
    if (!isEarning(o)) continue;
    const w = byStart.get(weekStartAlmaty(earnedAt(o)));
    if (!w) continue;
    w.total += o.payout;
    w.count += 1;
  }
  return out;
}

export interface MonthGroup<T> {
  month: string;
  /** Σ выплат месяца без отменённых и возвратов. */
  total: number;
  orders: T[];
}

/** Закрытые заказы по месяцам (новые сверху), внутри месяца — новые сверху. */
export function groupByMonth<T extends EarningOrder>(orders: readonly T[]): MonthGroup<T>[] {
  const sorted = [...orders].sort((a, b) => earnedAt(b).localeCompare(earnedAt(a)));
  const groups: MonthGroup<T>[] = [];
  for (const o of sorted) {
    const month = monthKeyAlmaty(earnedAt(o));
    let g = groups.at(-1);
    if (!g || g.month !== month) {
      g = { month, total: 0, orders: [] };
      groups.push(g);
    }
    g.orders.push(o);
    if (isEarning(o)) g.total += o.payout;
  }
  return groups;
}

export interface ExecutorStats {
  /** Текущий месяц по Алматы, «2026-10». */
  month: string;
  monthEarned: number;
  monthDone: number;
  toPay: number;
  awaitingClient: number;
  /** Всего сдано заказов. */
  completed: number;
  /** Отменено заказов, которые были у мастера. */
  cancelled: number;
  /** Сейчас в работе. */
  active: number;
  /** В работе и срок прошёл. */
  overdue: number;
}

/** Сводка для профиля мастера (ТЗ п.14: выполненные, отменённые, просроченные, доход). */
export function executorStats(orders: readonly EarningOrder[], now: Moment): ExecutorStats {
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const month = monthKeyAlmaty(nowMs);
  const income = monthIncome(orders, month);
  const balance = payoutBalance(orders);
  let completed = 0;
  let cancelled = 0;
  let active = 0;
  let overdue = 0;
  for (const o of orders) {
    if (isEarning(o)) completed += 1;
    if (o.status === "cancelled") cancelled += 1;
    if (isActiveWork(o)) {
      active += 1;
      if (Date.parse(o.deadline) < nowMs) overdue += 1;
    }
  }
  return { month, monthEarned: income.earned, monthDone: income.count, toPay: balance.toPay, awaitingClient: balance.awaitingClient, completed, cancelled, active, overdue };
}
