// Экран «Платформа» (ТЗ §24.3–§24.5): администратор платформы (логин из PLATFORM_ADMINS) видит компании, их тариф,
// модули, статус и нагрузку и меняет тариф, модули, статус и комиссию платформы. Оплату тарифа ведут вне системы.
import { ConvexError, v } from "convex/values";
import { mutation, query, type QueryCtx } from "./lib/functions";
import { currentUser, type Me } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { isPlatformAdmin, LEGACY_NAME, tenantRow, usageOf } from "./lib/tenant";
import { DEFAULT_TENANT, forTenant } from "./lib/tenantDb";
import { plan as planValidator, platformFee as feeValidator, tenantModule } from "./schema";
import { MODULE_LABEL, MODULES, PLAN_INFO, type PlatformTenantRow } from "../src/data/plans";

/** Сколько компаний показываем и до скольки считаем нагрузку (дальше — «больше»). */
const MAX_TENANTS = 200;
const USAGE_CAP = 1000;

async function requirePlatform(ctx: QueryCtx): Promise<Me> {
  const me = await currentUser(ctx);
  if (!me || !isPlatformAdmin(me)) throw new ConvexError("Нет доступа: экран администратора платформы");
  return me;
}

export const tenants = query({
  args: {},
  handler: async (ctx): Promise<PlatformTenantRow[]> => {
    await requirePlatform(ctx);
    const rows = await ctx.db.query("tenants").order("desc").take(MAX_TENANTS);
    const list = rows.map((r) => ({ slug: r.slug, name: r.name, plan: r.plan, modules: r.modules, status: r.status, createdAt: r.createdAt, platformFee: r.platformFee ?? null, ownerUserId: r.ownerUserId }));
    // До миграции у компании по умолчанию строки нет — показываем её как есть («Про», все модули).
    if (!rows.some((r) => r.slug === DEFAULT_TENANT)) {
      list.push({ slug: DEFAULT_TENANT, name: LEGACY_NAME, plan: "pro", modules: [...MODULES], status: "active", createdAt: "", platformFee: null, ownerUserId: undefined });
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
    let row = await tenantRow(ctx, a.slug);
    if (!row && a.slug === DEFAULT_TENANT) {
      const id = await ctx.db.insert("tenants", { slug: DEFAULT_TENANT, name: LEGACY_NAME, plan: "pro", modules: [...MODULES], status: "active", createdAt: nowIso() });
      row = await ctx.db.get(id);
    }
    if (!row) throw new ConvexError("Компания не найдена");
    const plan = a.plan ?? row.plan;
    const modules = a.modules ? [...new Set(a.modules)] : a.plan && a.plan !== row.plan ? [...PLAN_INFO[plan].modules] : row.modules;
    const status = a.status ?? row.status;
    const platformFee = a.platformFee === undefined ? row.platformFee : (a.platformFee ?? undefined);
    await ctx.db.patch(row._id, { plan, modules, status, platformFee });
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
