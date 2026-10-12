import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query } from "./_generated/server";
import { requireRole, scopeOf, TEAM } from "./lib/access";
import { nowIso, TENANT } from "./lib/domain";
import { toExecutor, toOrder, toUser } from "./lib/dto";
import { normalizeLogin } from "./lib/login";
import { createLogin } from "./users";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import { category } from "./schema";

/** Исполнители + их активные заказы (только статус — чтобы посчитать «свободен / на выезде»). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const executors = (await ctx.db.query("executors").collect()).filter((e) => !scope || e.categories.some((c) => scope.includes(c)));
    const ids = new Set<string>(executors.map((e) => e._id));
    const load: { executorId: string; status: Doc<"orders">["status"] }[] = [];
    for (const s of ACTIVE_STATUSES) {
      for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()) {
        if (o.executorId && ids.has(o.executorId)) load.push({ executorId: o.executorId, status: o.status });
      }
    }
    return { executors: executors.map(toExecutor), load };
  },
});

export const detail = query({
  args: { id: v.id("executors") },
  handler: async (ctx, { id }) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const e = await ctx.db.get(id);
    if (!e || (scope && !e.categories.some((c) => scope.includes(c)))) return null;
    const orders = await ctx.db.query("orders").withIndex("by_executor", (q) => q.eq("executorId", id)).collect();
    const user = await ctx.db.query("users").withIndex("by_executor", (q) => q.eq("executorId", id)).first();
    return { executor: toExecutor(e), orders: orders.map(toOrder), user: user ? toUser(user) : null };
  },
});

const fields = {
  name: v.string(),
  phone: v.string(),
  city: v.string(),
  categories: v.array(category),
  skills: v.array(v.string()),
  cooperation: v.union(v.literal("freelance"), v.literal("staff")),
};

export const _insert = internalMutation({
  args: fields,
  handler: async (ctx, a) => {
    const phone = normalizeLogin(a.phone);
    if (await ctx.db.query("executors").withIndex("by_phone", (q) => q.eq("phone", phone)).first()) throw new ConvexError("Исполнитель с таким телефоном уже есть");
    if (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", phone)).unique()) throw new ConvexError("Этот телефон уже используется как логин");
    const id = await ctx.db.insert("executors", { ...a, name: a.name.trim(), phone, tenantId: TENANT, available: true, rating: 5, reviews: 0, joinedAt: nowIso() });
    await ctx.db.insert("users", { name: a.name.trim(), email: phone, phone, role: "executor", executorId: id, tenantId: TENANT, active: true });
    return id;
  },
});

/** Новый исполнитель: профиль + логин (его телефон) + временный пароль — показать один раз. */
export const create = action({
  args: fields,
  handler: async (ctx, a): Promise<{ id: Id<"executors">; login: string; password: string }> => {
    const role = await ctx.runQuery(internal.users._viewerRole, {});
    if (role !== "owner" && role !== "operator") throw new ConvexError("Нет доступа");
    const phone = normalizeLogin(a.phone);
    if (!a.name.trim()) throw new ConvexError("Укажите имя");
    if (!/^7\d{10}$/.test(phone)) throw new ConvexError("Укажите телефон полностью");
    if (!a.categories.length) throw new ConvexError("Выберите хотя бы одну специализацию");
    const id = await ctx.runMutation(internal.executors._insert, { ...a, phone });
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    const password = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join("");
    await createLogin(ctx, phone, password);
    return { id, login: phone, password };
  },
});

export const update = mutation({
  args: { id: v.id("executors"), ...fields },
  handler: async (ctx, { id, ...a }) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const e = await ctx.db.get(id);
    if (e && scope && !e.categories.some((c) => scope.includes(c))) throw new ConvexError("Это не ваше направление");
    if (!e) throw new ConvexError("Исполнитель не найден");
    if (!a.categories.length) throw new ConvexError("Выберите хотя бы одну специализацию");
    // Телефон — это логин; менять его здесь нельзя, чтобы не сломать вход.
    await ctx.db.patch(id, { name: a.name.trim() || e.name, city: a.city, categories: a.categories, skills: a.skills.map((s) => s.trim()).filter(Boolean), cooperation: a.cooperation });
    const u = await ctx.db.query("users").withIndex("by_executor", (q) => q.eq("executorId", id)).first();
    if (u && a.name.trim()) await ctx.db.patch(u._id, { name: a.name.trim() });
  },
});

export const setAvailable = mutation({
  args: { id: v.id("executors"), available: v.boolean() },
  handler: async (ctx, { id, available }) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const e = await ctx.db.get(id);
    if (!e || (scope && !e.categories.some((c) => scope.includes(c)))) throw new ConvexError("Это не ваше направление");
    await ctx.db.patch(id, { available });
  },
});
