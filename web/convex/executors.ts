import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { currentUser, OWNER, requireRole, scopeOf, TEAM } from "./lib/access";
import { almatyStamp, audit, ChangeLog, listDiff, listDiffText, quote, type AuditActor } from "./lib/audit";
import { executorUser, notify, nowIso, TENANT } from "./lib/domain";
import { executorFor, orderFor, toUser } from "./lib/dto";
import { executorDistricts } from "./lib/districts";
import { cleanCity, cleanText } from "./lib/limits";
import { normalizeLogin } from "./lib/login";
import { createLogin } from "./users";
import { loadCatalog } from "./catalog";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import { DEFAULT_MAX_ACTIVE } from "../src/data/logic";
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

/** Текст журнала о смене «на смене / выходной / недоступен до …» — один для сотрудника и для самого мастера. */
export function availabilityNote(name: string, available: boolean, until?: string, reason?: string): string {
  if (available) return `${shortName(name)} — снова на смене`;
  const why = reason ? ` (${reason})` : "";
  return until ? `${shortName(name)} — недоступен до ${almatyStamp(until)}${why}, новые заказы не приходят` : `${shortName(name)} — выходной${why}, новые заказы не приходят`;
}

// ── Смена, недоступность и лимит заказов (ТЗ п.14) ──────────────────────────

/** Дольше этого «недоступен до» не ставим: дальше — это уже увольнение или отключение доступа. */
const MAX_UNAVAILABLE_DAYS = 90;
const MAX_ACTIVE_LIMIT = 20;

export const shiftArgs = { available: v.boolean(), until: v.optional(v.string()), reason: v.optional(v.string()) };

/**
 * На смену / выходной / «недоступен до …». Недоступность «до» — выходной с датой возвращения: в этот момент мастер сам
 * возвращается на смену (запланированная задача _backOnShift и проверка крона _restoreShifts). Включили приём раньше —
 * дата снимается. by — кто менял: сам мастер или сотрудник (для журнала).
 */
export async function applyShift(ctx: MutationCtx, ex: Doc<"executors">, a: { available: boolean; until?: string; reason?: string }, actor: AuditActor, by: "executor" | "staff"): Promise<void> {
  let until: string | undefined;
  let reason: string | undefined;
  if (!a.available) {
    reason = a.reason === undefined ? undefined : cleanText(a.reason, 120, "Причина") || undefined;
    if (a.until !== undefined) {
      const t = Date.parse(a.until);
      const now = Date.now();
      if (!Number.isFinite(t) || t <= now + 60_000) throw new ConvexError("Дата возвращения — в будущем");
      if (t > now + MAX_UNAVAILABLE_DAYS * 86400_000) throw new ConvexError(`Недоступность — не дольше ${MAX_UNAVAILABLE_DAYS} дней`);
      until = new Date(t).toISOString();
    }
  }
  if (ex.available === a.available && ex.unavailableUntil === until && ex.unavailableReason === reason) return;
  await ctx.db.patch(ex._id, { available: a.available, unavailableUntil: until, unavailableReason: reason });
  if (until) await ctx.scheduler.runAt(new Date(until), internal.executors._backOnShift, { id: ex._id, until });
  await audit(ctx, actor, "executor.availability", availabilityNote(ex.name, a.available, until, reason), {
    entityId: ex._id,
    meta: { available: a.available, ...(until ? { until } : {}), ...(reason ? { reason } : {}), ...(by === "executor" ? { by } : {}) },
  });
}

/** Недоступность закончилась — снова на смене, мастер узнаёт об этом. Отключённого (уволен) на смену не возвращаем. */
async function backOnShift(ctx: MutationCtx, ex: Doc<"executors">): Promise<boolean> {
  const u = await executorUser(ctx, ex._id);
  if (!u || u.active === false) {
    await ctx.db.patch(ex._id, { unavailableUntil: undefined, unavailableReason: undefined });
    return false;
  }
  await ctx.db.patch(ex._id, { available: true, unavailableUntil: undefined, unavailableReason: undefined });
  await audit(ctx, "Система", "executor.availability", `${shortName(ex.name)} — снова на смене: закончилась недоступность до ${almatyStamp(ex.unavailableUntil ?? nowIso())}`, {
    entityId: ex._id,
    meta: { available: true, auto: true },
  });
  await notify(ctx, [u._id], "Вы снова принимаете заказы: недоступность закончилась. Новые заказы приходят сюда и в Telegram", { link: "/w", tone: "ok" });
  return true;
}

