// Компания (ТЗ §2.5, §24): строка реестра, тариф, модули, лимиты, администраторы платформы.
import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { env } from "../env";
import { internal } from "../_generated/api";
import type { ActionCtx, QueryCtx } from "./functions";
import { normalizeLogin } from "./login";
import { actionFor, boundTenant, DEFAULT_TENANT, forTenant } from "./tenantDb";
import { MODULES, PLAN_INFO, limitText, lockText, type LimitKind, type Plan, type TenantModule } from "../../src/data/plans";

export type TenantRow = Doc<"tenants">;

/** Строка компании по её id (slug). Реестр — общая таблица, читается из любой компании. */
export async function tenantRow(ctx: QueryCtx, tenantId: string): Promise<TenantRow | null> {
  return ctx.db
    .query("tenants")
    .withIndex("by_slug", (q) => q.eq("slug", tenantId))
    .unique();
}

/** Что известно о компании, даже если строки ещё нет (данные до SaaS до миграции): компания по умолчанию — «Про» со всеми модулями. */
export interface TenantView {
  slug: string;
  name: string;
  plan: Plan;
  modules: TenantModule[];
  status: "active" | "suspended";
}

export const LEGACY_NAME = "Home Max Service";

export function viewOf(tenantId: string, row: TenantRow | null): TenantView {
  if (row) return { slug: row.slug, name: row.name, plan: row.plan, modules: row.modules, status: row.status };
  if (tenantId === DEFAULT_TENANT) return { slug: tenantId, name: LEGACY_NAME, plan: "pro", modules: [...MODULES], status: "active" };
  return { slug: tenantId, name: tenantId, plan: "free", modules: [], status: "suspended" };
}

export async function tenantView(ctx: QueryCtx, tenantId: string): Promise<TenantView> {
  return viewOf(tenantId, await tenantRow(ctx, tenantId));
}

/** Приостановленная компания: ни данных, ни действий у её сотрудников. */
export async function assertTenantActive(ctx: QueryCtx, tenantId: string): Promise<void> {
  if ((await tenantView(ctx, tenantId)).status !== "active") throw new ConvexError("Работа компании приостановлена — обратитесь к администратору платформы");
}

/** Модуль включён у компании (ТЗ §24.3) — единственная проверка, на входе каждой платной функции. */
export async function hasModule(ctx: QueryCtx, tenantId: string, module: TenantModule): Promise<boolean> {
  return (await tenantView(ctx, tenantId)).modules.includes(module);
}

export async function requireModule(ctx: QueryCtx, tenantId: string, module: TenantModule): Promise<void> {
  if (!(await hasModule(ctx, tenantId, module))) throw new ConvexError(lockText(module));
}

/** Начало текущего месяца по Алматы (UTC+5) — ISO для сравнения с createdAt. */
export function monthStartIso(now = Date.now()): string {
  const local = new Date(now + 5 * 3600_000);
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - 5 * 3600_000).toISOString();
}

/** Сколько уже есть — для лимита и экрана «Платформа». Читает не больше limit+1 строк. */
export async function usageOf(ctx: QueryCtx, kind: LimitKind, cap: number): Promise<number> {
  if (kind === "users") {
    let n = 0;
    for (const role of ["owner", "operator", "manager"] as const) {
      const list = await ctx.db
        .query("users")
        .withIndex("by_role", (q) => q.eq("role", role))
        .take(cap + 1);
      n += list.filter((u) => u.active !== false).length;
    }
    return n;
  }
  if (kind === "executors") return (await ctx.db.query("executors").take(cap + 1)).length;
  const from = monthStartIso();
  return (
    await ctx.db
      .query("orders")
      .withIndex("by_created", (q) => q.gte("createdAt", from))
      .take(cap + 1)
  ).length;
}

/** Лимит тарифа (ТЗ §24.4): ещё одного сотрудника, исполнителя, заказа в этом месяце — нельзя, если лимит исчерпан. */
export async function assertLimit(ctx: QueryCtx, tenantId: string, kind: LimitKind): Promise<void> {
  const view = await tenantView(ctx, tenantId);
  const cap = PLAN_INFO[view.plan][kind];
  if (cap === null) return;
  if ((await usageOf(ctx, kind, cap)) >= cap) throw new ConvexError(limitText(view.plan, kind));
}

