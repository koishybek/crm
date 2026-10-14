// Ответы запросов кабинета мастера (convex/executorApp.ts). Только то, что мастеру можно видеть:
// ни цены клиента, ни маржи, ни платежей, ни внутренней переписки команды. Ссылки на файлы — подписанные, на 15 минут.
import type { Tone } from "./catalog";
import type { CategoryId, Executor, WorkerOrder } from "./types";
import type { ExecutorStats } from "./workerStats";

/** Фото к заказу, которое можно показать мастеру (отмечено «Показать мастеру»). */
export interface WorkerPhoto {
  id: string;
  name: string;
  url: string;
}

/** Вложение в переписке или документ заказа. У документа превью нет, только ссылка. */
export interface WorkerFile {
  id: string;
  name: string;
  kind: "image" | "file";
  url?: string;
}

/** Сообщение в переписке мастера с офисом по заказу (канал «С мастером»). */
export interface WorkerNote {
  id: string;
  text: string;
  at: string;
  files: WorkerFile[];
  /** Написал сам мастер; иначе — офис. */
  mine: boolean;
  /** Кто из офиса написал: «Мадина». */
  author?: string;
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
  | { state: "available"; order: WorkerOrder; photos: WorkerPhoto[]; documents: WorkerFile[]; publishedAt: string }
  | { state: "mine"; order: WorkerOrder; photos: WorkerPhoto[]; documents: WorkerFile[]; notes: WorkerNote[] }
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
  /** «Не принимаю до …» — в это время приём включится сам. */
  unavailableUntil?: string;
  unavailableReason?: string;
  cooperation: Executor["cooperation"];
  joinedAt: string;
  /** Районы, где мастер берёт заказы; пусто — весь город. */
  districts: string[];
  telegram: { enabled: boolean; linked: boolean };
  stats: ExecutorStats;
  /** Последние отзывы, новые сверху. */
  reviews: WorkerReview[];
}
