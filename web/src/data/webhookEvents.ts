// Исходящие вебхуки (ТЗ п.20.7, п.26.7, п.19.10): события, их названия и то, что видит владелец в «API и сайт».
// Общие для сервера (convex/webhooks.ts, convex/lib/webhookEvents.ts) и интерфейса.

export const WEBHOOK_EVENTS = ["lead.created", "lead.status_changed", "order.created", "order.status_changed", "order.paid", "review.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** Тестовое событие — по кнопке «Отправить тестовое событие», подписываться на него не нужно. */
export type WebhookEventOrTest = WebhookEvent | "webhook.test";

export const WEBHOOK_EVENT_LABEL: Record<WebhookEventOrTest, string> = {
  "lead.created": "Новая заявка",
  "lead.status_changed": "Статус заявки изменён",
  "order.created": "Заказ создан",
  "order.status_changed": "Статус заказа изменён",
  "order.paid": "Заказ оплачен",
  "review.created": "Новый отзыв",
  "webhook.test": "Тестовое событие",
};

/** Попыток доставки одного события: первая + 7 повторов с удвоением паузы (1, 2, 4 … 64 минуты). */
export const WEBHOOK_MAX_ATTEMPTS = 8;
/** Неудачных попыток подряд, после которых подписка отключается и владелец получает уведомление. */
export const WEBHOOK_DISABLE_AFTER = 20;
/** Подпись старше этого получатель должен отвергать — защита от повтора перехваченного запроса. */
export const WEBHOOK_TOLERANCE_SEC = 300;
export const SIGNATURE_HEADER = "X-HMS-Signature";

export interface WebhookInfo {
  id: string;
  url: string;
  events: WebhookEvent[];
  description?: string;
  active: boolean;
  failures: number;
  createdAt: string;
  disabledAt?: string;
  disabledReason?: string;
  lastDeliveryAt?: string;
  lastError?: string;
}

export interface WebhookDeliveryInfo {
  id: string;
  webhookId: string;
  event: WebhookEventOrTest;
  status: "pending" | "ok" | "failed";
  attempts: number;
  responseCode?: number;
  error?: string;
  createdAt: string;
  deliveredAt?: string;
  nextAt?: string;
}

export interface WebhooksView {
  webhooks: WebhookInfo[];
  deliveries: WebhookDeliveryInfo[];
  /** Без ключа шифрования секрет подписки сохранить нельзя — что не так (null — всё в порядке). */
  keyIssue: string | null;
}
