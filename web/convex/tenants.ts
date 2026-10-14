// Компании платформы (ТЗ §2.5, §23.7, §24): своя компания для интерфейса, карточка «Компания», «С чего начать»,
// регистрация новой компании (SAAS_SIGNUP=1) и разовый перенос данных, заведённых до SaaS.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { currentUser, OWNER, requireRole, type Me } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { normalizeLogin } from "./lib/login";
import { hitLimit } from "./lib/rateLimit";
import { activeTenantIds, hasModule, isPlatformAdmin, LEGACY_NAME, tenantRow, tenantView, usageOf } from "./lib/tenant";
import { boundTenant, DEFAULT_TENANT, forTenant, GLOBAL_TABLES, unscopedDb } from "./lib/tenantDb";
import { env } from "./env";
import { materialize } from "./catalog";
import { createLogin } from "./users";
import schema, { tenantModule } from "./schema";
import { CITIES } from "../src/data/catalog";
import { passwordProblem } from "../src/data/passwordRules";
import { MODULES, ONBOARDING_STEPS, PLAN_INFO, slugify, SLUG_RE, type CompanyInfo, type LimitKind, type OnboardingStep, type Plan, type TenantInfo } from "../src/data/plans";

/** Компания вошедшего пользователя — для планировщика публичных action (lib/functions.ts). */
export const _mine = internalQuery({
  args: {},
  handler: async (ctx): Promise<string | null> => boundTenant(ctx),
});

/** Активные компании — для кронов-action, которые обходят компании по очереди. */
export const _active = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => activeTenantIds(ctx),
});

/** Модуль у компании вызова — для action и HTTP-входов (lib/tenant.ts hasModule). */
export const _hasModule = internalQuery({
  args: { module: tenantModule },
  handler: async (ctx, { module }): Promise<boolean> => {
    const t = boundTenant(ctx);
    return !!t && (await hasModule(ctx, t, module));
  },
});

// ── Своя компания ────────────────────────────────────────────────────────────

const LIMITS: readonly LimitKind[] = ["users", "executors", "ordersPerMonth"];
/** Сколько считать при показе лимита без ограничения — «больше N» интерфейсу не нужно. */
const USAGE_CAP = 500;

/** Шаги «С чего начать»: что владелец уже сделал (по данным компании, без отдельных отметок). */
async function onboardingOf(ctx: QueryCtx): Promise<{ step: OnboardingStep; done: boolean }[]> {
  const [catalogEdit, staff, executor, lead, integration, pbx, origins] = await Promise.all([
    ctx.db
      .query("audit")
      .withIndex("by_entity", (q) => q.eq("entity", "catalog"))
      .first(),
    usageOf(ctx, "users", 2),
    ctx.db.query("executors").first(),
    ctx.db.query("leads").first(),
    ctx.db.query("integrations").filter((q) => q.eq(q.field("status"), "connected")).first(),
    ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "pbxSecret"))
      .first(),
    ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", "siteOrigins"))
      .first(),
  ]);
  const done: Record<OnboardingStep, boolean> = {
    catalog: !!catalogEdit,
    staff: staff > 1,
    executors: !!executor,
    channels: !!(lead || integration || pbx || origins),
  };
  return ONBOARDING_STEPS.map((step) => ({ step, done: done[step] }));
}

/** Своя компания для интерфейса: тариф, модули, статус — лёгкий запрос, его читает каждая страница. */
export const current = query({
  args: {},
  handler: async (ctx): Promise<TenantInfo | null> => {
    const me = await currentUser(ctx);
    if (!me) return null;
    return { ...(await tenantView(ctx, me.tenantId)), platformAdmin: isPlatformAdmin(me) };
  },
});

/** Карточка «Компания» владельца: лимиты тарифа и сколько занято, комиссия платформы. */
export const company = query({
  args: {},
  handler: async (ctx): Promise<CompanyInfo> => {
    const me = await requireRole(ctx, OWNER);
    const view = await tenantView(ctx, me.tenantId);
    const usage = {} as CompanyInfo["usage"];
    for (const kind of LIMITS) {
      const cap = PLAN_INFO[view.plan][kind];
      usage[kind] = { cap, used: await usageOf(ctx, kind, cap ?? USAGE_CAP) };
    }
    return { usage, platformFee: (await tenantRow(ctx, me.tenantId))?.platformFee ?? null };
  },
});

