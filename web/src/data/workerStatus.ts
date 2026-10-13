// Статусы заказа глазами мастера: короткие подписи, подсказка «что сейчас», шаги, чип выплаты,
// порядок «Моих заказов» и разбор ответов сервера. Чистые функции — проверяются тестами.
import { money } from "../lib/format";
import { isActiveWork, isEarning } from "./workerStats";
import type { OrderStatus, WorkerOrder } from "./types";

/** Тон бейджа. Цвета текста подобраны под контраст не ниже 4,5:1 на своём фоне (см. components/worker/kit). */
export type WTone = "warn" | "sky" | "ok" | "orange" | "slate" | "bad" | "brand";

export interface StatusView {
  label: string;
  tone: WTone;
  /** Подсказка под шагами: что делать сейчас. */
  hint: string;
}

type StatusOrder = Pick<WorkerOrder, "status" | "payoutPaid" | "payout" | "deadline">;

/** Активный заказ мастера, срок которого прошёл. */
export const isOverdueWork = (o: Pick<WorkerOrder, "status" | "deadline">, now: number): boolean => isActiveWork(o) && Date.parse(o.deadline) < now;

const VIEW: Record<OrderStatus, (o: StatusOrder) => StatusView> = {
  new: () => ({ label: "Новый", tone: "slate", hint: "" }),
  awaiting_executor: () => ({ label: "Свободен", tone: "slate", hint: "" }),
  assigned: () => ({ label: "Ждёт подтверждения", tone: "warn", hint: "Оператор назначил вам заказ. Подтвердите — откроются адрес и телефон клиента." }),
  accepted: () => ({ label: "Принят", tone: "sky", hint: "Позвоните клиенту и приезжайте к сроку. На месте нажмите «Начать работу»." }),
  in_progress: () => ({ label: "В работе", tone: "warn", hint: "Закончите — нажмите «Работа выполнена» и приложите фото." }),
  awaiting_client: () => ({ label: "На паузе", tone: "orange", hint: "Работа на паузе. Вернулись к работе — «Снять паузу». Закончили — «Работа выполнена»." }),
  done: () => ({ label: "Сдан", tone: "ok", hint: "Работа сдана. Ждём оплату от клиента — потом выплата вам." }),
  awaiting_payment: () => ({ label: "Ждём оплату", tone: "warn", hint: "Клиент ещё не оплатил. Выплата — после оплаты." }),
  paid: (o) => (o.payoutPaid ? { label: "Выплачено", tone: "ok", hint: paidHint(o) } : { label: "Клиент оплатил", tone: "ok", hint: paidHint(o) }),
  closed: (o) => (o.payoutPaid ? { label: "Выплачено", tone: "ok", hint: paidHint(o) } : { label: "Закрыт", tone: "slate", hint: paidHint(o) }),
  cancelled: () => ({ label: "Отменён", tone: "slate", hint: "Заказ отменён. Ничего делать не нужно." }),
  refund: () => ({ label: "Возврат", tone: "bad", hint: "По заказу оформлен возврат. Вопросы — оператору." }),
};

function paidHint(o: StatusOrder): string {
  return o.payoutPaid ? `Выплата ${money(o.payout)} отправлена. Спасибо за работу!` : `Клиент оплатил. Выплата ${money(o.payout)} — скоро.`;
}

/** Бейдж и подсказка. Просрочка активного заказа важнее статуса. */
export function statusView(o: StatusOrder, now: number): StatusView {
  const base = VIEW[o.status](o);
  return isOverdueWork(o, now) ? { ...base, label: "Просрочен", tone: "bad" } : base;
}

export interface Step {
  label: string;
  state: "done" | "current" | "todo";
}

const STEP_LABELS = ["Принят", "В работе", "Сдан", "Выплачено"] as const;

/** Четыре шага «Принят → В работе → Сдан → Выплачено». Для отмены и возврата шагов нет. */
export function stepsOf(o: Pick<WorkerOrder, "status" | "payoutPaid">): Step[] | null {
  if (o.status === "cancelled" || o.status === "refund") return null;
  const finished = isEarning(o);
  const passed = [o.status !== "assigned", finished, finished, o.payoutPaid];
  const current = passed.indexOf(false);
  return STEP_LABELS.map((label, i) => {
    const state = passed[i] ? "done" : i === current ? "current" : "todo";
    if (state === "current" && i === 0 && o.status === "assigned") return { label: "Подтвердите", state };
    if (state === "current" && i === 1 && o.status === "awaiting_client") return { label: "Пауза", state };
    return { label, state };
  });
}

export interface PayoutChip {
  label: string;
  tone: WTone;
}

/** Чип выплаты у завершённых заказов — один для экрана заказа, «Моих заказов» и «Дохода». У активных — нет. */
export function payoutChip(o: Pick<WorkerOrder, "status" | "payoutPaid">): PayoutChip | null {
  if (o.status === "cancelled") return { label: "Отменён", tone: "slate" };
  if (o.status === "refund") return { label: "Возврат", tone: "bad" };
  if (!isEarning(o)) return null;
  if (o.payoutPaid) return { label: "Выплачено", tone: "ok" };
  if (o.status === "paid" || o.status === "closed") return { label: "К выплате", tone: "warn" };
  return { label: "Ждёт оплаты клиента", tone: "slate" };
}

/** Порядок «Активных»: ждёт подтверждения → просрочен → в работе → на паузе → принят; внутри — по сроку. */
export function activeRank(o: Pick<WorkerOrder, "status" | "deadline">, now: number): number {
  if (o.status === "assigned") return 0;
  if (isOverdueWork(o, now)) return 1;
  if (o.status === "in_progress") return 2;
  if (o.status === "awaiting_client") return 3;
  return 4;
}

export function sortActive<T extends Pick<WorkerOrder, "status" | "deadline">>(orders: readonly T[], now: number): T[] {
  return [...orders].sort((a, b) => activeRank(a, now) - activeRank(b, now) || a.deadline.localeCompare(b.deadline));
}

/** Сколько заказов ждут действия мастера: назначенные без подтверждения и просроченные. */
export function needsAction(orders: readonly Pick<WorkerOrder, "status" | "deadline">[], now: number): number {
  return orders.filter((o) => o.status === "assigned" || isOverdueWork(o, now)).length;
}

/** Адрес и телефон клиента откроются после подтверждения заказа. */
export const contactsLocked = (o: Pick<WorkerOrder, "status">) => o.status === "assigned";

/**
 * Что значит отказ сервера — по тексту ConvexError (кодов ошибок у worker.* пока нет).
 * taken — заказ ушёл другому или снят с ленты; mine — уже ваш; off_shift — приём выключен;
 * not_fit — не подходит; changed — статус уже изменился; not_yours — заказ больше не ваш.
 */
export type Refusal = "taken" | "mine" | "off_shift" | "not_fit" | "changed" | "not_yours" | "network" | "other";

export function refusalOf(error: string): Refusal {
  if (/уже ваш/i.test(error)) return "mine";
  if (/уже взял|снят с ленты|заказ не найден/i.test(error)) return "taken";
  if (/выходн|при[её]м заказов/i.test(error)) return "off_shift";
  if (/не подходит/i.test(error)) return "not_fit";
  if (/статус уже изменился/i.test(error)) return "changed";
  if (/не ваш заказ/i.test(error)) return "not_yours";
  if (/нет связи|интернет/i.test(error)) return "network";
  return "other";
}
