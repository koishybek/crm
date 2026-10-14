// Права сотрудников поверх роли (ТЗ п.5.12, п.26.2, п.27.10). Одно правило для сервера (convex/lib/access.ts → can,
// requirePerm, DTO заказа в convex/lib/dto.ts) и интерфейса: что сервер не отдал, интерфейс и не показывает.
import type { OrderStatus, Role } from "./types";

export const PERMISSIONS = [
  "money.view",
  "payments.add",
  "money.payouts",
  "money.edit",
  "clients.view",
  "calls.view",
  "inbox.view",
  "data.export",
  "analytics.view",
  "catalog.edit",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface PermissionInfo {
  label: string;
  hint: string;
  /** Без этого права данное не имеет смысла — снимается вместе с ним. */
  needs?: Permission;
  /** Каким ролям сотрудников право можно выдать (нет — любым). */
  roles?: readonly Role[];
}

export const PERMISSION_INFO: Record<Permission, PermissionInfo> = {
  "money.view": { label: "Цена клиента и оплаты", hint: "Цена заказа, оплаты, долг клиента. Без него суммы в заказах скрыты" },
  "payments.add": { label: "Вносить оплату", hint: "Отметить, что клиент заплатил", needs: "money.view" },
  "money.payouts": { label: "Выплаты мастерам и маржа", hint: "Сумма мастера, ставки, маржа, реестр «Выплаты мастерам»", needs: "money.view" },
  "money.edit": {
    label: "Менять деньги заказа",
    hint: "Цена и выплата в любом статусе, сторно, возвраты, проведение выплат. Без него цену можно поставить только до принятия заказа мастером",
    needs: "money.view",
  },
  "clients.view": { label: "Клиентская база", hint: "Раздел «Клиенты», карточки и поиск клиентов" },
  "calls.view": { label: "Звонки и записи", hint: "Раздел «Звонки», записи разговоров и расшифровки" },
  "inbox.view": { label: "Сообщения клиентов", hint: "Переписка в Telegram, WhatsApp, OLX и с сайта" },
  // Выгрузки не делятся по направлениям — руководителю направления их не выдаём.
  "data.export": { label: "Выгрузка в Excel", hint: "CSV-файлы — только тех данных, которые сотрудник и так видит", roles: ["operator"] },
  "analytics.view": { label: "Аналитика", hint: "Раздел «Аналитика» по своим направлениям; суммы в ней — только с правом «Выплаты мастерам и маржа»" },
  "catalog.edit": { label: "Справочник услуг", hint: "Направления, услуги, цены и доля мастера", needs: "money.payouts" },
};

/** Умолчания по ролям: владелец — всё, мастер — ничего из этого (у него свой кабинет). */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  operator: ["money.view", "payments.add", "clients.view", "calls.view", "inbox.view"],
  // Руководитель видит аналитику своих направлений без денег (ТЗ п.17.10).
  manager: ["analytics.view"],
  executor: [],
};

/** Кто такой «пользователь» для проверки прав: роль и (необязательно) права, заданные владельцем. */
export type PermissionHolder = { role?: Role; permissions?: readonly string[] };

const isPermission = (p: string): p is Permission => (PERMISSIONS as readonly string[]).includes(p);

/**
 * Права пользователя на деле. Владелец — всегда всё (иначе он мог бы запереть сам себя), мастер — ничего.
 * Сотруднику — заданные владельцем, иначе умолчания роли; право без того, от чего оно зависит, не действует.
 */
export function permissionsOf(u: PermissionHolder | null | undefined): Permission[] {
  if (!u?.role) return [];
  if (u.role === "owner") return [...PERMISSIONS];
  if (u.role === "executor") return [];
  const role = u.role;
  const set = new Set<Permission>((u.permissions ? u.permissions.filter(isPermission) : ROLE_PERMISSIONS[role]).filter((p) => permissionFits(p, role)));
  // Зависимости по цепочке (справочник → выплаты → деньги): снимаем, пока что-то снимается.
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of set) {
      const needs = PERMISSION_INFO[p].needs;
      if (needs && !set.has(needs)) {
        set.delete(p);
        changed = true;
      }
    }
  }
  return PERMISSIONS.filter((p) => set.has(p));
}

/** Можно ли выдать право этой роли. */
export const permissionFits = (p: Permission, role: Role): boolean => role === "owner" || (role !== "executor" && (!PERMISSION_INFO[p].roles || PERMISSION_INFO[p].roles.includes(role)));

/** Есть ли у пользователя право. Одна функция для сервера и интерфейса. */
export const can = (u: PermissionHolder | null | undefined, p: Permission): boolean => permissionsOf(u).includes(p);

/** Совпадают ли права с умолчаниями роли — тогда в базе их не храним (роль сменится — права пойдут за ней). */
export function isRoleDefault(role: Role, perms: readonly Permission[]): boolean {
  const def = permissionsOf({ role });
  return def.length === perms.length && def.every((p) => perms.includes(p));
}

/** До принятия мастером цену ставит тот, кто видит деньги; после — только с правом «Менять деньги заказа». */
export const PRICE_OPEN_STATUSES: readonly OrderStatus[] = ["new", "awaiting_executor", "assigned"];

/** Может ли пользователь поменять цену клиента этого заказа. */
export const canEditPrice = (u: PermissionHolder | null | undefined, status: OrderStatus): boolean =>
  can(u, "money.edit") || (can(u, "money.view") && PRICE_OPEN_STATUSES.includes(status));

/**
 * Сводки денег компании — реестр и сводка выплат мастерам, «Выручка и маржа» на «Главной», суммы в «Аналитике»: они
 * не делятся по направлениям, поэтому руководителю направления не показываются даже с правом на выплаты (он видит
 * деньги заказов своих направлений).
 */
export const canSeeCompanyMoney = (u: PermissionHolder | null | undefined): boolean => can(u, "money.payouts") && u?.role !== "manager";

/** Может ли внести оплату клиента. */
export const canAddPayment = (u: PermissionHolder | null | undefined): boolean => can(u, "money.edit") || can(u, "payments.add");