/** «С чего начать» владельцу: шаги, пока он их не прошёл или не скрыл список; null — показывать нечего. */
export const onboarding = query({
  args: {},
  handler: async (ctx): Promise<{ step: OnboardingStep; done: boolean }[] | null> => {
    const me = await currentUser(ctx);
    if (!me || me.role !== "owner") return null;
    const row = await tenantRow(ctx, me.tenantId);
    // Компания по умолчанию работала до SaaS — ей список не нужен; без строки — тоже она.
    if (!row || row.onboardingDoneAt || row.slug === DEFAULT_TENANT) return null;
    const steps = await onboardingOf(ctx);
    return steps.every((x) => x.done) ? null : steps;
  },
});

/** Владелец меняет название компании. Адрес (slug) не меняется: он в ссылках на форму, в уведомлениях и во всех данных. */
export const rename = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const clean = name.trim().replace(/\s+/g, " ");
    if (clean.length < 2 || clean.length > 80) throw new ConvexError("Название компании — от 2 до 80 символов");
    const row = await ensureRow(ctx, me);
    if (row.name === clean) return;
    await ctx.db.patch(row._id, { name: clean });
    await audit(ctx, me, "settings.company", `Название компании: «${row.name}» → «${clean}»`, { entityId: row.slug });
  },
});

/** Владелец скрывает «С чего начать». */
export const dismissOnboarding = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const row = await ensureRow(ctx, me);
    if (!row.onboardingDoneAt) await ctx.db.patch(row._id, { onboardingDoneAt: nowIso() });
  },
});

/** Строка компании; у компании по умолчанию до миграции её нет — создаём с тарифом «Про» (как было до SaaS). */
async function ensureRow(ctx: MutationCtx, me: Me) {
  const row = await tenantRow(ctx, me.tenantId);
  if (row) return row;
  if (me.tenantId !== DEFAULT_TENANT) throw new ConvexError("Компания не найдена");
  const id = await ctx.db.insert("tenants", defaultRow((await firstOwner(ctx))?._id));
  return (await ctx.db.get(id))!;
}

const defaultRow = (ownerUserId: Id<"users"> | undefined) => ({
  slug: DEFAULT_TENANT,
  name: LEGACY_NAME,
  plan: "pro" as const,
  modules: [...MODULES],
  status: "active" as const,
  createdAt: nowIso(),
  ...(ownerUserId ? { ownerUserId } : {}),
});

/** Первый владелец компании по умолчанию (среди всех: у пользователей до SaaS поля tenantId нет). */
async function firstOwner(ctx: QueryCtx) {
  const owners = await unscopedDb(ctx)
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .collect();
  return owners.find((u) => (u.tenantId ?? DEFAULT_TENANT) === DEFAULT_TENANT && u.active !== false) ?? null;
}

// ── Регистрация компании (ТЗ §23.7) ─────────────────────────────────────────

/** Регистрация открыта: SAAS_SIGNUP=1. Иначе страница говорит «Регистрация по приглашению». */
const signupOpen = (): boolean => env("SAAS_SIGNUP") === "1";

export const signupStatus = query({
  args: {},
  handler: async (): Promise<{ open: boolean }> => ({ open: signupOpen() }),
});

/** Человек заполняет форму дольше 3 секунд; часы телефона могут спешить на 10 минут. */
const MIN_FILL_MS = 3000;
const CLOCK_SKEW_MS = 10 * 60_000;
/** Регистраций на всю платформу в час и попыток на один логин в час. */
const SIGNUPS_PER_HOUR = 30;
const PER_LOGIN_PER_HOUR = 3;

const registerArgs = {
  company: v.string(),
  ownerName: v.string(),
  login: v.string(),
  password: v.string(),
  city: v.string(),
  consent: v.boolean(),
  /** Поле-ловушка: человек его не видит. */
  website: v.optional(v.string()),
  startedAt: v.number(),
};

/** Проверка формы без базы; ошибка — понятным текстом. */
function checkForm(a: { company: string; ownerName: string; login: string; password: string; city: string; consent: boolean; website?: string; startedAt: number }, now: number) {
  if (a.website?.trim()) throw new ConvexError("Не удалось зарегистрироваться");
  const elapsed = now - a.startedAt;
  if (!Number.isFinite(elapsed) || elapsed < -CLOCK_SKEW_MS) throw new ConvexError("Проверьте дату и время на устройстве и попробуйте ещё раз");
  if (elapsed >= 0 && elapsed < MIN_FILL_MS) throw new ConvexError("Слишком быстро — проверьте данные и отправьте ещё раз");
  if (!a.consent) throw new ConvexError("Нужно согласие на обработку персональных данных");
  const problem = passwordProblem(a.password, "owner");
  if (problem) throw new ConvexError(problem);
  return cleanCompanyFields(a);
}