/** Запланированное возвращение на смену. Дату за это время сменили или сняли — ничего не делаем. */
export const _backOnShift = internalMutation({
  args: { id: v.id("executors"), until: v.string() },
  handler: async (ctx, { id, until }): Promise<boolean> => {
    const ex = await ctx.db.get(id);
    if (!ex || ex.available || ex.unavailableUntil !== until) return false;
    return backOnShift(ctx, ex);
  },
});

/** Проверка крона (раз в 5 минут, escalations.run): все, у кого срок недоступности прошёл, — снова на смене. */
export const _restoreShifts = internalMutation({
  args: {},
  handler: async (ctx): Promise<number> => {
    const now = Date.now();
    let restored = 0;
    for (const ex of await ctx.db.query("executors").collect()) {
      if (ex.available || !ex.unavailableUntil || Date.parse(ex.unavailableUntil) > now) continue;
      if (await backOnShift(ctx, ex)) restored++;
    }
    return restored;
  },
});

/** Исполнители + их активные заказы (только статус — чтобы посчитать «свободен / на выезде»). */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const me = await requireRole(ctx, TEAM);
    const scope = scopeOf(me);
    const executors = (await ctx.db.query("executors").collect()).filter((e) => !scope || e.categories.some((c) => scope.includes(c)));
    const ids = new Set<string>(executors.map((e) => e._id));
    const load: { executorId: string; status: Doc<"orders">["status"] }[] = [];
    for (const s of ACTIVE_STATUSES) {
      for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()) {
        if (o.executorId && ids.has(o.executorId)) load.push({ executorId: o.executorId, status: o.status });
      }
    }
    return { executors: executors.map(executorFor(me)), load };
  },
});

export const detail = query({
  args: { id: v.id("executors") },
  handler: async (ctx, { id }) => {
    const me = await requireRole(ctx, TEAM);
    const scope = scopeOf(me);
    const e = await ctx.db.get(id);
    if (!e || (scope && !e.categories.some((c) => scope.includes(c)))) return null;
    const orders = await ctx.db.query("orders").withIndex("by_executor", (q) => q.eq("executorId", id)).collect();
    const user = await ctx.db.query("users").withIndex("by_executor", (q) => q.eq("executorId", id)).first();
    return { executor: executorFor(me)(e), orders: orders.map(orderFor(me)), user: user ? toUser(user) : null };
  },
});

