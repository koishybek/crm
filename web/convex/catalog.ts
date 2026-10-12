// Справочник направлений и услуг. Пустая база → значения по умолчанию из src/data/catalog.ts;
// первая правка владельца переносит их в базу, дальше источник истины — таблицы.
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { currentUser, OWNER, requireRole } from "./lib/access";
import { CITIES, DEFAULT_CATEGORIES, DEFAULT_SERVICES, type Category, type Service, type ServiceIcon, type Tone } from "../src/data/catalog";

const toCategory = (c: Doc<"categories">): Category => ({ id: c.key, label: c.label, tone: c.tone as Tone, active: c.active });
const toService = (s: Doc<"services">): Service => ({
  id: s.key,
  category: s.category,
  label: s.label,
  icon: s.icon as ServiceIcon,
  price: [s.priceMin, s.priceMax],
  payoutPct: s.payoutPct,
  examples: s.examples,
  active: s.active,
});

export async function loadCatalog(ctx: QueryCtx) {
  const cats = (await ctx.db.query("categories").collect()).sort((a, b) => a.order - b.order);
  const svcs = (await ctx.db.query("services").collect()).sort((a, b) => a.order - b.order);
  const categories = cats.length ? cats.map(toCategory) : DEFAULT_CATEGORIES;
  const services = svcs.length ? svcs.map(toService) : DEFAULT_SERVICES;
  return {
    categories,
    services,
    /** Услуга по ключу или ошибка — для проверки ввода. */
    service(id: string): Service {
      const s = services.find((x) => x.id === id);
      if (!s) throw new ConvexError("Такой услуги нет в справочнике");
      return s;
    },
    /** Подпись без ошибки — для текстов уведомлений по старым заказам. */
    label(id: string): string {
      return services.find((x) => x.id === id)?.label ?? id;
    },
  };
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentUser(ctx))) return null;
    const c = await loadCatalog(ctx);
    return { categories: c.categories, services: c.services };
  },
});

/** Подсказка для AI: активные услуги и города — AI выбирает только из них. */
export const _hint = internalQuery({
  args: {},
  handler: async (ctx) => {
    const c = await loadCatalog(ctx);
    return { services: c.services.filter((s) => s.active !== false).map((s) => ({ id: s.id, label: s.label })), cities: [...CITIES] };
  },
});

export const _categories = internalQuery({
  args: {},
  handler: async (ctx) => (await loadCatalog(ctx)).categories,
});

/** Для публичной формы заявки (/zayavka, без входа): только названия активных направлений и услуг — без цен и ставок. */
export const publicList = query({
  args: {},
  handler: async (ctx): Promise<{ categories: { id: string; label: string }[]; services: { id: string; label: string; category: string }[] }> => {
    const c = await loadCatalog(ctx);
    const categories = c.categories.filter((x) => x.active !== false);
    const open = new Set(categories.map((x) => x.id));
    return {
      categories: categories.map((x) => ({ id: x.id, label: x.label })),
      services: c.services.filter((s) => s.active !== false && open.has(s.category) && s.id !== "other").map((s) => ({ id: s.id, label: s.label, category: s.category })),
    };
  },
});

/** Перенести значения по умолчанию в базу перед первой правкой. */
async function materialize(ctx: MutationCtx) {
  if ((await ctx.db.query("categories").first()) || (await ctx.db.query("services").first())) return;
  for (const [i, c] of DEFAULT_CATEGORIES.entries()) await ctx.db.insert("categories", { key: c.id, label: c.label, tone: c.tone, order: i, active: true });
  for (const [i, s] of DEFAULT_SERVICES.entries()) {
    await ctx.db.insert("services", { key: s.id, category: s.category, label: s.label, icon: s.icon, priceMin: s.price[0], priceMax: s.price[1], payoutPct: s.payoutPct, examples: s.examples, order: i, active: true });
  }
}

const key = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

export const saveCategory = mutation({
  args: { id: v.optional(v.string()), label: v.string(), tone: v.string(), active: v.boolean() },
  handler: async (ctx, a) => {
    await requireRole(ctx, OWNER);
    if (!a.label.trim()) throw new ConvexError("Укажите название направления");
    await materialize(ctx);
    const existing = a.id ? await ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", a.id!)).unique() : null;
    if (existing) {
      await ctx.db.patch(existing._id, { label: a.label.trim(), tone: a.tone, active: a.active });
      return existing.key;
    }
    const k = key("c");
    const count = (await ctx.db.query("categories").collect()).length;
    await ctx.db.insert("categories", { key: k, label: a.label.trim(), tone: a.tone, order: count, active: a.active });
    return k;
  },
});

export const saveService = mutation({
  args: {
    id: v.optional(v.string()),
    category: v.string(),
    label: v.string(),
    icon: v.string(),
    priceMin: v.number(),
    priceMax: v.number(),
    payoutPct: v.number(),
    examples: v.array(v.string()),
    active: v.boolean(),
  },
  handler: async (ctx, a) => {
    await requireRole(ctx, OWNER);
    if (!a.label.trim()) throw new ConvexError("Укажите название услуги");
    if (a.priceMin < 0 || a.priceMax < a.priceMin) throw new ConvexError("Проверьте диапазон цены: «от» не больше «до»");
    if (a.payoutPct <= 0 || a.payoutPct > 100) throw new ConvexError("Доля исполнителя — от 1 до 100%");
    await materialize(ctx);
    if (!(await ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", a.category)).unique())) throw new ConvexError("Направление не найдено");
    const fields = {
      category: a.category,
      label: a.label.trim(),
      icon: a.icon,
      priceMin: Math.round(a.priceMin),
      priceMax: Math.round(a.priceMax),
      payoutPct: a.payoutPct,
      examples: a.examples.map((x) => x.trim()).filter(Boolean).slice(0, 6),
      active: a.active,
    };
    const existing = a.id ? await ctx.db.query("services").withIndex("by_key", (q) => q.eq("key", a.id!)).unique() : null;
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing.key;
    }
    const k = key("s");
    const count = (await ctx.db.query("services").collect()).length;
    await ctx.db.insert("services", { key: k, order: count, ...fields });
    return k;
  },
});

