// Онлайн-оплата заказа (ТЗ п.19.7, п.23.5): провайдеры, статусы счёта и переходы между ними.
// Общие для сервера (convex/payments.ts, convex/lib/pay/*) и экранов (карточка заказа, «Настройки → Онлайн-оплата»).
import type { Tone } from "./catalog";

export const PAY_PROVIDERS = ["freedompay", "cloudpayments", "kaspi"] as const;
export type PayProvider = (typeof PAY_PROVIDERS)[number];
/** Провайдеры с API и уведомлениями об оплате; Kaspi — ссылка магазина, оплату отмечает сотрудник. */
export const ONLINE_PROVIDERS = ["freedompay", "cloudpayments"] as const;
export type OnlineProvider = (typeof ONLINE_PROVIDERS)[number];
export const isOnlineProvider = (x: string): x is OnlineProvider => (ONLINE_PROVIDERS as readonly string[]).includes(x);

export interface PayField {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  /** Выбор из списка (значение — первое по умолчанию). */
  options?: { value: string; label: string }[];
}

export interface PayProviderInfo {
  label: string;
  docs: string;
  fields: PayField[];
  steps: string[];
}

/** API CloudPayments: адрес из документации (.ru); для казахстанского кабинета — тот, что указан в его документации. */
export const CLOUDPAYMENTS_HOSTS = ["https://api.cloudpayments.ru", "https://api.cloudpayments.kz"] as const;

export const PAY_INFO: Record<PayProvider, PayProviderInfo> = {
  freedompay: {
    label: "Freedom Pay",
    docs: "https://docs.freedompay.kz/",
    fields: [
      { key: "merchantId", label: "ID магазина (pg_merchant_id)", secret: false, placeholder: "123456" },
      { key: "secretKey", label: "Секретный ключ для приёма платежей", secret: true },
      { key: "testMode", label: "Режим", secret: false, options: [{ value: "0", label: "Боевой" }, { value: "1", label: "Тестовый (деньги не списываются)" }] },
    ],
    steps: [
      "Личный кабинет Freedom Pay → Настройки магазина: скопируйте ID магазина и секретный ключ для приёма платежей.",
      "Адрес для уведомлений (Result URL) передаётся с каждым счётом сам — в кабинете ничего добавлять не нужно; он должен быть доступен из интернета.",
      "Проверьте подключение тестовым счётом в тестовом режиме, затем переключите на «Боевой».",
    ],
  },
  cloudpayments: {
    label: "CloudPayments",
    docs: "https://developers.cloudpayments.ru/",
    fields: [
      { key: "publicId", label: "Public ID", secret: false },
      { key: "apiSecret", label: "Пароль для API (API Secret)", secret: true },
      { key: "apiHost", label: "Адрес API", secret: false, options: CLOUDPAYMENTS_HOSTS.map((h) => ({ value: h, label: h.replace("https://", "") })) },
    ],
    steps: [
      "Личный кабинет CloudPayments → Сайты → Настройки: скопируйте Public ID и пароль для API.",
      "Там же, «Уведомления»: в Pay и Fail укажите «Адрес для уведомлений» ниже, метод POST, кодировка UTF-8.",
      "Валюта счетов — тенге (KZT): если кабинет открыт не в Казахстане, попросите поддержку CloudPayments включить KZT.",
    ],
  },
  kaspi: {
    label: "Kaspi (ссылка магазина)",
    docs: "https://kaspi.kz/merchantcabinet/",
    fields: [{ key: "template", label: "Ссылка на оплату", secret: false, placeholder: "https://pay.kaspi.kz/pay/…?amount={amount}" }],
    steps: [
      "Открытого API у Kaspi нет: клиент платит по ссылке или QR вашего магазина Kaspi, а оплату отмечает сотрудник («Внести оплату» → Kaspi).",
      "Kaspi Pay → «Выставить счёт» / ссылка на оплату: вставьте ссылку магазина. {amount} подставит сумму, {order} — номер заказа (если ваша ссылка это поддерживает).",
    ],
  },
};