const fields = {
  name: v.string(),
  phone: v.string(),
  city: v.string(),
  categories: v.array(category),
  skills: v.array(v.string()),
  cooperation: v.union(v.literal("freelance"), v.literal("staff")),
  /** Районы города, где мастер берёт заказы (ТЗ п.12.3); пусто — весь город. Не передан — без изменений. */
  districts: v.optional(v.array(v.string())),
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
    if (!name) throw new ConvexError("Укажите имя и город");
    const city = cleanCity(a.city);
    const districts = await executorDistricts(ctx, city, a.districts);
    const id = await ctx.db.insert("executors", {
      ...a,
      categories,
      skills,
      name,
      city,
      phone,
      districts: districts.length ? districts : undefined,
      tenantId: TENANT,
      available: true,
      rating: 5,
      reviews: 0,
      joinedAt: nowIso(),
    });
    // Пароль выдаёт сотрудник (создание или импорт) — он временный: при первом входе мастер задаёт свой (аудит M-8).
    await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: id, tenantId: TENANT, active: true, mustChangePassword: true });
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
    const city = cleanCity(a.city);
    // Сменили город — прежние районы к нему не относятся; те же районы того же города не перепроверяем
    // (владелец мог убрать район из справочника — профиль мастера от этого не ломается).
    const sameList = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((d, i) => d === y[i]);
    const kept = city === e.city && (a.districts === undefined || sameList(a.districts, e.districts ?? []));
    const districts = kept ? (e.districts ?? []) : await executorDistricts(ctx, city, a.districts ?? []);
    const before = e.districts ?? [];

    const cats = listDiff(e.categories, categories);
    const diff = skillsDiff(e.skills, skills);
    const log = new ChangeLog();
    if (name !== e.name) log.add(`ФИО ${quote(e.name)} → ${quote(name)}`, "name", "изменено");
    if (city !== e.city) log.add(`город ${e.city} → ${city}`, "city", { from: e.city, to: city });
    const areas = listDiff(before, districts);
    if (areas.added.length || areas.removed.length) log.add(districts.length ? `районы: ${listDiffText(areas)}` : "районы: весь город", "districts", areas);
    if (cats.added.length || cats.removed.length) log.add(`специализации ${listDiffText(cats, label)}`, "categories", cats);
    if (a.cooperation !== e.cooperation) log.add(`сотрудничество: ${COOPERATION[e.cooperation]} → ${COOPERATION[a.cooperation]}`, "cooperation", { from: e.cooperation, to: a.cooperation });
    if (diff.added.length || diff.removed.length) log.add(`навыки: ${listDiffText(diff)}`, "skills", diff);
    // Те же навыки, но в написании справочника («мытье окон» → «Мытьё окон») или в другом порядке — тоже сохраняем.
    else if (skills.join("\n") !== e.skills.join("\n")) log.add("навыки: написание и порядок", "skills", { from: e.skills, to: skills });
    // Сохранили без изменений — ни записи, ни шума в журнале.
    if (log.empty) return;

    // Телефон — это логин; менять его здесь нельзя, чтобы не сломать вход.
    await ctx.db.patch(id, { name, city, categories, skills, cooperation: a.cooperation, districts: districts.length ? districts : undefined });
    const u = await ctx.db.query("users").withIndex("by_executor", (q) => q.eq("executorId", id)).first();
    if (u && u.name !== name) await ctx.db.patch(u._id, { name });
    await audit(ctx, me, "executor.updated", `Профиль исполнителя ${shortName(name)} изменён: ${log.text()}`, { entityId: id, meta: { changes: log.changes } });
  },
});

/** На смену / выходной / «недоступен до … (причина)» — сотрудник; руководитель — в своём направлении. */
export const setAvailable = mutation({
  args: { id: v.id("executors"), ...shiftArgs },
  handler: async (ctx, { id, ...a }) => {
    const me = await requireRole(ctx, TEAM);
    const scope = scopeOf(me);
    const e = await ctx.db.get(id);
    if (!e || (scope && !e.categories.some((c) => scope.includes(c)))) throw new ConvexError("Это не ваше направление");
    await applyShift(ctx, e, a, me, "staff");
  },
});

/** Лимит заказов в работе у мастера (ТЗ п.14, E9) — только владелец; null — по умолчанию. */
export const setMaxActive = mutation({
  args: { id: v.id("executors"), max: v.union(v.number(), v.null()) },
  handler: async (ctx, { id, max }) => {
    const me = await requireRole(ctx, OWNER);
    const e = await ctx.db.get(id);
    if (!e) throw new ConvexError("Исполнитель не найден");
    if (max !== null && (!Number.isInteger(max) || max < 1 || max > MAX_ACTIVE_LIMIT)) throw new ConvexError(`Лимит — целое число от 1 до ${MAX_ACTIVE_LIMIT}`);
    const next = max === null || max === DEFAULT_MAX_ACTIVE ? undefined : max;
    if (next === e.maxActiveOrders) return;
    await ctx.db.patch(id, { maxActiveOrders: next });
    const was = e.maxActiveOrders ?? DEFAULT_MAX_ACTIVE;
    const now = next ?? DEFAULT_MAX_ACTIVE;
    await audit(ctx, me, "executor.limit", `${shortName(e.name)}: заказов в работе одновременно — ${was} → ${now}`, { entityId: id, meta: { from: was, to: now } });
  },
});
