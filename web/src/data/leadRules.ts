// Правила заявки (ТЗ п.7, п.8, п.17): кто её завёл, кто ведёт и какой срок получит заказ из неё.
// Общие для сервера (convex/leads.ts, lib/intake.ts) и экранов заявки.
import { almatyDayStart, DAY_MS } from "./workerTime";
import type { Lead, LeadOrigin, Urgency } from "./types";

/** Кто завёл заявку. Всё, кроме оператора, — канал или AI: такая заявка ждёт, пока оператор возьмёт её в работу. */
export const LEAD_ORIGIN: Record<LeadOrigin, { label: string }> = {
  operator: { label: "Оператор" },
  ai: { label: "AI по звонку" },
  bot: { label: "Telegram-бот" },
  site: { label: "Сайт" },
  api: { label: "API" },
  whatsapp: { label: "WhatsApp" },
  olx: { label: "OLX" },
};

/** Заявка открыта — её ещё можно вести: не стала заказом и не закрыта отказом. */
export const isOpenLead = (l: Pick<Lead, "status">): boolean => l.status !== "converted" && l.status !== "rejected";

/** Заявка ждёт оператора: пришла из канала и её ещё никто не взял в работу. */
export const awaitsOperator = (l: Pick<Lead, "status" | "operatorId">): boolean => isOpenLead(l) && !l.operatorId;

const HOUR_MS = 3600_000;

/**
 * Срок нового заказа по срочности заявки (E27), по Алматы: «Срочно» — через 4 часа, «Высокая» — завтра к 12:00,
 * обычная — послезавтра к 12:00. Удобное клиенту время оператор видит подсказкой и при необходимости правит срок.
 */
export function deadlineByUrgency(urgency: Urgency, now: number): string {
  if (urgency === "urgent") return new Date(now + 4 * HOUR_MS).toISOString();
  const days = urgency === "high" ? 1 : 2;
  return new Date(almatyDayStart(now) + days * DAY_MS + 12 * HOUR_MS).toISOString();
}
