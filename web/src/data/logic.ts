// Чистые вычисления поверх DB: финансы, просрочки, статусы для экранов, подбор исполнителей.
import {
  ACTIVE_STATUSES,
  FINISHED_STATUSES,
  LEAD_STATUS,
  ORDER_STATUS,
  WORK_STATUSES,
  serviceById,
  type Tone,
} from "./catalog";
import type { Client, DB, Executor, Lead, Order, User } from "./types";

export const payout = (o: Pick<Order, "payoutMode" | "payoutValue" | "clientPrice">) =>
  o.payoutMode === "fixed" ? o.payoutValue : Math.round((o.clientPrice * o.payoutValue) / 100);
export const margin = (o: Pick<Order, "clientPrice" | "payoutMode" | "payoutValue">) => o.clientPrice - payout(o);
export const marginPct = (o: Order) => (o.clientPrice > 0 ? Math.round((margin(o) / o.clientPrice) * 1000) / 10 : 0);
export const paidAmount = (o: Order) => o.payments.reduce((s, p) => s + p.amount, 0);
export const debt = (o: Order) => (isFinished(o) ? Math.max(0, o.clientPrice - paidAmount(o)) : 0);

export const isActive = (o: Pick<Order, "status">) => ACTIVE_STATUSES.includes(o.status);
export const isInWork = (o: Pick<Order, "status">) => WORK_STATUSES.includes(o.status);
export const isFinished = (o: Pick<Order, "status">) => FINISHED_STATUSES.includes(o.status);
export const isOverdue = (o: Pick<Order, "status" | "deadline">, now = Date.now()) => isActive(o) && new Date(o.deadline).getTime() < now;
/** Срок в ближайшие 3 часа. */
export const isDueSoon = (o: Pick<Order, "status" | "deadline">, now = Date.now()) => {
  const t = new Date(o.deadline).getTime();
  return isActive(o) && t >= now && t - now < 3 * 3600_000;
};

export type PayState = { label: string; tone: Tone };
export const paymentState = (o: Order): PayState => {
  const paid = paidAmount(o);
  if (o.status === "refund") return { label: "Возврат", tone: "red" };
  if (o.status === "cancelled") return { label: "—", tone: "gray" };
  if (paid >= o.clientPrice && o.clientPrice > 0) return { label: "Оплачен", tone: "green" };
  if (paid > 0) return { label: "Частично", tone: "amber" };
  if (isFinished(o)) return { label: "Ожидает оплаты", tone: "amber" };
  return { label: "Не оплачен", tone: "gray" };
};

/** Статус для бейджа заказа: просрочка важнее остального. */
export const orderBadge = (o: Order, now = Date.now()): { label: string; tone: Tone } =>
  isOverdue(o, now) ? { label: "Просрочка", tone: "red" } : ORDER_STATUS[o.status];

/** Заявку после конвертации показываем по прогрессу её заказа — оператору так понятнее. */
export const leadBadge = (l: Lead, order: Order | undefined, now = Date.now()): { label: string; tone: Tone } => {
  if (l.status !== "converted" || !order) return LEAD_STATUS[l.status];
  if (order.status === "cancelled") return { label: "Отменена", tone: "gray" };
  if (isOverdue(order, now)) return { label: "Просрочка", tone: "red" };
  if (isFinished(order) || order.status === "refund") return { label: "Завершена", tone: "green" };
  return { label: "В работе", tone: "amber" };
};

export type LeadBucket = "new" | "qualifying" | "waiting" | "work" | "done" | "rejected";
export const leadBucket = (l: Lead, order: Order | undefined): LeadBucket => {
  if (l.status === "converted") return order && (isFinished(order) || order.status === "cancelled" || order.status === "refund") ? "done" : "work";
  if (l.status === "rejected") return "rejected";
  return l.status;
};

