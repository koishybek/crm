// Справочник направлений и услуг. Пустая база → значения по умолчанию из src/data/catalog.ts (цены и доли — только
// на сервере, lib/defaultPrices.ts); первая правка владельца переносит их в базу, дальше источник истины — таблицы.
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { currentUser, OWNER, requireRole } from "./lib/access";
import { audit, ChangeLog, listDiffText, quote } from "./lib/audit";
import { withDefaultPrices } from "./lib/defaultPrices";
import { cleanMoney, cleanText } from "./lib/limits";
import { CITIES, DEFAULT_CATEGORIES, DEFAULT_SERVICES, type Category, type Service, type ServiceIcon, type ServiceInfo, type Tone } from "../src/data/catalog";
import { normalizeSkills, skillsDiff, SKILLS_PER_CATEGORY } from "../src/data/skills";
import { money } from "../src/lib/format";

/**
 * Навыки направления. Строки, сохранённые до появления навыков (поля нет), получают навыки по умолчанию;
 * пустой список — осознанный выбор владельца, его не трогаем.
 */
const skillsOf = (c: Doc<"categories">): string[] => c.skills ?? DEFAULT_CATEGORIES.find((d) => d.id === c.key)?.skills ?? [];
const toCategory = (c: Doc<"categories">): Category => ({ id: c.key, label: c.label, tone: c.tone as Tone, active: c.active, skills: skillsOf(c) });
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
  const services = svcs.length ? svcs.map(toService) : withDefaultPrices(DEFAULT_SERVICES);
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

/** Услуга без денег: подпись, значок, направление, примеры. */
const toInfo = ({ price: _p, payoutPct: _q, ...info }: Service): ServiceInfo => (void _p, void _q, info);

/**
 * Справочник для интерфейса. Мастеру — без цен и доли исполнителя (аудит H-2, E14): по доле и своей выплате
 * он вычислил бы цену клиента и маржу. Ему хватает подписей, значков, направлений и навыков.
 */
