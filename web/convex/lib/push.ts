// Web push из notify (ТЗ п.23.6): если у человека есть подписка и ключи VAPID заданы — после коммита отправка
// (convex/push.ts). Здесь — то, что нужно мутации: проверка и постановка в очередь.
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { vapidConfig } from "./webpush";

export async function queuePush(ctx: MutationCtx, userId: Id<"users">, text: string, link: string | undefined): Promise<void> {
  if (!vapidConfig()) return;
  const sub = await ctx.db
    .query("pushSubscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (sub) await ctx.scheduler.runAfter(0, internal.push.send, { userId, text, link });
}
