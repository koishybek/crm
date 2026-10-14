// Экран «Платформа» (ТЗ §24.3–§24.5): администратор платформы (логин из PLATFORM_ADMINS) видит компании, их тариф,
// модули, статус, подписку и нагрузку; меняет тариф, модули, статус и комиссию платформы и сам заводит компании
// клиентов (владелец получает временный пароль). Оплаты подписки — convex/billing.ts.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { currentUser, type Me } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { isPlatformAdmin, LEGACY_NAME, tenantRow, usageOf, type TenantRow } from "./lib/tenant";
import { DEFAULT_TENANT, forTenant } from "./lib/tenantDb";
import { cleanCompanyFields, createCompanyRecords } from "./tenants";
import { createLogin, tempPassword } from "./users";
import { plan as planValidator, platformFee as feeValidator, tenantModule } from "./schema";
import { MODULE_LABEL, MODULES, PLAN_INFO, SLUG_RE, type PlatformTenantRow } from "../src/data/plans";
import { dayText, daysBetween, isDay, MAX_PERIOD_DAYS, todayAlmaty } from "../src/data/billing";

/** Сколько компаний показываем и до скольки считаем нагрузку (дальше — «больше»). */
const MAX_TENANTS = 200;
const USAGE_CAP = 1000;

/** Администратор платформы (PLATFORM_ADMINS) — иначе отказ. Нужен и в convex/billing.ts. */
export async function requirePlatform(ctx: QueryCtx): Promise<Me> {
  const me = await currentUser(ctx);
  if (!me || !isPlatformAdmin(me)) throw new ConvexError("Нет доступа: экран администратора платформы");
  return me;
}

/** Строка компании для изменения; у компании по умолчанию до миграции её нет — создаём («Про», все модули, как до SaaS). */
export async function platformRow(ctx: MutationCtx, slug: string): Promise<TenantRow> {
  const row = await tenantRow(ctx, slug);
  if (row) return row;
  if (slug !== DEFAULT_TENANT) throw new ConvexError("Компания не найдена");
  const id = await ctx.db.insert("tenants", { slug: DEFAULT_TENANT, name: LEGACY_NAME, plan: "pro", modules: [...MODULES], status: "active", createdAt: nowIso() });
  return (await ctx.db.get(id))!;
}

/** Последняя действующая (не отменённая) оплата подписки компании. */
async function lastPaymentOf(ctx: QueryCtx): Promise<PlatformTenantRow["lastPayment"]> {
  const recent = await ctx.db.query("subscriptionPayments").withIndex("by_paid").order("desc").take(10);
  const p = recent.find((x) => !x.undoneAt);
  return p ? { amount: p.amount, paidAt: p.paidAt, method: p.method } : null;
}

export const tenants = query({
  args: {},
  handler: async (ctx): Promise<PlatformTenantRow[]> => {
    await requirePlatform(ctx);
    const rows = await ctx.db.query("tenants").order("desc").take(MAX_TENANTS);
    const list = rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      plan: r.plan,
      modules: r.modules,
      status: r.status,
      createdAt: r.createdAt,
      platformFee: r.platformFee ?? null,
      ownerUserId: r.ownerUserId,
      paidUntil: r.paidUntil ?? null,
      suspendedFor: r.status === "suspended" ? (r.suspendedFor ?? "manual") : null,
    }));
    // До миграции у компании по умолчанию строки нет — показываем её как есть («Про», все модули, бессрочно).
    if (!rows.some((r) => r.slug === DEFAULT_TENANT)) {
      list.push({ slug: DEFAULT_TENANT, name: LEGACY_NAME, plan: "pro", modules: [...MODULES], status: "active", createdAt: "", platformFee: null, ownerUserId: undefined, paidUntil: null, suspendedFor: null });
    }
    const out: PlatformTenantRow[] = [];
    for (const t of list) {
      const tctx = forTenant(ctx, t.slug);
      const owner = t.ownerUserId ? await tctx.db.get(t.ownerUserId) : null;
      out.push({
        slug: t.slug,
        name: t.name,
        plan: t.plan,
        modules: t.modules,
        status: t.status,
        createdAt: t.createdAt,
        platformFee: t.platformFee,
        owner: owner?.email ?? null,
        usage: {
          users: await usageOf(tctx, "users", USAGE_CAP),
          executors: await usageOf(tctx, "executors", USAGE_CAP),
          ordersPerMonth: await usageOf(tctx, "ordersPerMonth", USAGE_CAP),
        },
        paidUntil: t.paidUntil,
        suspendedFor: t.suspendedFor,
        lastPayment: await lastPaymentOf(tctx),
      });
    }
    return out;
  },
});

/**
 * Тариф, модули, статус и комиссия платформы компании. Новый тариф без явного списка модулей — модули тарифа.
 * Свою компанию приостановить нельзя: администратор потерял бы доступ к этому экрану.
 */
