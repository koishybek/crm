// Одна точка после любого изменения заказа (её зовёт log() из lib/domain.ts — запись в историю идёт за каждой правкой
// заказа): счётчик заказов в работе у мастера и очередь пересчёта показателей (convex/stats.ts, ТЗ §26.6).
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { WORK_STATUSES } from "../../src/data/catalog";
import { loadOf } from "./load";

export type StatsQueueKind = Doc<"statsDirty">["kind"];

/** Поставить заказ, заявку, день или месяц в очередь пересчёта показателей. Уже в очереди — ничего не пишем. */
export async function queueStats(ctx: MutationCtx, kind: StatsQueueKind, ref: string): Promise<void> {
  const row = await ctx.db
    .query("statsDirty")
    .withIndex("by_ref", (q) => q.eq("kind", kind).eq("ref", ref))
    .first();
  if (!row) await ctx.db.insert("statsDirty", { kind, ref });
}

/** Пересчитать счётчик заказов в работе у мастера — по его индексу (точно, без накопления ошибок). */
export async function recountLoad(ctx: MutationCtx, executorId: Id<"executors">): Promise<void> {
  const e = await ctx.db.get(executorId);
  if (!e) return;
  const n = await loadOf(ctx, executorId);
  if (e.activeCount !== n) await ctx.db.patch(executorId, { activeCount: n });
}

/**
 * Счётчик activeCount: заказ в работе засчитан ровно одному мастеру (loadExecutorId). Сменился мастер или заказ вышел
 * из работы — пересчитываем и прежнего, и нового.
 */
export async function syncLoad(ctx: MutationCtx, o: Doc<"orders">): Promise<void> {
  const want = o.executorId && WORK_STATUSES.includes(o.status) ? o.executorId : undefined;
  if (want === o.loadExecutorId) return;
  await ctx.db.patch(o._id, { loadExecutorId: want });
  for (const id of new Set([o.loadExecutorId, want])) if (id) await recountLoad(ctx, id);
}

/** Заказ изменился: загрузка мастеров и очередь показателей. */
export async function orderTouched(ctx: MutationCtx, orderId: Id<"orders">): Promise<void> {
  const o = await ctx.db.get(orderId);
  if (!o) return;
  await syncLoad(ctx, o);
  await queueStats(ctx, "order", orderId);
}
