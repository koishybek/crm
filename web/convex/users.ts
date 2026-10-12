import { createAccount, invalidateSessions, modifyAccountCredentials } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./_generated/server";
import { currentUser, OWNER, requireRole } from "./lib/access";
import { TENANT } from "./lib/domain";
import { toExecutor, toUser } from "./lib/dto";
import { normalizeLogin } from "./lib/login";
import { role } from "./schema";

/** Текущий пользователь (или null, если не вошёл / доступ отключён). */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const u = await currentUser(ctx);
    return u ? toUser(u) : null;
  },
});

/** Справочник команды для подписей: сотрудники + исполнители. Исполнителю — только имена коллег. */
export const team = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) return null;
    const users = (await ctx.db.query("users").collect()).filter((u) => u.role);
    const executors = await ctx.db.query("executors").collect();
    if (me.role === "executor") {
      return { users: users.map((u) => ({ ...toUser(u), email: "", phone: "" })), executors: executors.filter((e) => e._id === me.executorId).map(toExecutor) };
    }
    return { users: users.map(toUser), executors: executors.map(toExecutor) };
  },
});

function tempPassword(): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => a[b % a.length]).join("");
}

export const _viewerRole = internalQuery({
  args: {},
  handler: async (ctx) => (await currentUser(ctx))?.role ?? null,
});

export const _insertUser = internalMutation({
  args: { name: v.string(), login: v.string(), phone: v.optional(v.string()), role, executorId: v.optional(v.id("executors")), categories: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => {
    const exists = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", a.login))
      .unique();
    if (exists) throw new ConvexError("Такой логин уже занят");
    return ctx.db.insert("users", { name: a.name, email: a.login, phone: a.phone, role: a.role, executorId: a.executorId, categories: a.categories, tenantId: TENANT, active: true });
  },
});

/** Создать логин с паролем для уже существующего пользователя (общий шаг для сотрудников и исполнителей). */
export async function createLogin(ctx: ActionCtx, login: string, password: string) {
  await createAccount(ctx as unknown as Parameters<typeof createAccount>[0], { provider: "password", account: { id: login, secret: password }, profile: { email: login } });
}

/** Владелец добавляет оператора или второго владельца. Возвращает временный пароль — показать один раз. */
export const createStaff = action({
  args: { name: v.string(), login: v.string(), role: v.union(v.literal("owner"), v.literal("operator"), v.literal("manager")), categories: v.optional(v.array(v.string())), password: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ login: string; password: string }> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    const login = normalizeLogin(a.login);
    if (!a.name.trim() || !login) throw new ConvexError("Укажите имя и логин");
    if (a.role === "manager" && !a.categories?.length) throw new ConvexError("Выберите направления руководителя");
    const password = a.password && a.password.length >= 8 ? a.password : tempPassword();
    await ctx.runMutation(internal.users._insertUser, { name: a.name.trim(), login, role: a.role, categories: a.role === "manager" ? a.categories : undefined, phone: login.includes("@") ? undefined : login });
    await createLogin(ctx, login, password);
    return { login, password };
  },
});

export const _userLogin = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => (await ctx.db.get(userId))?.email ?? null,
});

/** Владелец сбрасывает пароль сотруднику или исполнителю; старые сессии закрываются. */
export const resetPassword = action({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<{ login: string; password: string }> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    const login = await ctx.runQuery(internal.users._userLogin, { userId });
    if (!login) throw new ConvexError("Пользователь не найден");
    const password = tempPassword();
    try {
      await modifyAccountCredentials(ctx, { provider: "password", account: { id: login, secret: password } });
    } catch {
      await createLogin(ctx, login, password);
    }
    await invalidateSessions(ctx, { userId: userId as Id<"users"> });
    return { login, password };
  },
});

/** Отключить/включить доступ (уволился, временно не работает). */
export const setActive = mutation({
  args: { userId: v.id("users"), active: v.boolean() },
  handler: async (ctx, { userId, active }) => {
    const me = await requireRole(ctx, OWNER);
    if (userId === me._id) throw new ConvexError("Себя отключить нельзя");
    await ctx.db.patch(userId, { active });
  },
});
