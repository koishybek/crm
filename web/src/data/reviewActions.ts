// Отзывы: действия интерфейса → convex/reviews.ts. Каждое возвращает Result, текст ошибки — для тоста.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run, type Result } from "./convex";
import type { ReviewSubmitResult } from "./reviews";

const oid = (id: string) => id as Id<"orders">;

/**
 * Ссылка «оцените работу» для клиента: действующая или новая. Без APP_URL сервер отдаёт путь —
 * дописываем адрес, с которого открыто приложение, чтобы ссылку можно было сразу отправить.
 */
export async function requestReviewLink(orderId: string): Promise<Result<{ url: string; expiresAt: string }>> {
  const r = await run(convex.mutation(api.reviews.requestLink, { orderId: oid(orderId) }));
  return r.ok ? { ok: true, value: { ...r.value, url: new URL(r.value.url, window.location.origin).toString() } } : r;
}

/** Оценка со слов клиента; повторный вызов исправляет записанную (в течение 7 дней). */
export const saveOperatorReview = (orderId: string, rating: number, text: string) =>
  run(convex.mutation(api.reviews.addByOperator, { orderId: oid(orderId), rating, text: text.trim() || undefined }));

/** Оценка клиента по ссылке — без входа. */
export const submitReviewByLink = (token: string, rating: number, text: string): Promise<Result<ReviewSubmitResult>> =>
  run(convex.mutation(api.reviews.submitByToken, { token, rating, text: text.trim() || undefined }));
