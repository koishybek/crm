// Подбор на сервере (ТЗ п.11, п.12): кому подходит заказ и какие заказы подходят мастеру.
// Само правило — fitsOrder из src/data/logic.ts, одно на ленту, уведомления, «Взять заказ» и экран назначения.
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { feedFor, fitsOrder, type FitOrder } from "../../src/data/logic";
import { executorUser } from "./domain";

/**
 * Учётки мастеров, которым заказ подходит, — получатели «Нового заказа».
 * Только действующие: уволенный (доступ отключён) не должен получать заказы даже в Telegram.
 */
export async function suitableUsers(ctx: QueryCtx, o: FitOrder): Promise<Id<"users">[]> {
  const out: Id<"users">[] = [];
  for (const e of await ctx.db.query("executors").collect()) {
    if (!fitsOrder(e, o).fits) continue;
    const u = await executorUser(ctx, e._id);
    if (u && u.role === "executor" && u.active !== false) out.push(u._id);
  }
  return out;
}

/** Мастера с действующим доступом: отключённых нет ни в подборе, ни в назначении (аудит M-5). */
export async function activeExecutorIds(ctx: QueryCtx): Promise<Set<Id<"executors">>> {
  const users = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "executor"))
    .collect();
  return new Set(users.filter((u) => u.active !== false && u.executorId).map((u) => u.executorId!));
}

/** Лента мастера: свободные заказы, которые ему подходят. */
export async function openOrdersFor(ctx: QueryCtx, ex: Doc<"executors">): Promise<Doc<"orders">[]> {
  const waiting = await ctx.db
    .query("orders")
    .withIndex("by_status", (q) => q.eq("status", "awaiting_executor"))
    .collect();
  return feedFor(ex, waiting);
}