export const list = query({
  args: {},
  handler: async (ctx): Promise<{ categories: Category[]; services: (Service | ServiceInfo)[] } | null> => {
    const me = await currentUser(ctx);
    if (!me) return null;
    const c = await loadCatalog(ctx);
    return { categories: c.categories, services: me.role === "executor" ? c.services.map(toInfo) : c.services };
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
  for (const [i, c] of DEFAULT_CATEGORIES.entries()) await ctx.db.insert("categories", { key: c.id, label: c.label, tone: c.tone, order: i, active: true, skills: c.skills ?? [] });
  for (const [i, s] of withDefaultPrices(DEFAULT_SERVICES).entries()) {
    await ctx.db.insert("services", { key: s.id, category: s.category, label: s.label, icon: s.icon, priceMin: s.price[0], priceMax: s.price[1], payoutPct: s.payoutPct, examples: s.examples, order: i, active: true });
  }
}

const key = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** skills не передан — навыки направления не меняются (старые вызовы без навыков). */
export const saveCategory = mutation({
  args: { id: v.optional(v.string()), label: v.string(), tone: v.string(), active: v.boolean(), skills: v.optional(v.array(v.string())) },
  handler: async (ctx, a) => {
    const me = await requireRole(ctx, OWNER);
    const label = a.label.trim();
    if (!label) throw new ConvexError("Укажите название направления");
    if (label.length > 60) throw new ConvexError("Название направления — не длиннее 60 символов");
    let skills: string[] | undefined;
    if (a.skills) {
      const r = normalizeSkills(a.skills, SKILLS_PER_CATEGORY);
      if (!r.ok) throw new ConvexError(r.error);
      skills = r.skills;
    }
    await materialize(ctx);
    const existing = a.id ? await ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", a.id!)).unique() : null;
    if (existing) {
      const before = skillsOf(existing);
      const diff = skillsDiff(before, skills ?? before);
      const log = new ChangeLog();
      if (label !== existing.label) log.add(`название ${quote(existing.label)} → ${quote(label)}`, "label", { from: existing.label, to: label });
      if (a.tone !== existing.tone) log.add("цвет", "tone", { from: existing.tone, to: a.tone });
      if (a.active !== existing.active) log.add(a.active ? "снова показывается в формах" : "скрыто из форм", "active", { from: existing.active, to: a.active });
      if (diff.added.length || diff.removed.length) log.add(`навыки: ${listDiffText(diff)}`, "skills", diff);
      // Тот же набор, но другое написание или порядок («чистка» → «Чистка») — тоже правка.
      else if (skills && skills.join("\n") !== before.join("\n")) log.add("навыки: написание и порядок", "skills", { from: before, to: skills });
      // Сохранили без изменений — ни записи, ни шума в журнале.
      if (log.empty) return existing.key;
      // Поле skills кладём только когда его прислали: patch с undefined стёр бы навыки.
      await ctx.db.patch(existing._id, { label, tone: a.tone, active: a.active, ...(skills ? { skills } : {}) });
      await audit(ctx, me, "catalog.category", `Направление «${label}»: ${log.text()}`, { entityId: existing.key, meta: { changes: log.changes } });
      return existing.key;
    }
    const k = key("c");
    const count = (await ctx.db.query("categories").collect()).length;
    await ctx.db.insert("categories", { key: k, label, tone: a.tone, order: count, active: a.active, skills: skills ?? [] });
    await audit(ctx, me, "catalog.category", `Добавлено направление «${label}»${skills?.length ? `, навыков: ${skills.length}` : ""}`, { entityId: k, meta: { skills: skills ?? [] } });
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
    const me = await requireRole(ctx, OWNER);
    const label = cleanText(a.label, 80, "Название услуги");
    if (!label) throw new ConvexError("Укажите название услуги");
    const priceMin = cleanMoney(a.priceMin, "Цена «от»");
    const priceMax = cleanMoney(a.priceMax, "Цена «до»");
    if (priceMax < priceMin) throw new ConvexError("Проверьте диапазон цены: «от» не больше «до»");
    if (!Number.isFinite(a.payoutPct) || a.payoutPct <= 0 || a.payoutPct > 100) throw new ConvexError("Доля исполнителя — от 1 до 100%");
    await materialize(ctx);
    const category = await ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", a.category)).unique();
    if (!category) throw new ConvexError("Направление не найдено");
    const fields = {
      category: a.category,
      label,
      icon: a.icon,
      priceMin,
      priceMax,
      payoutPct: a.payoutPct,
      examples: a.examples.map((x) => cleanText(x, 120, "Пример услуги")).filter(Boolean).slice(0, 6),
      active: a.active,
    };
    const price = (min: number, max: number) => `${money(min)}–${money(max)}`;
    const existing = a.id ? await ctx.db.query("services").withIndex("by_key", (q) => q.eq("key", a.id!)).unique() : null;
    if (existing) {
      // ТЗ п.12: цены и доля исполнителя — деньги компании, в журнале «было → стало».
      const log = new ChangeLog();
      if (fields.label !== existing.label) log.add(`название ${quote(existing.label)} → ${quote(fields.label)}`, "label", { from: existing.label, to: fields.label });
      if (fields.category !== existing.category) {
        const was = (await ctx.db.query("categories").withIndex("by_key", (q) => q.eq("key", existing.category)).unique())?.label ?? existing.category;
        log.add(`направление ${quote(was)} → ${quote(category.label)}`, "category", { from: existing.category, to: fields.category });
      }
      if (fields.priceMin !== existing.priceMin || fields.priceMax !== existing.priceMax) {
        log.add(`цена ${price(existing.priceMin, existing.priceMax)} → ${price(fields.priceMin, fields.priceMax)}`, "price", { from: [existing.priceMin, existing.priceMax], to: [fields.priceMin, fields.priceMax] });
      }
      if (fields.payoutPct !== existing.payoutPct) log.add(`доля исполнителя ${existing.payoutPct}% → ${fields.payoutPct}%`, "payoutPct", { from: existing.payoutPct, to: fields.payoutPct });
      if (fields.icon !== existing.icon) log.add("значок", "icon", { from: existing.icon, to: fields.icon });
      if (fields.examples.join("\n") !== existing.examples.join("\n")) log.add("примеры", "examples", "изменено");
      if (fields.active !== existing.active) log.add(fields.active ? "снова показывается в формах" : "скрыта из форм", "active", { from: existing.active, to: fields.active });
      if (log.empty) return existing.key;
      await ctx.db.patch(existing._id, fields);
      await audit(ctx, me, "catalog.service", `Услуга «${fields.label}»: ${log.text()}`, { entityId: existing.key, meta: { changes: log.changes } });
      return existing.key;
    }
    const k = key("s");
    const count = (await ctx.db.query("services").collect()).length;
    await ctx.db.insert("services", { key: k, order: count, ...fields });
    await audit(ctx, me, "catalog.service", `Добавлена услуга «${fields.label}» (${category.label}): ${price(priceMin, priceMax)}, исполнителю ${fields.payoutPct}%${fields.active ? "" : ", скрыта"}`, {
      entityId: k,
      meta: { category: fields.category, priceMin, priceMax, payoutPct: fields.payoutPct, active: fields.active },
    });
    return k;
  },
});

