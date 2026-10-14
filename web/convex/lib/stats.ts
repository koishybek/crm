// История мастера за 90 дней (ТЗ п.12.6) — кеш executors.stats90 для подбора. Считается по индексу заказов
// мастера (by_executor), а не перебором всех заказов: при сдаче работы, отмене, отказе и раз в час кроном
// (convex/executorStats.ts). Подбор и лента только читают готовые числа.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { FINISHED_STATUSES } from "../../src/data/catalog";
import { HISTORY } from "../../src/data/logic";
import type { ExecutorStats90, OrderStatus } from "../../src/data/types";
import { nowIso } from "./domain";

const DAY_MS = 86400_000;
/** Заказов мастера одного статуса, которые просматриваем (новые сверху): за 90 дней столько не бывает. */
const SCAN = 500;
/** Сданные работы — в том числе ушедшие потом в возврат: работу мастер сдал. */
const DONE_STATUSES: readonly OrderStatus[] = [...FINISHED_STATUSES, "refund"];

const recent = (ctx: QueryCtx, executorId: Id<"executors">, status: OrderStatus) =>
  ctx.db
    .query("orders")
    .withIndex("by_executor", (q) => q.eq("executorId", executorId).eq("status", status))
    .order("desc")
    .take(SCAN);

/** Отказы мастера за окно истории — моменты, новые в конце. */
export const refusalsSince = (ex: Pick<Doc<"executors">, "refusals">, since: string): string[] => (ex.refusals ?? []).filter((at) => at >= since);

/** История мастера за 90 дней на момент now. */
export async function computeStats90(ctx: QueryCtx, ex: Doc<"executors">, now = Date.now()): Promise<ExecutorStats90> {
  const since = new Date(now - HISTORY.days * DAY_MS).toISOString();
  let done = 0;
  let onTime = 0;
  let hours = 0;
  let timed = 0;
  for (const status of DONE_STATUSES) {
    for (const o of await recent(ctx, ex._id, status)) {
      if (!o.doneAt || o.doneAt < since) continue;
      done++;
      if (o.doneAt <= o.deadline) onTime++;
      const start = Date.parse(o.assignedAt ?? o.createdAt);
      const end = Date.parse(o.doneAt);
      if (Number.isFinite(start) && end > start) {
        hours += (end - start) / 3_600_000;
        timed++;
      }
    }
  }
  const cancelled = (await recent(ctx, ex._id, "cancelled")).filter((o) => (o.assignedAt ?? o.createdAt) >= since).length;
  return {
    done,
    onTime,
    cancelled,
    refusals: refusalsSince(ex, since).length,
    ...(timed ? { avgHours: Math.max(1, Math.round(hours / timed)) } : {}),
    updatedAt: new Date(now).toISOString(),
  };
}

/** Пересчитать историю мастера и убрать из отказов то, что старше окна. */
export async function refreshStats(ctx: MutationCtx, executorId: Id<"executors"> | undefined): Promise<void> {
  if (!executorId) return;
  const ex = await ctx.db.get(executorId);
  if (!ex) return;
  const now = Date.now();
  const stats90 = await computeStats90(ctx, ex, now);
  const kept = refusalsSince(ex, new Date(now - HISTORY.days * DAY_MS).toISOString());
  await ctx.db.patch(ex._id, { stats90, ...(kept.length !== (ex.refusals ?? []).length ? { refusals: kept.length ? kept : undefined } : {}) });
}

/** Мастер отказался от заказа или не подтвердил назначение вовремя — отказ в историю и пересчёт. */
export async function recordRefusal(ctx: MutationCtx, executorId: Id<"executors"> | undefined): Promise<void> {
  if (!executorId) return;
  const ex = await ctx.db.get(executorId);
  if (!ex) return;
  // Храним не больше сотни последних отказов: для подбора важнее 4, больше — шум.
  await ctx.db.patch(ex._id, { refusals: [...(ex.refusals ?? []), nowIso()].slice(-100) });
  await refreshStats(ctx, executorId);
}
