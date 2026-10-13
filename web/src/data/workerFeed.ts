// Лента мастера: фильтры-чипы, сортировка, метка «Новый» и строки без прыжков под пальцем.
// Чистые функции — проверяются тестами (convex/executorUi.test.ts).
import type { WorkerOrder } from "./types";
import type { FeedExtra } from "./workerTypes";
import { almatyDayKey, DAY_MS, type Moment } from "./workerTime";

const HOUR_MS = 3600_000;

/** Заказ ленты с тем, чего нет в worker.feed: когда опубликован и превью фото. */
export interface FeedItem extends WorkerOrder {
  publishedAt: string;
  thumbUrl?: string;
  photos: number;
}

/** Склейка worker.feed и executorApp.feedExtras. Нет данных о публикации — считаем от создания заказа. */
export function withExtras(feed: readonly WorkerOrder[], extras: readonly FeedExtra[] | undefined): FeedItem[] {
  const byId = new Map((extras ?? []).map((x) => [x.id, x] as const));
  return feed.map((o) => {
    const x = byId.get(o.id);
    return { ...o, publishedAt: x?.publishedAt ?? o.createdAt, thumbUrl: x?.thumbUrl, photos: x?.photos ?? 0 };
  });
}

export type FeedWhen = "today" | "tomorrow";
export type FeedSort = "urgent" | "new" | "pay";

export interface FeedFilter {
  urgent: boolean;
  when: FeedWhen | null;
  cat: string | null;
}

export const NO_FILTER: FeedFilter = { urgent: false, when: null, cat: null };

export const SORT_LABEL: Record<FeedSort, string> = {
  urgent: "Сначала срочные",
  new: "Сначала новые",
  pay: "Сначала дороже",
};

/** Фильтры и сортировка живут в адресе (?urgent=1&when=today&cat=ac&sort=new) — «Назад» их возвращает. */
export function readFeedParams(p: URLSearchParams): { filter: FeedFilter; sort: FeedSort } {
  const when = p.get("when");
  const sort = p.get("sort");
  return {
    filter: { urgent: p.get("urgent") === "1", when: when === "today" || when === "tomorrow" ? when : null, cat: p.get("cat") || null },
    sort: sort === "new" || sort === "pay" ? sort : "urgent",
  };
}

export function writeFeedParams(filter: FeedFilter, sort: FeedSort): URLSearchParams {
  const p = new URLSearchParams();
  if (filter.urgent) p.set("urgent", "1");
  if (filter.when) p.set("when", filter.when);
  if (filter.cat) p.set("cat", filter.cat);
  if (sort !== "urgent") p.set("sort", sort);
  return p;
}

export const isFiltered = (f: FeedFilter) => f.urgent || f.when !== null || f.cat !== null;

/** Срок заказа сегодня / завтра по Алматы. */
export function dueOn(deadline: string, when: FeedWhen, now: Moment): boolean {
  const day = almatyDayKey(Date.parse(deadline));
  const today = typeof now === "number" ? now : Date.parse(now);
  return day === almatyDayKey(when === "today" ? today : today + DAY_MS);
}

export function matchesFilter(o: Pick<WorkerOrder, "priority" | "deadline" | "category">, f: FeedFilter, now: Moment): boolean {
  if (f.urgent && o.priority !== "urgent") return false;
  if (f.when && !dueOn(o.deadline, f.when, now)) return false;
  if (f.cat && o.category !== f.cat) return false;
  return true;
}

export interface ChipCounts {
  urgent: number;
  today: number;
  tomorrow: number;
  byCat: Record<string, number>;
}

/** Числа в чипах — по всей ленте, без учёта выбранных фильтров. */
export function chipCounts(items: readonly Pick<WorkerOrder, "priority" | "deadline" | "category">[], now: Moment): ChipCounts {
  const out: ChipCounts = { urgent: 0, today: 0, tomorrow: 0, byCat: {} };
  for (const o of items) {
    if (o.priority === "urgent") out.urgent += 1;
    if (dueOn(o.deadline, "today", now)) out.today += 1;
    if (dueOn(o.deadline, "tomorrow", now)) out.tomorrow += 1;
    out.byCat[o.category] = (out.byCat[o.category] ?? 0) + 1;
  }
  return out;
}

