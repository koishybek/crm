import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { currentUser, requireRole, scopeOf, TEAM } from "./lib/access";
import { audit, ChangeLog, listDiff, listDiffText, quote } from "./lib/audit";
import { nowIso, TENANT } from "./lib/domain";
import { toExecutor, toOrder, toUser } from "./lib/dto";
import { cleanText } from "./lib/limits";
import { normalizeLogin } from "./lib/login";
import { createLogin } from "./users";
import { loadCatalog } from "./catalog";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import { canonicalSkills, catalogSkills, normalizeSkills, skillsDiff, SKILLS_PER_EXECUTOR } from "../src/data/skills";
import { shortName } from "../src/lib/format";
import { category } from "./schema";

const COOPERATION: Record<Doc<"executors">["cooperation"], string> = { freelance: "фрилансер", staff: "в штате" };

/**
 * Навыки мастера: без пустых и повторов, в пределах лимитов; совпавшие со справочником —
 * в его написании («мытье окон» → «Мытьё окон»), свои (не из справочника) — как ввели.
 */
async function cleanExecutorSkills(ctx: QueryCtx, input: readonly string[]): Promise<string[]> {
  const r = normalizeSkills(input, SKILLS_PER_EXECUTOR);
  if (!r.ok) throw new ConvexError(r.error);
  return canonicalSkills(r.skills, catalogSkills((await loadCatalog(ctx)).categories));
}

/** Специализации — только из справочника направлений, без повторов. */
async function cleanCategories(ctx: QueryCtx, input: readonly string[]): Promise<{ keys: string[]; label: (key: string) => string }> {
  const known = (await loadCatalog(ctx)).categories;
  const keys = [...new Set(input)];
  if (!keys.length) throw new ConvexError("Выберите хотя бы одну специализацию");
  if (keys.some((k) => !known.some((c) => c.id === k))) throw new ConvexError("Такого направления нет в справочнике");
  return { keys, label: (key) => known.find((c) => c.id === key)?.label ?? key };
}

/** Текст журнала о смене «на смене / выходной» — один для сотрудника и для самого мастера (worker.setAvailable). */
export const availabilityNote = (name: string, available: boolean): string =>
  available ? `${shortName(name)} — снова на смене` : `${shortName(name)} — выходной, новые заказы не приходят`;

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

/** Профиль + учётка мастера. Вызывают create и импорт из Excel — от имени того, кто их запустил. */
export const _insert = internalMutation({
  args: fields,
  handler: async (ctx, a) => {
    const phone = normalizeLogin(a.phone);
    if (await ctx.db.query("executors").withIndex("by_phone", (q) => q.eq("phone", phone)).first()) throw new ConvexError("Исполнитель с таким телефоном уже есть");
    if (await ctx.db.query("users").withIndex("email", (q) => q.eq("email", phone)).unique()) throw new ConvexError("Этот телефон уже используется как логин");
    const skills = await cleanExecutorSkills(ctx, a.skills);
    const { keys: categories } = await cleanCategories(ctx, a.categories);
    const name = cleanText(a.name, 120, "ФИО");
    const city = cleanText(a.city, 60, "Город");
    if (!name || !city) throw new ConvexError("Укажите имя и город");
    const id = await ctx.db.insert("executors", { ...a, categories, skills, name, city, phone, tenantId: TENANT, available: true, rating: 5, reviews: 0, joinedAt: nowIso() });
    await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: id, tenantId: TENANT, active: true });
    await audit(ctx, (await currentUser(ctx)) ?? "Система", "executor.created", `Добавлен исполнитель ${shortName(name)}${skills.length ? `, навыков: ${skills.length}` : ""}`, {
      entityId: id,
      meta: { categories, skills },
    });
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
    const me = await requireRole(ctx, TEAM);
    const scope = scopeOf(me);
    const e = await ctx.db.get(id);
    if (e && scope && !e.categories.some((c) => scope.includes(c))) throw new ConvexError("Это не ваше направление");
    if (!e) throw new ConvexError("Исполнитель не найден");
    if (!a.categories.length) throw new ConvexError("Выберите хотя бы одну специализацию");
    // Руководитель добавляет и снимает только специализации своего направления: иначе он открыл бы мастеру чужие заказы.
    const touched = [...a.categories.filter((c) => !e.categories.includes(c)), ...e.categories.filter((c) => !a.categories.includes(c))];
    if (scope && touched.some((c) => !scope.includes(c))) throw new ConvexError("Менять можно только специализации своего направления");
    const { keys: categories, label } = await cleanCategories(ctx, a.categories);
    const skills = await cleanExecutorSkills(ctx, a.skills);
    const name = cleanText(a.name, 120, "ФИО") || e.name;
    const city = cleanText(a.city, 60, "Город");
    if (!city) throw new ConvexError("Укажите город");

    const cats = listDiff(e.categories, categories);
    const diff = skillsDiff(e.skills, skills);
    const log = new ChangeLog();
    if (name !== e.name) log.add(`ФИО ${quote(e.name)} → ${quote(name)}`, "name", "изменено");
    if (city !== e.city) log.add(`город ${e.city} → ${city}`, "city", { from: e.city, to: city });
    if (cats.added.length || cats.removed.length) log.add(`специализации ${listDiffText(cats, label)}`, "categories", cats);
    if (a.cooperation !== e.cooperation) log.add(`сотрудничество: ${COOPERATION[e.cooperation]} → ${COOPERATION[a.cooperation]}`, "cooperation", { from: e.cooperation, to: a.cooperation });
    if (diff.added.length || diff.removed.length) log.add(`навыки: ${listDiffText(diff)}`, "skills", diff);
    // Те же навыки, но в написании справочника («мытье окон» → «Мытьё окон») или в другом порядке — тоже сохраняем.
    else if (skills.join("\n") !== e.skills.join("\n")) log.add("навыки: написание и порядок", "skills", { from: e.skills, to: skills });
    // Сохранили без изменений — ни записи, ни шума в журнале.
    if (log.empty) return;

    // Телефон — это логин; менять его здесь нельзя, чтобы не сломать вход.
    await ctx.db.patch(id, { name, city, categories, skills, cooperation: a.cooperation });
    const u = await ctx.db.query("users").withIndex("by_executor", (q) => q.eq("executorId", id)).first();
    if (u && u.name !== name) await ctx.db.patch(u._id, { name });
    await audit(ctx, me, "executor.updated", `Профиль исполнителя ${shortName(name)} изменён: ${log.text()}`, { entityId: id, meta: { changes: log.changes } });
  },
});

export const setAvailable = mutation({
  args: { id: v.id("executors"), available: v.boolean() },
  handler: async (ctx, { id, available }) => {
    const me = await requireRole(ctx, TEAM);
    const scope = scopeOf(me);
    const e = await ctx.db.get(id);
    if (!e || (scope && !e.categories.some((c) => scope.includes(c)))) throw new ConvexError("Это не ваше направление");
    if (e.available === available) return;
    await ctx.db.patch(id, { available });
    await audit(ctx, me, "executor.availability", availabilityNote(e.name, available), { entityId: id, meta: { available } });
  },
});
