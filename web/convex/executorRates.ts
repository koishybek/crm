// Ставки исполнителя (ТЗ п.13 «фиксированная или процентная выплата», п.14.5 «тип сотрудничества и ставки»).
// Правит только владелец; каждое изменение — в журнал «было → стало». Заказы, которые мастер уже взял, не меняются:
// сумма зафиксирована снимком acceptedPayout, новая ставка действует на следующие назначения и ленту.
import { ConvexError, v } from "convex/values";
import { mutation } from "./lib/functions";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { cleanRates, ratesText } from "./lib/rates";
import { loadCatalog } from "./catalog";
import { executorRates } from "./schema";
import { shortName } from "../src/lib/format";

export const set = mutation({
  args: { id: v.id("executors"), rates: v.union(executorRates, v.null()) },
  handler: async (ctx, { id, rates }) => {
    const me = await requireRole(ctx, OWNER);
    const e = await ctx.db.get(id);
    if (!e) throw new ConvexError("Исполнитель не найден");
    const catalog = await loadCatalog(ctx);
    const known = (sid: string) => catalog.services.find((s) => s.id === sid)?.label ?? null;
    const label = (sid: string) => known(sid) ?? sid;
    const next = rates === null ? undefined : cleanRates(rates, known);
    const before = ratesText(e.rates, label);
    const after = ratesText(next, label);
    if (JSON.stringify(e.rates ?? null) === JSON.stringify(next ?? null)) return;
    await ctx.db.patch(id, { rates: next });
    await audit(ctx, me, "executor.rates", `${shortName(e.name)}: ставки — ${before} → ${after}`, { entityId: id, meta: { before: e.rates ?? null, after: next ?? null } });
  },
});
