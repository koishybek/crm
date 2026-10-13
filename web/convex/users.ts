import { createAccount, invalidateSessions, modifyAccountCredentials } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./_generated/server";
import { currentUser, OWNER, requireRole, TEAM } from "./lib/access";
import { audit, listDiff, listDiffText } from "./lib/audit";
import { notify, TENANT } from "./lib/domain";
import { toExecutor, toUser } from "./lib/dto";
import { cleanText } from "./lib/limits";
import { normalizeLogin } from "./lib/login";
import { loginEmail } from "./lib/mail";
import { loadCatalog } from "./catalog";
import { role } from "./schema";
import { ROLE_LABEL } from "../src/data/catalog";
import { shortName } from "../src/lib/format";

/** Роли сотрудников, которые назначает владелец. Исполнители заводятся в разделе «Исполнители». */
const staffRole = v.union(v.literal("owner"), v.literal("operator"), v.literal("manager"));

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

/** «Мадина Е. (Оператор)» — кто это, для текста журнала. */
const whoIs = (u: Doc<"users">): string => `${shortName(u.name || u.email || "без имени")}${u.role ? ` (${ROLE_LABEL[u.role]})` : ""}`;

/** Направления руководителя: только из справочника, без повторов. Возвращает и подписи — для текста журнала. */
async function cleanCategories(ctx: QueryCtx, input: readonly string[] | undefined): Promise<{ keys: string[]; label: (key: string) => string }> {
  const known = (await loadCatalog(ctx)).categories;
  const keys = [...new Set(input ?? [])];
  if (keys.some((k) => !known.some((c) => c.id === k))) throw new ConvexError("Такого направления нет в справочнике");
  return { keys, label: (key) => known.find((c) => c.id === key)?.label ?? key };
}

export const _viewerRole = internalQuery({
  args: {},
  handler: async (ctx) => (await currentUser(ctx))?.role ?? null,
});

/** Сотрудник без пароля (пароль — следующим шагом через createLogin). Вызывает createStaff от имени владельца. */
export const _insertUser = internalMutation({
  args: { name: v.string(), login: v.string(), phone: v.optional(v.string()), role, executorId: v.optional(v.id("executors")), categories: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => {
    const exists = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", a.login))
      .unique();
    if (exists) throw new ConvexError("Такой логин уже занят");
    const name = cleanText(a.name, 120, "Имя");
    const { keys, label } = await cleanCategories(ctx, a.categories);
    const categories = a.role === "manager" ? keys : undefined;
    const id = await ctx.db.insert("users", { name, email: a.login, phone: a.phone, role: a.role, executorId: a.executorId, categories, tenantId: TENANT, active: true });
    await audit(ctx, (await currentUser(ctx)) ?? "Система", "user.created", `Добавлен сотрудник ${shortName(name)} — ${ROLE_LABEL[a.role]}${categories?.length ? ` (${categories.map(label).join(", ")})` : ""}`, {
      entityId: id,
      meta: { role: a.role, categories },
    });
    return id;
  },
});

/** Создать логин с паролем для уже существующего пользователя (общий шаг для сотрудников и исполнителей). */
export async function createLogin(ctx: ActionCtx, login: string, password: string) {
  await createAccount(ctx as unknown as Parameters<typeof createAccount>[0], { provider: "password", account: { id: login, secret: password }, profile: { email: login } });
}

/** Владелец добавляет оператора или второго владельца. Возвращает временный пароль — показать один раз. */
export const createStaff = action({
  args: { name: v.string(), login: v.string(), role: staffRole, categories: v.optional(v.array(v.string())), password: v.optional(v.string()) },
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
    // В журнал — только факт сброса: пароль не передаём даже во внутреннюю функцию.
    await ctx.runMutation(internal.users._passwordReset, { userId });
    return { login, password };
  },
});