/** Администратор платформы — логин из PLATFORM_ADMINS (через запятую). */
export function isPlatformAdmin(user: Pick<Doc<"users">, "email"> | null): boolean {
  if (!user?.email) return false;
  const list = (env("PLATFORM_ADMINS") ?? "")
    .split(",")
    .map((s) => normalizeLogin(s))
    .filter(Boolean);
  return list.includes(normalizeLogin(user.email));
}

/** Компании, с которыми работают кроны: активные из реестра; пока миграция не создала строку — компания по умолчанию. */
export async function activeTenantIds(ctx: QueryCtx): Promise<string[]> {
  const rows = await ctx.db.query("tenants").collect();
  const ids = rows.filter((r) => r.status === "active").map((r) => r.slug);
  if (!rows.some((r) => r.slug === DEFAULT_TENANT)) ids.unshift(DEFAULT_TENANT);
  return ids;
}

/**
 * Шаг крона по каждой компании отдельно (ТЗ §2.5): своя база, свои настройки, сотрудники и счётчики.
 * Вызов с уже известной компанией (tenantId в аргументах) — только по ней.
 */
export async function eachTenant<C extends QueryCtx>(ctx: C, step: (c: C, tenantId: string) => Promise<void>): Promise<void> {
  const bound = boundTenant(ctx);
  const ids = bound ? [bound] : await activeTenantIds(ctx);
  for (const id of ids) await step(bound ? ctx : forTenant(ctx, id), id);
}

/**
 * Крон-мутация по компаниям: компания уже известна (tenantId в аргументах) — шаг по ней; одна компания — сразу;
 * несколько — каждой свой запуск той же функции отдельной транзакцией (недоделанное одной не мешает другим).
 */
export async function perTenant<C extends QueryCtx & { scheduler: unknown }, R>(ctx: C, self: unknown, scheduled: R, step: (c: C) => Promise<R>): Promise<R> {
  if (boundTenant(ctx)) return step(ctx);
  const ids = await activeTenantIds(ctx);
  if (ids.length === 1) return step(forTenant(ctx, ids[0]));
  const scheduler = ctx.scheduler as unknown as { runAfter: (ms: number, fn: unknown, args: Record<string, unknown>) => Promise<unknown> };
  for (const id of ids) await scheduler.runAfter(0, self, { tenantId: id });
  // Работа ушла в отдельные запуски по компаниям — здесь ничего не сделано.
  return scheduled;
}

/** Крон-action по компаниям — как perTenant: своя компания, одна компания — сразу, несколько — отдельными запусками. */
export async function perTenantAction<C extends ActionCtx>(ctx: C, tenantId: string | undefined, self: unknown, step: (c: C) => Promise<void>): Promise<void> {
  if (tenantId) return step(actionFor(ctx, tenantId));
  const ids: string[] = await ctx.runQuery(internal.tenants._active, {});
  if (ids.length === 1) return step(actionFor(ctx, ids[0]));
  const scheduler = ctx.scheduler as unknown as { runAfter: (ms: number, fn: unknown, args: Record<string, unknown>) => Promise<unknown> };
  for (const id of ids) await scheduler.runAfter(0, self, { tenantId: id });
}

/**
 * Компания публичного входа (форма заявки, /public/lead): по адресу компании — только действующая;
 * без адреса — первая компания платформы (до SaaS форма была одна). null — такой компании нет.
 */
export async function publicTenant(ctx: QueryCtx, slug?: string): Promise<string | null> {
  if (slug) {
    const row = await tenantRow(ctx, slug.trim().toLowerCase());
    if (row) return row.status === "active" ? row.slug : null;
    return slug === DEFAULT_TENANT ? DEFAULT_TENANT : null;
  }
  const first = await ctx.db.query("tenants").order("asc").first();
  return first ? (first.status === "active" ? first.slug : null) : DEFAULT_TENANT;
}

/** Модуль у компании action (публичной — по вошедшему пользователю, внутренней — по tenantId из аргументов). */
export async function actionHasModule(ctx: ActionCtx, module: TenantModule): Promise<boolean> {
  return ctx.runQuery(internal.tenants._hasModule, { module });
}

export async function requireModuleAction(ctx: ActionCtx, module: TenantModule): Promise<void> {
  if (!(await actionHasModule(ctx, module))) throw new ConvexError(lockText(module));
}
