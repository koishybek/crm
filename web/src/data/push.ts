// Уведомления на телефон (web push, ТЗ п.23.6): общие правила для браузера и сервера (convex/push.ts).
import { APP_NAME } from "./catalog";

/** Что получает service worker (public/sw.js) в событии push. */
export interface PushMessage {
  title: string;
  body: string;
  /** Путь внутри приложения («/orders/…», «/w/orders/…»); только относительный. */
  link?: string;
}

/** Текст уведомления на экране телефона — до 600 символов: длиннее система всё равно обрежет. */
export const PUSH_BODY_MAX = 600;

/** Сообщение для push: заголовок — название компании, ссылка — только путь внутри приложения (без внешних адресов). */
export function pushMessage(text: string, link?: string): PushMessage {
  const body = text.replace(/\s+/g, " ").trim();
  const safe = link && link.startsWith("/") && !link.startsWith("//") ? link : undefined;
  return { title: APP_NAME, body: body.length > PUSH_BODY_MAX ? `${body.slice(0, PUSH_BODY_MAX - 1)}…` : body, ...(safe ? { link: safe } : {}) };
}

/** Состояние для переключателя «Уведомления на телефон». */
export interface PushState {
  /** Владелец задал ключи VAPID. */
  configured: boolean;
  publicKey?: string;
  /** Эта подписка (endpoint браузера) есть на сервере. */
  subscribed: boolean;
}