/** Запись о новом пароле. Автор — владелец, вызвавший resetPassword (его сессия передаётся в мутацию). */
export const _passwordReset = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get(userId);
    await audit(ctx, (await currentUser(ctx)) ?? "Система", "user.password", `Выдан новый пароль: ${u ? whoIs(u) : "пользователь"} — старые входы закрыты`, { entityId: userId });
  },
});

/** Отключить/включить доступ (уволился, временно не работает). */
export const setActive = mutation({
  args: { userId: v.id("users"), active: v.boolean() },
  handler: async (ctx, { userId, active }) => {
    const me = await requireRole(ctx, OWNER);
    if (userId === me._id) throw new ConvexError("Себя отключить нельзя");
    const u = await ctx.db.get(userId);
    if (!u) throw new ConvexError("Пользователь не найден");
    if ((u.active !== false) === active) return;
    await ctx.db.patch(userId, { active });
    await audit(ctx, me, "user.access", `${active ? "Включён" : "Отключён"} доступ: ${whoIs(u)}`, { entityId: userId, meta: { active, role: u.role } });
  },
});

/**
 * Сотрудник сам включает копии важных уведомлений на email (ТЗ п.18) — только себе и только если логин — email.
 * Мастера входят по телефону, им переключатель не показываем.
 */
export const setNotifyEmail = mutation({
  args: { on: v.boolean() },
  handler: async (ctx, { on }) => {
    const me = await requireRole(ctx, TEAM);
    if (on && !loginEmail(me)) throw new ConvexError("Письма приходят на email из логина, а вы входите по телефону");
    if ((me.notifyEmail === true) === on) return;
    await ctx.db.patch(me._id, { notifyEmail: on });
    await audit(ctx, me, "user.notifyEmail", `${whoIs(me)}: копии важных уведомлений на email ${on ? "включены" : "выключены"}`, { entityId: me._id, meta: { notifyEmail: on } });
  },
});

/**
 * Владелец меняет роль сотрудника и направления руководителя (ТЗ п.4, п.5 «Администрирование: роли, права»).
 * Свою роль менять нельзя — так в компании всегда остаётся хотя бы один владелец.
 * Права вступают в силу сразу: каждая функция читает роль из базы при вызове.
 */
export const updateAccess = mutation({
  args: { userId: v.id("users"), role: staffRole, categories: v.optional(v.array(v.string())) },
  handler: async (ctx, { userId, role: next, categories }) => {
    const me = await requireRole(ctx, OWNER);
    if (userId === me._id) throw new ConvexError("Свою роль менять нельзя");
    const u = await ctx.db.get(userId);
    if (!u?.role) throw new ConvexError("Пользователь не найден");
    if (u.role === "executor") throw new ConvexError("Роль исполнителя не меняется — его доступ настраивается в разделе «Исполнители»");
    const { keys, label } = await cleanCategories(ctx, next === "manager" ? categories : []);
    if (next === "manager" && !keys.length) throw new ConvexError("Выберите направления руководителя");
    const before = u.role === "manager" ? (u.categories ?? []) : [];
    const cats = listDiff(before, keys);
    const roleChanged = next !== u.role;
    if (!roleChanged && !cats.added.length && !cats.removed.length) return;

    await ctx.db.patch(userId, { role: next, categories: next === "manager" ? keys : undefined });
    const parts = roleChanged ? [`${ROLE_LABEL[u.role]} → ${ROLE_LABEL[next]}`] : [];
    if (next === "manager") parts.push(`направления: ${roleChanged ? keys.map(label).join(", ") : listDiffText(cats, label)}`);
    await audit(ctx, me, "user.role", `${shortName(u.name || u.email || "без имени")}: ${parts.join("; ")}`, {
      entityId: userId,
      meta: { from: { role: u.role, categories: before }, to: { role: next, categories: keys } },
    });
    await notify(ctx, [userId], `Владелец изменил ваш доступ: ${ROLE_LABEL[next]}${next === "manager" ? ` (${keys.map(label).join(", ")})` : ""}`, { tone: "info" });
  },
});
