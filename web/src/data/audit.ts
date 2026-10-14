// Журнал действий: подписи, правила доступа к «Истории» и поиск — общие для сервера (convex/audit.ts)
// и интерфейса, чтобы правило «кто что видит» было записано один раз.
import { ROLE_LABEL } from "./catalog";
import { textKey } from "./skills";
import type { AuditEntity, AuditEntry, Role } from "./types";

/** Автоматические авторы записей: действовал не сотрудник, а система, AI или канал. */
export const AUDIT_SYSTEM_ACTORS = ["Система", "AI", "Telegram", "WhatsApp", "OLX", "Сайт", "API", "АТС", "Платформа"] as const;
export type SystemActor = (typeof AUDIT_SYSTEM_ACTORS)[number];
export const isSystemActor = (s: string): s is SystemActor => (AUDIT_SYSTEM_ACTORS as readonly string[]).includes(s);

/** Роль автора на момент действия; у системы, AI и каналов — «автоматически» (экран журнала и выгрузка). */
export function auditRoleLabel(w: Pick<AuditEntry, "actorId" | "actorName" | "actorRole">): string {
  if (!w.actorId && isSystemActor(w.actorName)) return "автоматически";
  const role = w.actorRole;
  return role !== undefined && Object.prototype.hasOwnProperty.call(ROLE_LABEL, role) ? ROLE_LABEL[role as Role] : "сотрудник";
}

/** Типы объектов журнала: «one» — подпись ссылки на объект, «many» — пункт фильтра. */
export const AUDIT_ENTITY: Record<AuditEntity, { one: string; many: string }> = {
  lead: { one: "Заявка", many: "Заявки" },
  order: { one: "Заказ", many: "Заказы" },
  client: { one: "Клиент", many: "Клиенты" },
  executor: { one: "Исполнитель", many: "Исполнители" },
  user: { one: "Доступ", many: "Сотрудники и доступы" },
  catalog: { one: "Справочник", many: "Справочник услуг" },
  settings: { one: "Настройки", many: "Настройки" },
  integration: { one: "Интеграция", many: "Интеграции" },
  call: { one: "Звонок", many: "Звонки" },
  conversation: { one: "Переписка", many: "Переписка" },
  review: { one: "Отзыв", many: "Отзывы" },
  system: { one: "Система", many: "Система и импорт" },
  export: { one: "Выгрузка", many: "Выгрузки" },
};
export const AUDIT_ENTITIES = Object.keys(AUDIT_ENTITY) as AuditEntity[];

/**
 * Чью «Историю» какая роль читает. Владелец — всё. Оператор — то, с чем работает каждый день.
 * Руководитель направления — только заявки и заказы (сервер дополнительно проверяет его направление).
 * Исполнитель журнала не видит.
 */
const HISTORY_ACCESS: Record<Role, readonly AuditEntity[] | "all"> = {
  owner: "all",
  operator: ["lead", "order", "client", "executor", "call"],
  manager: ["lead", "order"],
  executor: [],
};

export function canSeeEntityHistory(role: Role, entity: AuditEntity): boolean {
  const allowed = HISTORY_ACCESS[role];
  return allowed === "all" || allowed.includes(entity);
}

/** Ключ поиска по журналу: регистр, «ё/е», знак «№» и лишние пробелы не важны — «заказ 1001» найдёт «Заказ №1001». */
export function auditSearchKey(s: string): string {
  return textKey(s).replace(/№\s*/g, "");
}

/** Самый длинный поисковый запрос по журналу. */
export const AUDIT_QUERY_MAX = 100;