export type PayIntentStatus = "created" | "paid" | "failed" | "cancelled" | "review";
/** Как показать счёт: «Истёк» — не оплачен до срока ссылки (статус в базе при этом «created»). */
export type PayIntentView = PayIntentStatus | "expired";

export const PAY_INTENT_STATUS: Record<PayIntentView, { label: string; tone: Tone }> = {
  created: { label: "Ждёт оплаты", tone: "amber" },
  paid: { label: "Оплачен", tone: "green" },
  failed: { label: "Оплата не прошла", tone: "red" },
  cancelled: { label: "Отменён", tone: "gray" },
  review: { label: "Нужна проверка", tone: "red" },
  expired: { label: "Срок ссылки истёк", tone: "gray" },
};

/**
 * Что случилось со счётом: paid/failed — уведомление провайдера, cancel — отменил сотрудник, mismatch — сумма или
 * валюта уведомления не совпала со счётом, blocked — деньги пришли, но заказ уже не принимает оплату (отменён, возврат).
 */
export type PayIntentEvent = "paid" | "failed" | "cancel" | "mismatch" | "blocked";

/**
 * Следующий статус счёта; null — ничего не меняется. «Оплачен» и «Нужна проверка» — конечные: повтор уведомления
 * (провайдер шлёт его, пока не получит ответ) ничего не делает. Оплата после отмены или неудачной попытки — принимается:
 * деньги клиента уже списаны.
 */
export function nextIntentStatus(current: PayIntentStatus, event: PayIntentEvent): PayIntentStatus | null {
  if (current === "paid" || current === "review") return null;
  switch (event) {
    case "paid":
      return "paid";
    case "mismatch":
    case "blocked":
      return "review";
    case "failed":
      return current === "created" ? "failed" : null;
    case "cancel":
      return current === "cancelled" ? null : "cancelled";
  }
}

/** Срок ссылки на оплату. */
export const PAY_LINK_TTL_MS = 3 * 24 * 3600_000;

export const intentView = (status: PayIntentStatus, expiresAt: string, now: number): PayIntentView => (status === "created" && Date.parse(expiresAt) < now ? "expired" : status);

/** Шаблон ссылки Kaspi: https на kaspi.kz; {amount} и {order} подставляются. */
export function kaspiTemplateIssue(template: string): string | null {
  let url: URL;
  try {
    url = new URL(template.replace(/\{amount\}|\{order\}/g, "1"));
  } catch {
    return "Ссылка Kaspi указана неверно";
  }
  if (url.protocol !== "https:" || !(url.hostname === "kaspi.kz" || url.hostname.endsWith(".kaspi.kz"))) return "Нужна ссылка https на kaspi.kz";
  return null;
}

export const kaspiLink = (template: string, amount: number, orderNumber: number): string =>
  template.replace(/\{amount\}/g, String(Math.round(amount))).replace(/\{order\}/g, encodeURIComponent(String(orderNumber)));

/** Счёт на оплату в карточке заказа. */
export interface PayIntentInfo {
  id: string;
  provider: PayProvider;
  amount: number;
  status: PayIntentStatus;
  url?: string;
  createdAt: string;
  expiresAt: string;
  sentAt?: string;
  paidAt?: string;
  error?: string;
  reportedAmount?: number;
  createdByName: string;
}

export interface OrderPayView {
  /** Какие способы выставления счёта доступны. */
  providers: PayProvider[];
  intents: PayIntentInfo[];
}

/** Настройки для карточки владельца: секреты не отдаются. */
export interface PaySettingsView {
  provider: OnlineProvider | null;
  config: Record<string, string>;
  hasSecrets: boolean;
  kaspiTemplate: string | null;
  keyIssue: string | null;
  siteUrl: string | null;
  /** Адрес компании — в адресе уведомлений (?c=…): платформа общая, уведомление должно попасть в свою компанию; null — компания по умолчанию. */
  company: string | null;
}

/** Путь уведомлений провайдера: https://<deployment>.convex.site/pay/<провайдер>. */
export const payWebhookPath = (p: OnlineProvider): string => `/pay/${p}`;
