import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import type { Role } from "../../src/data/types";

export type Me = Doc<"users"> & { role: Role };

/** Текущий пользователь или null (не вошёл / отключён). */
export async function currentUser(ctx: QueryCtx): Promise<Me | null> {
  const id = await getAuthUserId(ctx);
  if (!id) return null;
  const user = await ctx.db.get(id);
  if (!user || !user.role || user.active === false) return null;
  return user as Me;
}

/** Грубая проверка доступа по роли (RBAC). Проверки «свой/чужой» — в самих функциях. */
export async function requireRole(ctx: QueryCtx, roles: Role[]): Promise<Me> {
  const me = await currentUser(ctx);
  if (!me) throw new ConvexError("Нужно войти");
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