const PRIORITY_RANK: Record<WorkerOrder["priority"], number> = { urgent: 0, high: 1, normal: 2 };

/** Сортировка ленты; при равенстве — по номеру заказа, чтобы порядок не «плавал». */
export function sortFeed<T extends Pick<FeedItem, "priority" | "deadline" | "publishedAt" | "payout" | "number">>(items: readonly T[], sort: FeedSort): T[] {
  const cmp: Record<FeedSort, (a: T, b: T) => number> = {
    urgent: (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.deadline.localeCompare(b.deadline),
    new: (a, b) => b.publishedAt.localeCompare(a.publishedAt),
    pay: (a, b) => b.payout - a.payout || a.deadline.localeCompare(b.deadline),
  };
  return [...items].sort((a, b) => cmp[sort](a, b) || a.number - b.number);
}

/** Метка «Новый»: заказ опубликован меньше часа назад. */
export const isFresh = (publishedAt: string, now: number): boolean => now - Date.parse(publishedAt) < HOUR_MS;

/**
 * Счётчик на вкладке «Заказы»: опубликованные после последнего просмотра ленты.
 * Ленту ещё не открывали на этом устройстве — считаем свежие (меньше часа).
 */
export function countUnseen(items: readonly Pick<FeedExtra, "publishedAt">[], seenAt: number | null, now: number): number {
  return items.filter((o) => (seenAt === null ? isFresh(o.publishedAt, now) : Date.parse(o.publishedAt) > seenAt)).length;
}

export type FeedRow<T> = { kind: "order"; item: T } | { kind: "gone"; id: string; number: number };

/**
 * Строки ленты: порядок — снимок `ids`, данные — живые. Заказ пропал из ленты (взяли, отменили) —
 * на его месте «надгробие» той же позиции, поэтому карточки под пальцем не сдвигаются.
 * Заказ остался в ленте, но перестал подходить под фильтр, — показываем до следующего обновления списка.
 */
export function feedRows<T extends { id: string }>(ids: readonly string[], all: ReadonlyMap<string, T>, numbers: ReadonlyMap<string, number>): FeedRow<T>[] {
  return ids.map((id) => {
    const item = all.get(id);
    return item ? { kind: "order", item } : { kind: "gone", id, number: numbers.get(id) ?? 0 };
  });
}

/** Новые заказы, которых ещё нет в снимке, — для пилюли «Показать новые заказы (N)». */
export function freshIds(ids: readonly string[], visible: readonly { id: string }[]): string[] {
  const shown = new Set(ids);
  return visible.filter((o) => !shown.has(o.id)).map((o) => o.id);
}

/** Подсказки над лентой, по важности: подключить Telegram, «Как брать заказы», установить приложение. */
export type FeedHintKind = "telegram" | "howto" | "install";
export type FeedHintFlags = Record<FeedHintKind, boolean>;

const HINT_ORDER: readonly FeedHintKind[] = ["telegram", "howto", "install"];

/** Какую подсказку показать при открытии ленты: не больше одной, самую важную из нужных. */
export function pickFeedHint(flags: FeedHintFlags): FeedHintKind | null {
  return HINT_ORDER.find((k) => flags[k]) ?? null;
}

/**
 * Что видно сейчас: выбранная при открытии подсказка — пока она нужна. Скрыли её или подключили Telegram —
 * исчезает, но другая на её место до следующего открытия ленты не встаёт, и запоздавшая (предложение
 * установки от браузера приходит через секунды) не появляется: список под пальцем не прыгает.
 */
export function shownFeedHint(chosen: FeedHintKind | null, flags: FeedHintFlags): FeedHintKind | null {
  return chosen !== null && flags[chosen] ? chosen : null;
}
