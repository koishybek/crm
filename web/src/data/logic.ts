// Чистые вычисления поверх DB: финансы, просрочки, статусы для экранов, подбор исполнителей.
import {
  ACTIVE_STATUSES,
  FINISHED_STATUSES,
  LEAD_STATUS,
  ORDER_STATUS,
  WORK_STATUSES,
  type Tone,
} from "./catalog";
import { cityKey, districtKey } from "./cities";
import { can } from "./permissions";
import { textKey } from "./skills";
import { dateAlmaty, timeAlmaty } from "./workerTime";
import type { Client, DB, Executor, ExecutorRates, ExecutorStats90, Lead, Order, OrderStatus, PayoutTerms, User } from "./types";

export const payout = (o: Pick<Order, "payoutMode" | "payoutValue" | "clientPrice">) =>
  o.payoutMode === "fixed" ? o.payoutValue : Math.round((o.clientPrice * o.payoutValue) / 100);

// ── Ставка исполнителя (ТЗ п.13, п.14.5) ────────────────────────────────────

/** Что нужно знать о заказе, чтобы посчитать выплату конкретному мастеру. */
export type RateOrder = PayoutTerms & Pick<Order, "serviceId" | "clientPrice"> & Partial<Pick<Order, "payoutBase" | "payoutManual">>;

/**
 * Условия выплаты мастеру по заказу — единственное правило ставок. База — условия самого заказа (ставка услуги или
 * условия до того, как к заказу применили ставку прежнего мастера). Ручная правка выплаты в заказе (payoutManual) важнее
 * ставок мастера. Дальше: ставка мастера на эту услугу (сумма или процент) → его общая ставка по режиму → база.
 */
export function termsFor(rates: ExecutorRates | undefined, o: RateOrder): PayoutTerms {
  const base: PayoutTerms = o.payoutBase ?? { payoutMode: o.payoutMode, payoutValue: o.payoutValue };
  if (!rates || o.payoutManual) return base;
  const own = rates.perService?.[o.serviceId];
  if (own?.fixed !== undefined) return { payoutMode: "fixed", payoutValue: own.fixed };
  if (own?.percent !== undefined) return { payoutMode: "percent", payoutValue: own.percent };
  if (rates.mode === "percent" && rates.percent !== undefined) return { payoutMode: "percent", payoutValue: rates.percent };
  if (rates.mode === "fixed" && rates.fixed !== undefined) return { payoutMode: "fixed", payoutValue: rates.fixed };
  return base;
}

/** Сколько получит мастер за заказ по своей ставке — для ленты, «Нового заказа» и подбора. */
export const payoutFor = (rates: ExecutorRates | undefined, o: RateOrder): number => payout({ clientPrice: o.clientPrice, ...termsFor(rates, o) });
export const margin = (o: Pick<Order, "clientPrice" | "payoutMode" | "payoutValue">) => o.clientPrice - payout(o);
export const marginPct = (o: Order) => (o.clientPrice > 0 ? Math.round((margin(o) / o.clientPrice) * 1000) / 10 : 0);
/** Оплачено клиентом: сторнированные платежи не считаются. Возвраты долг не меняют — см. ./money. */
export const paidAmount = (o: Pick<Order, "payments">) => o.payments.reduce((s, p) => (p.voidedAt ? s : s + p.amount), 0);
export const debt = (o: Pick<Order, "status" | "clientPrice" | "payments">) => (isFinished(o) ? Math.max(0, o.clientPrice - paidAmount(o)) : 0);
/** Возвращено клиенту. */
export const refundedAmount = (o: { refunds?: readonly { amount: number }[] }) => (o.refunds ?? []).reduce((s, r) => s + r.amount, 0);

/** Что нужно знать о заказе, чтобы посчитать выручку с учётом возвратов. */
export type RevenueLike = Pick<Order, "clientPrice"> & { payments?: Pick<Order, "payments">["payments"]; refunds?: readonly { amount: number }[] };

/**
 * Выручка заказа за вычетом возвратов (E1). Возврат сначала покрывает переплату — деньги сверх цены клиенту
 * и так причитались, — и только остаток уменьшает цену сделки.
 */
export function revenueOf(o: RevenueLike): number {
  const refunded = refundedAmount(o);
  if (!refunded) return o.clientPrice;
  const overpaid = Math.max(0, (o.payments ? paidAmount({ payments: o.payments }) : 0) - o.clientPrice);
  return o.clientPrice - Math.max(0, refunded - overpaid);
}
/** Маржа заказа с учётом возвратов: выручка минус выплата исполнителю. */
export const netMargin = (o: RevenueLike & Pick<Order, "payoutMode" | "payoutValue">) => revenueOf(o) - payout(o);

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
    revenue: done.reduce((s, o) => s + revenueOf(o), 0),
    margin: done.reduce((s, o) => s + netMargin(o), 0),
  };
};

