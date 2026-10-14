// Загрузка мастера (ТЗ п.14, E9): сколько заказов у него в работе — назначен, принят, в работе, ждёт клиента.
import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { WORK_STATUSES } from "../../src/data/catalog";

/** Заказов в работе у одного мастера — по его индексу, без перебора чужих заказов. */
export async function loadOf(ctx: QueryCtx, executorId: Id<"executors">): Promise<number> {
  let n = 0;
  for (const status of WORK_STATUSES) {
    n += (
      await ctx.db
        .query("orders")
        .withIndex("by_executor", (q) => q.eq("executorId", executorId).eq("status", status))
        .collect()
    ).length;
  }
  return n;
}
