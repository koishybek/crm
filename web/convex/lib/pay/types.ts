// Общий вид провайдера онлайн-оплаты: ссылка на оплату счёта и проверка уведомления об оплате.
import type { OnlineProvider } from "../../../src/data/payIntents";

export type PayCreds = Record<string, string>;

export interface PaymentLinkInput {
  /** Наш номер счёта у провайдера (pg_order_id / InvoiceId) — по нему найдём счёт в уведомлении. */
  invoiceId: string;
  amount: number;
  description: string;
  /** Куда провайдер шлёт уведомление (Freedom Pay берёт его из запроса). */
  resultUrl: string;
  /** Куда вернуть клиента после оплаты. */
  successUrl?: string;
  lifetimeSeconds: number;
}

export interface PayWebhookInput {
  body: string;
  contentType: string;
  headers: Headers;
  /** Путь адреса уведомления — Freedom Pay подписывает его последнюю часть. */
  path: string;
}

export interface PayNotice {
  invoiceId: string;
  externalId?: string;
  /** pending — уведомление не об итоге (двухстадийная авторизация, возврат и т.п.): счёт не меняем. */
  status: "paid" | "failed" | "pending";
  amount: number;
  currency: string;
}

export interface PayReply {
  status: number;
  body: string;
  contentType: string;
}

export type PayWebhookResult =
  | {
      ok: true;
      notice: PayNotice;
      /** Ответ провайдеру; accepted=false — отказаться от платежа, если провайдер это позволяет (Freedom Pay pg_can_reject). */
      reply(accepted: boolean): PayReply;
    }
  | { ok: false; status: number; why: string };

export interface PayAdapter {
  provider: OnlineProvider;
  createPaymentLink(creds: PayCreds, input: PaymentLinkInput): Promise<{ url: string; externalId?: string }>;
  verifyWebhook(creds: PayCreds, input: PayWebhookInput): Promise<PayWebhookResult>;
}

/** Сумма из уведомления: «15000.00» → 15000; мусор — NaN. */
export const amountOf = (raw: string | undefined): number => (raw && /^\d+(\.\d{1,2})?$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
