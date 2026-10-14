// История мастеров за 90 дней (ТЗ п.12.6): крон раз в час пересчитывает кеш executors.stats90 пачками —
// окно сдвигается, и старые сдачи и отказы должны из него уходить, даже если у мастера не было событий.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalMutation } from "./lib/functions";
import { refreshStats } from "./lib/stats90";
import { perTenant } from "./lib/tenant";

/** Мастеров за один запуск: каждому — несколько чтений по индексу его заказов. */
const BATCH = 25;

export const refreshBatch = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (cronCtx, { cursor }): Promise<number> => perTenant(cronCtx, internal.executorStats.refreshBatch, 0, async (ctx) => {
    const page = await ctx.db.query("executors").paginate({ numItems: BATCH, cursor: cursor ?? null });
    for (const ex of page.page) await refreshStats(ctx, ex._id);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.executorStats.refreshBatch, { cursor: page.continueCursor });
    return page.page.length;
  }),
});
