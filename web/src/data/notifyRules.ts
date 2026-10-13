// Уведомления наружу (ТЗ п.18, п.19): какие события сотрудник получает копией на email и что пишем клиенту о заказе.
// Общее для сервера (convex/lib/mail.ts, convex/email.ts, convex/clientNotify.ts) и карточек в «Настройках».

/**
 * Важные события, которые дублируются на email. Событие помечает сам вызов notify (opts.email), остальные
 * уведомления — только колокольчик и Telegram.
 */
export type EmailKind = "lead_new" | "order_assigned" | "order_overdue" | "payment" | "low_rating" | "channel_lost";

export const EMAIL_KINDS: Record<EmailKind, { label: string; to: string }> = {
  lead_new: { label: "Новая заявка", to: "владельцу, операторам и руководителю направления" },
  order_assigned: { label: "Мастер взял заказ", to: "владельцу, операторам и руководителю направления" },
  order_overdue: { label: "Просрочка по заказу", to: "владельцу, операторам и руководителю направления" },
  payment: { label: "Оплата по заказу", to: "владельцу" },
  low_rating: { label: "Низкая оценка клиента", to: "владельцу и руководителю направления" },
  channel_lost: { label: "Отключился OLX", to: "владельцу" },
};

/** Карточка «Email» владельца. Ключ API сюда не попадает. */
export interface EmailSettings {
  /** Заданы ключ и отправитель — письма уходят. */
  configured: boolean;
  /** Переменные окружения Convex, которые не заданы или заданы с ошибкой. */
  missing: string[];
  from?: string;
  replyTo?: string;
  /** Тестовый режим: все письма уходят на этот адрес, а не сотрудникам. */
  redirectTo?: string;
  /** Кто включил «Дублировать на email» и может получать письма. */
  subscribers: string[];
  health?: { okAt?: string; okNote?: string; errorAt?: string; error?: string };
}

/** Переключатель «Дублировать на email» в меню профиля. */
export interface MyEmail {
  /** Владелец настроил отправку писем. */
  configured: boolean;
  /** Логин — email: письма есть куда отправлять (мастера и часть сотрудников входят по телефону). */
  canUse: boolean;
  on: boolean;
}

/** События заказа, о которых пишем клиенту в его канал. */
export type ClientNoticeEvent = "master" | "done" | "cancelled";

/** Как событие называется в истории заказа и в журнале. */
export const CLIENT_NOTICE_LABEL: Record<ClientNoticeEvent, string> = {
  master: "мастер и время приезда",
  done: "работа выполнена, просьба оценить",
  cancelled: "заказ отменён",
};

/** Карточка «Уведомления клиентам» владельца. */
export interface ClientNotifySettings {
  enabled: boolean;
  /** В какие каналы сейчас можно писать (подключены на сервере). */
  channels: { telegram: boolean; whatsapp: boolean; olx: boolean };
}