export type ExecState = "free" | "busy" | "onsite" | "off";
export const EXEC_STATE: Record<ExecState, { label: string; tone: Tone }> = {
  free: { label: "Свободен", tone: "green" },
  busy: { label: "На заказе", tone: "blue" },
  onsite: { label: "На выезде", tone: "orange" },
  off: { label: "Выходной", tone: "violet" },
};

/** Занятость считается сама по заказам: вручную исполнитель отмечает только выходной. */
/** Для занятости хватает «чей заказ и в каком статусе» — сервер отдаёт только это. */
export type Load = Pick<Order, "executorId" | "status">;

export const executorState = (e: Executor, orders: Load[]): ExecState => {
  if (!e.available) return "off";
  const mine = orders.filter((o) => o.executorId === e.id && isInWork(o));
  if (mine.some((o) => o.status === "in_progress")) return "onsite";
  if (mine.length) return "busy";
  return "free";
};

export const executorStats = (e: Executor, orders: Order[], now = Date.now()) => {
  const mine = orders.filter((o) => o.executorId === e.id);
  const done = mine.filter((o) => isFinished(o));
  const monthAgo = now - 30 * 86400_000;
  return {
    active: mine.filter(isInWork).length,
    done: done.length,
    cancelled: mine.filter((o) => o.status === "cancelled").length,
    overdue: mine.filter((o) => isOverdue(o, now)).length,
    lateDone: done.filter((o) => o.doneAt && o.doneAt > o.deadline).length,
    income: done.reduce((s, o) => s + payout(o), 0),
    incomeMonth: done.filter((o) => o.doneAt && new Date(o.doneAt).getTime() > monthAgo).reduce((s, o) => s + payout(o), 0),
    toPay: done.filter((o) => !o.payoutPaid).reduce((s, o) => s + payout(o), 0),
    revenue: done.reduce((s, o) => s + o.clientPrice, 0),
    margin: done.reduce((s, o) => s + margin(o), 0),
  };
};

/** Лента исполнителя: только его специализации и город (ТЗ п.11). */
export const feedFor = (e: Executor, orders: Order[]) =>
  orders.filter((o) => o.status === "awaiting_executor" && !o.executorId && o.city === e.city && e.categories.includes(serviceById(o.serviceId).category));

/** Кандидаты для ручного назначения: сначала подходящие и свободные, потом по загрузке и рейтингу. */
export const rankExecutors = (o: Pick<Order, "serviceId" | "city">, executors: Executor[], orders: Load[]) => {
  const cat = serviceById(o.serviceId).category;
  return executors
    .map((e) => {
      const state = executorState(e, orders);
      const load = orders.filter((x) => x.executorId === e.id && isInWork(x)).length;
      const fits = e.categories.includes(cat) && e.city === o.city;
      const score = (fits ? 100 : 0) + (state === "off" ? -60 : 0) + (state === "free" ? 20 : 0) - load * 6 + e.rating * 4;
      return { e, state, load, fits, score };
    })
    .sort((a, b) => b.score - a.score);
};

export type ClientState = { label: string; tone: Tone };
/** Статус клиента по счётчикам, которые сервер держит на карточке клиента. */
export const clientState = (c: Client, now = Date.now()): ClientState => {
  if ((c.activeCount ?? 0) > 0) return { label: "В работе", tone: "amber" };
  if (!c.ordersCount) return now - new Date(c.createdAt).getTime() < 30 * 86400_000 ? { label: "Новый", tone: "blue" } : { label: "Потенциальный", tone: "red" };
  return c.lastOrderAt && now - new Date(c.lastOrderAt).getTime() < 120 * 86400_000 ? { label: "Активный", tone: "green" } : { label: "Неактивен", tone: "gray" };
};

/** Что видит пользователь: исполнитель — только свои заказы и ленту, сотрудники — всё. */
export const canSeeFinance = (u: User) => u.role === "owner" || u.role === "operator";
export const canSeeAnalytics = (u: User) => u.role === "owner";

export const userName = (db: DB, id: string) => db.users.find((u) => u.id === id)?.name ?? "Система";
