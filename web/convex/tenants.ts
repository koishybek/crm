// Компании платформы (ТЗ §2.5, §23.7, §24): реестр, «Компания» в настройках, регистрация, миграция данных до SaaS.
import { internalQuery } from "./lib/functions";
import { tenantModule } from "./schema";
import { activeTenantIds, hasModule } from "./lib/tenant";
import { boundTenant } from "./lib/tenantDb";

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
