// Отзывы клиентов и рейтинг мастера (ТЗ п.14 «Рейтинг и отзывы», п.29 «закрытие → рейтинг»).
// Правила — общие для сервера (convex/reviews.ts) и интерфейса: что можно оценить, как считается рейтинг,
// что видит клиент по ссылке.
import { FINISHED_STATUSES } from "./catalog";
import type { Executor, Order, Review, ReviewVia } from "./types";
import { plural } from "../lib/format";

/**
 * Рейтинг — байесовское среднее: (C·m + Σоценок) / (C + n). Пока отзывов мало, рейтинг держится
 * около m = 4,5, и одна-две оценки не роняют и не возносят мастера; с ростом n он сходится к реальному среднему.
 */
export const RATING_PRIOR = { mean: 4.5, weight: 5 } as const;

/** Самый длинный комментарий к оценке. */
export const REVIEW_TEXT_MAX = 1000;
/** Сколько дней действует ссылка «оцените работу». */
export const REVIEW_LINK_DAYS = 14;
/** Сколько дней сотрудник может исправить записанную им оценку. */
export const REVIEW_EDIT_DAYS = 7;
/** Оценка не выше этой — «низкая»: владельцу и руководителю направления приходит уведомление. */
export const LOW_RATING = 3;

export const REVIEW_VIA: Record<ReviewVia, string> = {
  operator: "со слов клиента",
  link: "по ссылке",
  telegram: "в Telegram",
  whatsapp: "в WhatsApp",
};

/** Подписи под звёздами: 1 — «Ужасно» … 5 — «Отлично». */
export const RATING_WORDS = ["Ужасно", "Плохо", "Нормально", "Хорошо", "Отлично"] as const;
export const ratingWord = (rating: number): string => RATING_WORDS[Math.min(5, Math.max(1, Math.round(rating))) - 1]!;

/** Рейтинг мастера по оценкам его отзывов, с одним знаком после запятой. */
export function bayesianRating(ratings: readonly number[]): number {
  const sum = ratings.reduce((s, r) => s + r, 0);
  const value = (RATING_PRIOR.mean * RATING_PRIOR.weight + sum) / (RATING_PRIOR.weight + ratings.length);
  return Math.round(value * 10) / 10;
}

/** Заказ можно оценить: работа выполнена (и дальше по пути до «Закрыт»), мастер известен. */
export const isReviewable = (o: Pick<Order, "status"> & { executorId?: string }): boolean => FINISHED_STATUSES.includes(o.status) && !!o.executorId;

export type ReviewInput = { ok: true; rating: number; text?: string } | { ok: false; error: string };

/** Оценка — целое от 1 до 5; комментарий необязателен и не длиннее REVIEW_TEXT_MAX. */
export function checkReview(rating: number, text?: string): ReviewInput {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return { ok: false, error: "Оценка — от 1 до 5 звёзд" };
  const clean = (text ?? "").trim();
  if (clean.length > REVIEW_TEXT_MAX) return { ok: false, error: `Комментарий — не длиннее ${REVIEW_TEXT_MAX} символов` };
  return { ok: true, rating, text: clean || undefined };
}

/** Состояние ссылки для клиента: можно оценить, уже оценено, срок вышел, ссылки нет. */
export type ReviewLinkState = "ok" | "used" | "expired" | "invalid";

/**
 * Что видит клиент по ссылке. Ни имени, ни телефона, ни адреса клиента: номер заказа, услуга,
 * имя мастера и дата выполнения. По несуществующей ссылке — только состояние.
 */
export interface ReviewLinkInfo {
  state: ReviewLinkState;
  order?: { number: number; service: string; executor: string; doneAt?: string };
}

/** Ответ на отправку оценки по ссылке: ошибки — данными, чтобы счётчик попыток не откатывался вместе с исключением. */
export type ReviewSubmitResult = { ok: true } | { ok: false; state: ReviewLinkState | "limited" | "input"; error: string };

/** Отзыв в карточке заказа и мастера; authorId — сотрудник, который записал оценку со слов клиента. */
export interface ReviewView extends Review {
  authorId?: string;
  orderNumber?: number;
}

/** Блок «Отзыв клиента» в карточке заказа. Время интерфейс сверяет сам — ответ сервера от часов не зависит. */
export interface OrderReviewInfo {
  review: ReviewView | null;
  /** Заказ выполнен и мастер известен — оценку можно получить. */
  reviewable: boolean;
  /** До какого момента сотрудник может исправить оценку, записанную со слов клиента. */
  editableUntil?: string;
  /** Срок последней неиспользованной ссылки для клиента. */
  linkExpiresAt?: string;
}

/** Отзывы в карточке мастера: последние и сколько оценок каждой звёздности ([1★ … 5★]). */
export interface ExecutorReviewsInfo {
  latest: ReviewView[];
  total: number;
  byStars: number[];
}

/** «12 отзывов». */
export const reviewsCount = (n: number): string => `${n} ${plural(n, "отзыв", "отзыва", "отзывов")}`;

/** Рейтинг для подписи: «4.8» или null, если оценок ещё нет (тогда интерфейс пишет «Пока нет оценок»). */
export const ratingValue = (e: Pick<Executor, "rating" | "reviews">): string | null => (e.reviews > 0 ? e.rating.toFixed(1) : null);
