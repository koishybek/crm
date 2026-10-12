// Оформление сообщений Telegram: карточки заказов для мастеров и кнопки действий по статусу.
import type { OrderStatus } from "../../src/data/types";
import { money } from "../../src/lib/format";

export type TgButton = { text: string; data?: string; url?: string };

/** Текст пользователя в HTML-сообщении Telegram — экранируем. */
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const MONTHS = ["янв.", "фев.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const ALMATY_MS = 5 * 3600_000; // сервер в UTC, люди — в Алматы (UTC+5)
const pad = (n: number) => String(n).padStart(2, "0");

/** «Сегодня, 14:00» / «Завтра, 10:00» / «15 окт., 12:00» по времени Алматы. */
export function whenAlmaty(iso: string, now = Date.now()): string {
  const d = new Date(Date.parse(iso) + ALMATY_MS);
  const today = new Date(now + ALMATY_MS);
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const diff = Math.round((day(d) - day(today)) / 86400_000);
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (diff === 0) return `Сегодня, ${time}`;
  if (diff === 1) return `Завтра, ${time}`;
  if (diff === -1) return `Вчера, ${time}`;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${time}`;
}

/** Начало текущих суток по Алматы (в UTC-мс). */
export function almatyDayStart(now = Date.now()): number {
  const t = new Date(now + ALMATY_MS);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - ALMATY_MS;
}

export interface CardData {
  id: string;
  number: number;
  service: string;
  city: string;
  deadline: string;
  payout: number;
  description: string;
  status: OrderStatus;
  urgent?: boolean;
  address?: string;
  clientName?: string;
  clientPhone?: string;
}

const STATUS_LINE: Partial<Record<OrderStatus, string>> = {
  assigned: "🟦 Вам назначен — подтвердите",
  accepted: "🟩 Заказ ваш",
  in_progress: "🟧 В работе",
  awaiting_client: "⏸ Ждём клиента / деталь",
  done: "✅ Работа сдана",
  awaiting_payment: "✅ Работа сдана",
  paid: "✅ Работа сдана",
  closed: "✅ Закрыт",
  cancelled: "⛔ Отменён",
};

const phone = (p: string) => (/^7\d{10}$/.test(p) ? `+7 ${p.slice(1, 4)} ${p.slice(4, 7)} ${p.slice(7, 9)} ${p.slice(9)}` : p);

/** Карточка заказа для мастера. Контакты клиента — только когда заказ уже его. */
export function cardHtml(o: CardData, header?: string): string {
  const lines = [
    `<b>${esc(header ?? `Заказ №${o.number}`)}</b>${o.urgent ? " · 🔥 срочно" : ""}`,
    `${esc(o.service)} · ${esc(o.city)}`,
    `🗓 Срок: ${esc(whenAlmaty(o.deadline))}`,
    `💰 Вам: <b>${esc(money(o.payout))}</b>`,
  ];
  const status = STATUS_LINE[o.status];
  if (status && o.status !== "awaiting_executor") lines.push(status);
  if (o.description) lines.push("", `<i>${esc(o.description.slice(0, 500))}</i>`);
  if (o.address || o.clientPhone) {
    lines.push("");
    if (o.address) lines.push(`📍 ${esc(o.city)}, ${esc(o.address)}`);
    if (o.clientName || o.clientPhone) lines.push(`👤 ${esc(o.clientName ?? "Клиент")}${o.clientPhone ? ` · ${esc(phone(o.clientPhone))}` : ""}`);
  }
  return lines.join("\n");
}

/** Кнопки следующего шага для мастера — те же переходы, что в кабинете. */
export function workerButtons(status: OrderStatus, id: string, appUrl?: string): TgButton[][] {
  const rows: TgButton[][] = [];
  if (status === "awaiting_executor") rows.push([{ text: "✋ Взять заказ", data: `take:${id}` }]);
  if (status === "assigned") rows.push([{ text: "✅ Подтвердить", data: `act:accept:${id}` }, { text: "✖️ Отказаться", data: `act:decline:${id}` }]);
  if (status === "accepted") rows.push([{ text: "▶️ Начать работу", data: `act:start:${id}` }], [{ text: "✖️ Отказаться", data: `act:decline:${id}` }]);
  if (status === "in_progress") rows.push([{ text: "✅ Работа выполнена", data: `act:done:${id}` }], [{ text: "⏸ Жду клиента / деталь", data: `act:wait:${id}` }]);
  if (status === "awaiting_client") rows.push([{ text: "▶️ Продолжить работу", data: `act:resume:${id}` }], [{ text: "✅ Работа выполнена", data: `act:done:${id}` }]);
  if (appUrl && status !== "awaiting_executor") rows.push([{ text: "Открыть в CRM", url: `${appUrl.replace(/\/$/, "")}/w/orders/${id}` }]);
  return rows;
}