/** Название, владелец, логин и город новой компании — общие правила регистрации и «Создать компанию» платформы. */
export function cleanCompanyFields(a: { company: string; ownerName: string; login: string; city: string }): { company: string; ownerName: string; login: string; city: string } {
  const company = a.company.trim().replace(/\s+/g, " ");
  if (company.length < 2 || company.length > 80) throw new ConvexError("Название компании — от 2 до 80 символов");
  const ownerName = a.ownerName.trim().replace(/\s+/g, " ");
  if (ownerName.length < 2 || ownerName.length > 80) throw new ConvexError("Укажите имя владельца");
  const login = normalizeLogin(a.login.slice(0, 120));
  if (!login || (!login.includes("@") && !/^7\d{10}$/.test(login)) || (login.includes("@") && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login))) {
    throw new ConvexError("Логин — email или казахстанский номер телефона");
  }
  const city = a.city.trim();
  if (!(CITIES as readonly string[]).includes(city)) throw new ConvexError("Выберите город из списка");
  return { company, ownerName, login, city };
}

/** Регистрация (публично, без входа): компания + владелец + справочник по умолчанию. Дальше владелец входит своим паролем. */
export const register = action({
  args: registerArgs,
  handler: async (ctx, a): Promise<{ login: string; slug: string }> => {
    if (!signupOpen()) throw new ConvexError("Регистрация по приглашению — напишите администратору платформы");
    const form = checkForm(a, Date.now());
    const created = await ctx.runMutation(internal.tenants._register, { ...form });
    try {
      await createLogin(ctx, form.login, a.password);
    } catch (e) {
      // Учётку входа не создали — компанию без владельца не оставляем.
      await ctx.runMutation(internal.tenants._registerFailed, { slug: created.slug, userId: created.userId });
      console.error(`Регистрация: вход не создан: ${e instanceof Error ? e.name : "ошибка"}`);
      throw new ConvexError("Не удалось создать вход — попробуйте ещё раз или выберите другой логин");
    }
    return { login: form.login, slug: created.slug };
  },
});

