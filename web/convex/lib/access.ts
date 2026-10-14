import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { can as hasPermission, PERMISSION_INFO, type Permission, type PermissionHolder } from "../../src/data/permissions";
import type { Role } from "../../src/data/types";

export type Me = Doc<"users"> & { role: Role };

/** Вошедший и не отключённый пользователь — даже с временным паролем. Только для users.me (экран «Смените пароль»). */
export async function signedInUser(ctx: QueryCtx): Promise<Me | null> {
  const id = await getAuthUserId(ctx);
  if (!id) return null;
  const user = await ctx.db.get(id);
  if (!user || !user.role || user.active === false) return null;
  return user as Me;
}

/**
 * Текущий пользователь или null (не вошёл / отключён / ещё не сменил временный пароль). Временный пароль знает тот,
 * кто его выдал, поэтому до смены — ни данных, ни действий (аудит M-8): работает только users.changeMyPassword.
 */
export async function currentUser(ctx: QueryCtx): Promise<Me | null> {
  const user = await signedInUser(ctx);
  return user && !user.mustChangePassword ? user : null;
}

/** Грубая проверка доступа по роли (RBAC). Проверки «свой/чужой» — в самих функциях. */
export async function requireRole(ctx: QueryCtx, roles: Role[]): Promise<Me> {
  const me = await signedInUser(ctx);
  if (!me) throw new ConvexError("Нужно войти");
  if (me.mustChangePassword) throw new ConvexError("Сначала смените временный пароль");
  if (!roles.includes(me.role)) throw new ConvexError("Нет доступа");
  return me;
}

export const STAFF: Role[] = ["owner", "operator"];
/** Все, кто работает с заказами в CRM: владелец, оператор, руководитель направления. */
export const TEAM: Role[] = ["owner", "operator", "manager"];

/** Направления, которые видит пользователь; null — все (владелец, оператор). */
export const scopeOf = (me: Me): string[] | null => (me.role === "manager" ? (me.categories ?? []) : null);
export const inScope = (scope: string[] | null, category: string) => !scope || scope.includes(category);
export function assertScope(me: Me, category: string) {
  if (!inScope(scopeOf(me), category)) throw new ConvexError("Это не ваше направление");
}
export const OWNER: Role[] = ["owner"];
export const EXECUTOR: Role[] = ["executor"];

/** Право сотрудника поверх роли (ТЗ п.5.12) — та же функция, что в интерфейсе (src/data/permissions.ts). */
export const can = (me: PermissionHolder | null | undefined, p: Permission): boolean => hasPermission(me, p);

/** Роль из roles и право p — иначе понятный отказ: какого права не хватает и кто его выдаёт. */
export async function requirePerm(ctx: QueryCtx, p: Permission, roles: Role[] = TEAM): Promise<Me> {
  const me = await requireRole(ctx, roles);
  if (!can(me, p)) throw new ConvexError(noAccess(p));
  return me;
}

/** Текст отказа по праву. */
export const noAccess = (p: Permission): string => `Нет доступа: «${PERMISSION_INFO[p].label}» — право выдаёт владелец`;