// ── Подбор исполнителя (ТЗ п.11, п.12) ──────────────────────────────────────

/** Сколько заказов в работе мастер держит одновременно, если владелец не задал ему другое число (ТЗ п.14, E9). */
export const DEFAULT_MAX_ACTIVE = 3;
export const maxActiveOf = (e: Pick<Executor, "maxActiveOrders">): number => e.maxActiveOrders ?? DEFAULT_MAX_ACTIVE;

/** Что нужно знать о мастере для подбора: и документ базы, и DTO подходят. */
export type FitExecutor = Pick<Executor, "available" | "city" | "categories" | "skills"> &
  Partial<Pick<Executor, "maxActiveOrders" | "unavailableUntil">> & { districts?: readonly string[] };
/** Что нужно знать о заказе для подбора. */
export type FitOrder = Pick<Order, "category" | "city"> & { requiredSkills?: readonly string[]; district?: string };

/** Район подходит (ТЗ п.12.3): у мастера районы не заданы — весь город; у заказа района нет — не сужаем. */
export const districtFits = (e: Pick<FitExecutor, "districts">, o: Pick<FitOrder, "district">): boolean =>
  !e.districts?.length || !o.district || e.districts.some((d) => districtKey(d) === districtKey(o.district!));

export interface Fit {
  fits: boolean;
  /** Почему не подходит — подсказка при ручном назначении: «выходной», «другой город», «нет навыка: …». */
  reasons: string[];
  /** Сколько требуемых навыков у мастера есть. */
  matched: number;
  /** Каких требуемых навыков нет. */
  missing: string[];
}

/**
 * Единственное правило «заказ подходит мастеру»: лента, уведомление «Новый заказ», «Взять заказ»
 * и подбор при ручном назначении считают одинаково. Мастер на смене (недоступность «до …» — тоже не на смене),
 * город тот же (в любом написании: «г. Алматы» = «Алматы»), район — из его районов (если районы заданы и у мастера,
 * и у заказа), направление заказа — его, все требуемые навыки у него есть (сравнение без учёта регистра и пробелов).
 * load — сколько заказов у мастера уже в работе: на лимите заказ ему не подходит; не передан — лимит не проверяем
 * (лента показывает работу и мастеру на лимите).
 */
export function fitsOrder(e: FitExecutor, o: FitOrder, load?: number): Fit {
  const reasons: string[] = [];
  if (!e.available) reasons.push(e.unavailableUntil ? `недоступен до ${dateAlmaty(e.unavailableUntil)}, ${timeAlmaty(e.unavailableUntil)}` : "выходной");
  if (load !== undefined && load >= maxActiveOf(e)) reasons.push(`лимит заказов: в работе ${load} из ${maxActiveOf(e)}`);
  if (cityKey(e.city) !== cityKey(o.city)) reasons.push("другой город");
  else if (!districtFits(e, o)) reasons.push("другой район");
  if (!e.categories.includes(o.category)) reasons.push("другая специализация");
  const own = new Set(e.skills.map(textKey));
  const required = o.requiredSkills ?? [];
  const missing = required.filter((s) => !own.has(textKey(s)));
  if (missing.length) reasons.push(`${missing.length === 1 ? "нет навыка" : "нет навыков"}: ${missing.join(", ")}`);
  return { fits: reasons.length === 0, reasons, matched: required.length - missing.length, missing };
}

/** Заказ лежит в ленте и его ещё никто не взял. */
export const isOpenForFeed = (o: Pick<Order, "status" | "executorId">) => o.status === "awaiting_executor" && !o.executorId;

/**
 * Адрес и телефон клиента мастер видит, пока заказ у него в работе (аудит L-5): после подтверждения и до оплаты.
 * Назначенный, но не подтверждённый, оплаченный, закрытый, отменённый и возврат — без контактов. Одно правило
 * для кабинета, карточек Telegram и утренней сводки.
 */
export const CONTACT_STATUSES: readonly OrderStatus[] = ["accepted", "in_progress", "awaiting_client", "done", "awaiting_payment"];
export const contactsOpen = (o: Pick<Order, "status">) => CONTACT_STATUSES.includes(o.status);

/**
 * Лента исполнителя: свободные заказы, которые ему подходят (ТЗ п.11) по городу, направлению и навыкам.
 * Выходной ленту не скрывает: мастер видит, что есть работа, но взять заказ и получить «Новый заказ»
 * может только с включённым приёмом (это проверяют «Взять заказ» и рассылка — через fitsOrder целиком).
 */
export const feedFor = <O extends FitOrder & Pick<Order, "status" | "executorId">>(e: FitExecutor, orders: O[]): O[] =>
  orders.filter((o) => isOpenForFeed(o) && fitsOrder({ ...e, available: true }, o).fits);

const STATE_RANK: Record<ExecState, number> = { free: 0, busy: 1, onsite: 2, off: 3 };