/** Свободный адрес компании из названия: «master-na-chas», занят — «master-na-chas-2»… */
async function freeSlug(ctx: QueryCtx, name: string): Promise<string> {
  const base = slugify(name);
  for (let i = 1; i <= 20; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 36)}-${i}`;
    if (slug !== DEFAULT_TENANT && SLUG_RE.test(slug) && !(await tenantRow(ctx, slug))) return slug;
  }
  return `${base.slice(0, 28)}-${Date.now().toString(36)}`;
}

export const _register = internalMutation({
  args: { company: v.string(), ownerName: v.string(), login: v.string(), city: v.string() },
  handler: async (base, a): Promise<{ slug: string; userId: Id<"users"> }> => {
    if (!(await hitLimit(base, "signup:all", SIGNUPS_PER_HOUR, 3600_000))) throw new ConvexError("Сейчас слишком много регистраций — попробуйте через час");
    if (!(await hitLimit(base, `signup:login:${a.login}`, PER_LOGIN_PER_HOUR, 3600_000))) throw new ConvexError("Слишком много попыток — попробуйте через час");
    const slug = await freeSlug(base, a.company);
    const plan = "free" as const;
    const { ctx, userId } = await createCompanyRecords(base, { ...a, slug, plan });
    const owner = await ctx.db.get(userId);
    await audit(ctx, owner ?? "Система", "settings.companyRegistered", `Компания «${a.company}» зарегистрирована, тариф «${PLAN_INFO[plan].label}»`, { entityId: slug, meta: { city: a.city, plan } });
    return { slug, userId };
  },
});

/**
 * Новая компания: строка реестра, владелец и справочник по умолчанию — общий шаг регистрации и «Создать компанию»
 * на экране «Платформа». Возвращает базу новой компании (запись в её журнал — у вызывающего) и владельца.
 * Логин — один на всю платформу; mustChangePassword — пароль выдал администратор, владелец при входе задаёт свой.
 */
export async function createCompanyRecords(
  base: MutationCtx,
  a: { slug: string; company: string; ownerName: string; login: string; city: string; plan: Plan; paidUntil?: string; mustChangePassword?: boolean },
): Promise<{ ctx: MutationCtx; userId: Id<"users"> }> {
  if (await unscopedDb(base).query("users").withIndex("email", (q) => q.eq("email", a.login)).first()) throw new ConvexError("Такой логин уже занят — войдите или выберите другой");
  const tenantRowId = await base.db.insert("tenants", {
    slug: a.slug,
    name: a.company,
    plan: a.plan,
    modules: [...PLAN_INFO[a.plan].modules],
    status: "active",
    createdAt: nowIso(),
    city: a.city,
    ...(a.paidUntil ? { paidUntil: a.paidUntil } : {}),
  });
  // Дальше — в новой компании: владелец, справочник по умолчанию.
  const ctx = forTenant(base, a.slug);
  const userId = await ctx.db.insert("users", {
    name: a.ownerName,
    email: a.login,
    ...(a.login.includes("@") ? {} : { phone: a.login }),
    role: "owner",
    tenantId: a.slug,
    active: true,
    ...(a.mustChangePassword ? { mustChangePassword: true } : {}),
  });
  await ctx.db.patch(tenantRowId, { ownerUserId: userId });
  await materialize(ctx);
  return { ctx, userId };
}

/** Вход не создался — убрать только что созданную компанию целиком (её данные — только что созданные справочник и журнал). */
export const _registerFailed = internalMutation({
  args: { slug: v.string(), userId: v.id("users") },
  handler: async (base, { slug, userId }): Promise<void> => {
    const row = await tenantRow(base, slug);
    if (!row || row.ownerUserId !== userId) return;
    const raw = unscopedDb(base);
    for (const table of ["users", "categories", "services", "audit"] as const) {
      for (const d of await raw.query(table).filter((q) => q.eq(q.field("tenantId"), slug)).take(500)) await raw.delete(d._id);
    }
    await raw.delete(row._id);
  },
});

// ── Перенос данных до SaaS (запускает интегратор один раз: npx convex run tenants:migrate) ─────────────────

/** Документов за один шаг; у звонков в документе расшифровка — их страница меньше. */
const MIGRATE_PAGE = 200;
const MIGRATE_PAGE_OF: Partial<Record<TableNames, number>> = { calls: 50 };
/** Все таблицы компании — в порядке схемы. */
const COMPANY_TABLES = Object.keys(schema.tables).filter((t): t is TableNames => !GLOBAL_TABLES.has(t));

/**
 * Разовая миграция: строка компании «Home Max Service» (t-komfort, тариф «Про», все модули) и tenantId во всех
 * документах, где его ещё нет. Шагами по 200 документов, следующий шаг ставит сам; повторный запуск безопасен —
 * строку не дублирует, документы с tenantId не трогает. В конце — отметка migratedAt и запись в журнале компании.
 */
export const migrate = internalMutation({
  args: { table: v.optional(v.string()), cursor: v.optional(v.union(v.string(), v.null())), patched: v.optional(v.number()), scanned: v.optional(v.number()) },
  handler: async (ctx, a): Promise<{ table: string | null; patched: number; scanned: number }> => {
    const raw = unscopedDb(ctx);
    let patched = a.patched ?? 0;
    let scanned = a.scanned ?? 0;
    if (a.table === undefined) {
      const row = await tenantRow(ctx, DEFAULT_TENANT);
      if (!row) await ctx.db.insert("tenants", defaultRow((await firstOwner(ctx))?._id));
      await ctx.scheduler.runAfter(0, internal.tenants.migrate, { table: COMPANY_TABLES[0], cursor: null, patched: 0, scanned: 0 });
      return { table: COMPANY_TABLES[0] ?? null, patched, scanned };
    }
    const table = COMPANY_TABLES.find((t) => t === a.table);
    if (!table) throw new ConvexError(`Неизвестная таблица: ${a.table}`);
    const page = await raw.query(table).paginate({ cursor: a.cursor ?? null, numItems: MIGRATE_PAGE_OF[table] ?? MIGRATE_PAGE });
    for (const d of page.page) {
      scanned++;
      if ((d as { tenantId?: unknown }).tenantId === undefined) {
        await raw.patch(d._id, { tenantId: DEFAULT_TENANT });
        patched++;
      }
    }
    const next = page.isDone ? COMPANY_TABLES[COMPANY_TABLES.indexOf(table) + 1] : table;
    if (next) {
      await ctx.scheduler.runAfter(0, internal.tenants.migrate, { table: next, cursor: page.isDone ? null : page.continueCursor, patched, scanned });
      return { table: next, patched, scanned };
    }
    const row = await tenantRow(ctx, DEFAULT_TENANT);
    if (row) await ctx.db.patch(row._id, { migratedAt: nowIso() });
    await audit(forTenant(ctx, DEFAULT_TENANT), "Система", "system.tenantMigrated", `Данные перенесены в компанию «${row?.name ?? LEGACY_NAME}»: просмотрено документов — ${scanned}, дополнено — ${patched}`, {
      meta: { scanned, patched },
    });
    return { table: null, patched, scanned };
  },
});

/** Ход миграции — для проверки интегратором: npx convex run tenants:migrationStatus. */
export const migrationStatus = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ tenant: boolean; migratedAt: string | null }> => {
    const row = await tenantRow(ctx, DEFAULT_TENANT);
    return { tenant: !!row, migratedAt: row?.migratedAt ?? null };
  },
});
