// Ответы запросов кабинета мастера (convex/executorApp.ts). Только то, что мастеру можно видеть:
// ни цены клиента, ни маржи, ни платежей, ни внутренней переписки команды.
import type { Tone } from "./catalog";
import type { CategoryId, Executor, WorkerOrder } from "./types";
import type { ExecutorStats } from "./workerStats";

/** Фото к заказу, которое можно показать мастеру. */
export interface WorkerPhoto {
  id: string;
  name: string;
  url: string;
}

/** Вложение в сообщении мастера. У документа превью нет, только ссылка. */
export interface WorkerFile {
  id: string;
  name: string;
  kind: "image" | "file";
  url?: string;
}

/** Сообщение мастера оператору по заказу. */
export interface WorkerNote {
  id: string;
  text: string;
  at: string;
  files: WorkerFile[];
}

/** То, чего ленте не хватает в worker.feed: когда заказ опубликован и превью первого фото. */
export interface FeedExtra {
  id: string;
  publishedAt: string;
  thumbUrl?: string;
  photos: number;
}

/**
 * Экран заказа:
 * available — свободен и подходит мастеру (контакты скрыты);
 * mine — заказ мастера (контакты — после подтверждения);
 * taken — подходил, но его уже взял другой мастер;
 * unavailable — нет, не подходит или снят с ленты (без подробностей).
 */
export type WorkerOrderView =
  | { state: "available"; order: WorkerOrder; photos: WorkerPhoto[]; publishedAt: string }
  | { state: "mine"; order: WorkerOrder; photos: WorkerPhoto[]; notes: WorkerNote[] }
  | { state: "taken" }
  | { state: "unavailable" };

/** Отзыв клиента — без имени и контактов клиента. */
export interface WorkerReview {
  id: string;
  rating: number;
  text?: string;
  at: string;
  /** Услуга заказа: «Ремонт стиральной машины». */
  service: string;
}

export interface WorkerProfile {
  name: string;
  phone: string;
  city: string;
  categories: { id: CategoryId; label: string; tone: Tone }[];
  skills: string[];
  rating: number;
  reviewsCount: number;
  available: boolean;
  cooperation: Executor["cooperation"];
  joinedAt: string;
  telegram: { enabled: boolean; linked: boolean };
  stats: ExecutorStats;
  /** Последние отзывы, новые сверху. */
  reviews: WorkerReview[];
}