export interface Candidate {
  e: Executor;
  state: ExecState;
  /** Заказов в работе сейчас. */
  load: number;
  fits: boolean;
  reasons: string[];
  matched: number;
  /** Баллы качества: рейтинг и история за 90 дней (qualityScore). */
  quality: number;
}

// ── История мастера за 90 дней (ТЗ п.12.6) ──────────────────────────────────

/** Окно истории и веса баллов качества — одни для подбора, автораспределения и подсказки в «Настройках». */
export const HISTORY = {
  days: 90,
  /** Меньше сданных заказов — «вовремя» не считаем: новичка не наказываем и не поощряем. */
  minDone: 3,
  /** «Вовремя» новичка для баллов. */
  neutralOnTime: 80,
  /** Балл за звезду рейтинга: 5,0 → 100. */
  perStar: 20,
  /** Минус за каждый отказ (отказался сам или не подтвердил назначение вовремя). */
  perRefusal: 15,
  /** Отказов в счёт — не больше: дальше мастер и так внизу. */
  maxRefusals: 4,
} as const;

/** Доля заказов, сданных в срок, %; мало сданных — null. */
export function onTimePct(s: Pick<ExecutorStats90, "done" | "onTime"> | undefined): number | null {
  if (!s || s.done < HISTORY.minDone) return null;
  return Math.round((s.onTime / s.done) * 100);
}

/**
 * Баллы качества мастера: рейтинг × 20 (5,0 → 100) + сдано вовремя, % (новичку — 80) − 15 за каждый отказ за 90 дней.
 * При прочих равных (подходит, свободен, загрузка) выше тот, у кого баллов больше.
 */
export function qualityScore(e: Pick<Executor, "rating"> & { stats90?: ExecutorStats90 }): number {
  const onTime = onTimePct(e.stats90) ?? HISTORY.neutralOnTime;
  const refusals = Math.min(e.stats90?.refusals ?? 0, HISTORY.maxRefusals);
  return Math.round(e.rating * HISTORY.perStar + onTime - refusals * HISTORY.perRefusal);
}

/** «вовремя 92% · отказов 1 · в среднем 5 ч» — история мастера одной строкой; истории нет — null. */
export function historyLine(s: ExecutorStats90 | undefined): string | null {
  if (!s) return null;
  const pct = onTimePct(s);
  const parts = [pct === null ? `сдано ${s.done}` : `вовремя ${pct}%`, `отказов ${s.refusals}`];
  if (s.avgHours !== undefined && s.done >= HISTORY.minDone) parts.push(`в среднем ${s.avgHours < 24 ? `${s.avgHours} ч` : `${Math.round(s.avgHours / 24)} дн`}`);
  return parts.join(" · ");
}

/**
 * Кандидаты для ручного назначения (ТЗ п.12): сначала подходящие, затем у кого больше требуемых навыков,
 * свободные раньше занятых, меньше загрузка, больше баллов качества (рейтинг и история за 90 дней).
 * Неподходящие остаются в списке с причинами — среди них выше те, кому не хватает меньшего.
 */
export function rankExecutors(o: FitOrder, executors: Executor[], orders: Load[]): Candidate[] {
  return executors
    .map((e): Candidate => {
      const load = orders.filter((x) => x.executorId === e.id && isInWork(x)).length;
      const fit = fitsOrder(e, o, load);
      return { e, state: executorState(e, orders), load, fits: fit.fits, reasons: fit.reasons, matched: fit.matched, quality: qualityScore(e) };
    })
    .sort(
      (a, b) =>
        Number(b.fits) - Number(a.fits) ||
        a.reasons.length - b.reasons.length ||
        b.matched - a.matched ||
        STATE_RANK[a.state] - STATE_RANK[b.state] ||
        a.load - b.load ||
        b.quality - a.quality ||
        b.e.rating - a.e.rating ||
        a.e.name.localeCompare(b.e.name, "ru"),
    );
}

export type ClientState = { label: string; tone: Tone };
/** Статус клиента по счётчикам, которые сервер держит на карточке клиента. */
export const clientState = (c: Client, now = Date.now()): ClientState => {
  if ((c.activeCount ?? 0) > 0) return { label: "В работе", tone: "amber" };
  if (!c.ordersCount) return now - new Date(c.createdAt).getTime() < 30 * 86400_000 ? { label: "Новый", tone: "blue" } : { label: "Потенциальный", tone: "red" };
  return c.lastOrderAt && now - new Date(c.lastOrderAt).getTime() < 120 * 86400_000 ? { label: "Активный", tone: "green" } : { label: "Неактивен", tone: "gray" };
};

/** Что видит пользователь: исполнитель — только свои заказы и ленту, сотрудники — всё. */
export const canSeeFinance = (u: User) => can(u, "money.view");
export const canSeeAnalytics = (u: User) => can(u, "analytics.view");

export const userName = (db: DB, id: string) => db.users.find((u) => u.id === id)?.name ?? "Система";