export const update = mutation({
  args: {
    slug: v.string(),
    plan: v.optional(planValidator),
    modules: v.optional(v.array(tenantModule)),
    status: v.optional(v.union(v.literal("active"), v.literal("suspended"))),
    platformFee: v.optional(v.union(feeValidator, v.null())),
  },
  handler: async (ctx, a): Promise<void> => {
    const me = await requirePlatform(ctx);
    if (a.status === "suspended" && a.slug === me.tenantId) throw new ConvexError("Свою компанию приостановить нельзя");
    if (a.platformFee && (!Number.isFinite(a.platformFee.value) || a.platformFee.value < 0 || (a.platformFee.mode === "percent" && a.platformFee.value > 50) || a.platformFee.value > 1_000_000)) {
      throw new ConvexError("Комиссия: процент от 0 до 50 или сумма до 1 000 000 ₸");
    }
    const row = await platformRow(ctx, a.slug);
    const plan = a.plan ?? row.plan;
    const modules = a.modules ? [...new Set(a.modules)] : a.plan && a.plan !== row.plan ? [...PLAN_INFO[plan].modules] : row.modules;
    const status = a.status ?? row.status;
    const platformFee = a.platformFee === undefined ? row.platformFee : (a.platformFee ?? undefined);
    // Приостановил администратор — оплата сама её не снимет; возобновил — причина больше не нужна.
    const suspendedFor = status === row.status ? row.suspendedFor : status === "suspended" ? ("manual" as const) : undefined;
    await ctx.db.patch(row._id, { plan, modules, status, platformFee, suspendedFor });
    const parts = [
      plan !== row.plan ? `тариф «${PLAN_INFO[row.plan].label}» → «${PLAN_INFO[plan].label}»` : "",
      modules.join() !== row.modules.join() ? `модули: ${modules.map((m) => MODULE_LABEL[m]).join(", ") || "нет"}` : "",
      status !== row.status ? (status === "active" ? "работа возобновлена" : "работа приостановлена") : "",
      JSON.stringify(platformFee ?? null) !== JSON.stringify(row.platformFee ?? null)
        ? `комиссия платформы: ${platformFee ? (platformFee.mode === "percent" ? `${platformFee.value}%` : `${platformFee.value} ₸`) : "нет"}`
        : "",
    ].filter(Boolean);
    if (!parts.length) return;
    // Запись — в журнале самой компании: владелец видит, что и когда поменяла платформа.
    await audit(forTenant(ctx, row.slug), "Платформа", "settings.plan", `Платформа: ${parts.join("; ")}`, { entityId: row.slug, meta: { plan, modules, status, platformFee: platformFee ?? null, by: me._id } });
  },
});

// ── Компания клиента, заведённая платформой ──────────────────────────────────

const createArgs = {
  company: v.string(),
  slug: v.string(),
  city: v.string(),
  plan: planValidator,
  ownerName: v.string(),
  login: v.string(),
  /** Оплачено до (день по Алматы); нет — бессрочно. */
  paidUntil: v.optional(v.string()),
};

/**
 * «Создать компанию»: компания, владелец и справочник по умолчанию — тем же шагом, что регистрация (tenants.ts).
 * Пароль владельца создаёт сервер и возвращает один раз; он временный — при первом входе владелец задаёт свой.
 */
export const createCompany = action({
  args: createArgs,
  handler: async (ctx, a): Promise<{ slug: string; login: string; password: string }> => {
    const form = cleanCompanyFields(a);
    const created: { slug: string; userId: Id<"users"> } = await ctx.runMutation(internal.platform._createCompany, { ...a, ...form });
    const password = tempPassword();
    try {
      await createLogin(ctx, form.login, password);
    } catch (e) {
      // Учётку входа не создали — компанию без владельца не оставляем.
      await ctx.runMutation(internal.tenants._registerFailed, { slug: created.slug, userId: created.userId });
      console.error(`Платформа: вход владельца не создан: ${e instanceof Error ? e.name : "ошибка"}`);
      throw new ConvexError("Не удалось создать вход владельца — попробуйте ещё раз или выберите другой логин");
    }
    return { slug: created.slug, login: form.login, password };
  },
});

export const _createCompany = internalMutation({
  args: createArgs,
  handler: async (ctx, a): Promise<{ slug: string; userId: Id<"users"> }> => {
    const me = await requirePlatform(ctx);
    const form = cleanCompanyFields(a);
    const slug = a.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw new ConvexError("Адрес компании — от 3 до 40 символов: латиница, цифры и дефис, без дефиса в начале и конце");
    if (slug === DEFAULT_TENANT || (await tenantRow(ctx, slug))) throw new ConvexError(`Адрес «${slug}» уже занят — выберите другой`);
    const today = todayAlmaty();
    if (a.paidUntil !== undefined && (!isDay(a.paidUntil) || a.paidUntil < today || daysBetween(today, a.paidUntil) > MAX_PERIOD_DAYS)) {
      throw new ConvexError("«Оплачено до» — дата не раньше сегодняшней и не дальше трёх лет");
    }
    const { ctx: tctx, userId } = await createCompanyRecords(ctx, { ...form, slug, plan: a.plan, paidUntil: a.paidUntil, mustChangePassword: true });
    await audit(
      tctx,
      "Платформа",
      "settings.companyRegistered",
      `Платформа: компания «${form.company}» создана, тариф «${PLAN_INFO[a.plan].label}», владелец — ${form.ownerName}${a.paidUntil ? `, оплачено до ${dayText(a.paidUntil)}` : ""}`,
      { entityId: slug, meta: { plan: a.plan, city: form.city, paidUntil: a.paidUntil ?? null, by: me._id } },
    );
    return { slug, userId };
  },
});
