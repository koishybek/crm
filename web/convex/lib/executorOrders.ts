// Заказы мастера по индексу «мастер + статус» — без чтения всей истории за всё время.
// «Мои заказы», «Доход», профиль, бот и утренняя сводка — живые подписки: перечитывать сотни старых заказов при
// каждом изменении нельзя. Активные — все; завершённые — последние FINISHED_PER_STATUS по каждому статусу.
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "./functions";
import { ACTIVE_STATUSES, ORDER_STATUS } from "../../src/data/catalog";
import type { OrderStatus } from "../../src/data/types";

export const FINISHED_PER_STATUS = 100;
const FINISHED: OrderStatus[] = (Object.keys(ORDER_STATUS) as OrderStatus[]).filter((s) => !ACTIVE_STATUSES.includes(s));

const byStatus = (ctx: QueryCtx, executorId: Id<"executors">, status: OrderStatus) =>
  ctx.db.query("orders").withIndex("by_executor", (q) => q.eq("executorId", executorId).eq("status", status));

/** Заказы мастера в работе (назначен … ждёт клиента). */
export async function activeOrdersOf(ctx: QueryCtx, executorId: Id<"executors">): Promise<Doc<"orders">[]> {
  const parts = await Promise.all(ACTIVE_STATUSES.map((s) => byStatus(ctx, executorId, s).collect()));
  return parts.flat();
}

/** Активные + недавние завершённые (новые первыми внутри статуса). */
export async function recentOrdersOf(ctx: QueryCtx, executorId: Id<"executors">): Promise<Doc<"orders">[]> {
  const [active, finished] = await Promise.all([
    activeOrdersOf(ctx, executorId),
    Promise.all(FINISHED.map((s) => byStatus(ctx, executorId, s).order("desc").take(FINISHED_PER_STATUS))),
  ]);
  return [...active, ...finished.flat()];
}
