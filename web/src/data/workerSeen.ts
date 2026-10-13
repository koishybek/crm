// Что мастер уже видел в своём заказе — выплату, срок и адрес. Если оператор их поменял, экран заказа
// показывает плашку «Оплата изменилась: было…, стало…», «Срок изменён…» или «Адрес изменён» (по одной).
// Снимки хранятся на этом устройстве (localStorage "hm.seen"), не больше SEEN_LIMIT последних заказов.
import type { WorkerOrder } from "./types";

export interface SeenOrder {
  payout: number;
  deadline: string;
  /** null — адрес ещё скрыт: заказ не подтверждён. */
  address: string | null;
}

export type OrderChange = { kind: "payout"; before: number; after: number } | { kind: "deadline"; after: string } | { kind: "address" };

export const seenOf = (o: Pick<WorkerOrder, "payout" | "deadline" | "address">): SeenOrder => ({
  payout: o.payout,
  deadline: o.deadline,
  address: o.address?.trim() || null,
});

/**
 * Что изменилось с прошлого просмотра; важнее всего выплата, затем срок, затем адрес.
 * Срок и адрес важны, только пока заказ в работе. Адрес, который открылся после подтверждения, — не изменение.
 */
export function changeOf(before: SeenOrder, after: SeenOrder, active: boolean): OrderChange | null {
  if (before.payout !== after.payout) return { kind: "payout", before: before.payout, after: after.payout };
  if (!active) return null;
  if (Date.parse(before.deadline) !== Date.parse(after.deadline)) return { kind: "deadline", after: after.deadline };
  if (before.address !== null && after.address !== null && before.address !== after.address) return { kind: "address" };
  return null;
}

type SeenEntry = SeenOrder & { at: number };
export type SeenStore = Record<string, SeenEntry>;

const KEY = "hm.seen";
export const SEEN_LIMIT = 100;

function isEntry(x: unknown): x is SeenEntry {
  if (typeof x !== "object" || x === null) return false;
  const e = x as Record<string, unknown>;
  return typeof e.payout === "number" && typeof e.deadline === "string" && (typeof e.address === "string" || e.address === null) && typeof e.at === "number";
}

/** Разбор сохранённого: повреждённые записи пропускаем. */
export function parseSeen(raw: string | null): SeenStore {
  if (!raw) return {};
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const out: SeenStore = {};
  for (const [id, entry] of Object.entries(data)) if (isEntry(entry)) out[id] = entry;
  return out;
}

/** Оставить `limit` самых свежих записей. */
export function pruneSeen(store: SeenStore, limit = SEEN_LIMIT): SeenStore {
  const entries = Object.entries(store);
  if (entries.length <= limit) return store;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, limit));
}

function load(): SeenStore {
  try {
    return parseSeen(localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

export function readSeen(orderId: string): SeenOrder | null {
  const e = load()[orderId];
  return e ? { payout: e.payout, deadline: e.deadline, address: e.address } : null;
}

/**
 * С чем сравнивать заказ на экране: снимок прошлого просмотра, а если заказ открыт впервые —
 * то, что мастер видит сейчас (тогда правка оператора, пока экран открыт, сразу даёт плашку).
 */
export function seenBase(orderId: string, current: SeenOrder): SeenOrder {
  return readSeen(orderId) ?? current;
}

export function writeSeen(orderId: string, seen: SeenOrder, at = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(pruneSeen({ ...load(), [orderId]: { ...seen, at } })));
  } catch {
    // Хранилище недоступно — плашки об изменениях покажем только пока открыт экран.
  }
}
