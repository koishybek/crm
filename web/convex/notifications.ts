import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./lib/functions";
import { currentUser, inScope, scopeOf } from "./lib/access";
import { toNotification } from "./lib/dto";
import { ACTIVE_STATUSES } from "../src/data/catalog";

/** Сколько горящих сроков показывает колокольчик: просрочки и «скоро срок» (в ближайшие 3 часа). */
const LATE_MAX = 4;
const SOON_MAX = 3;
const SOON_MS = 3 * 3600_000;

type Burning = { late: Doc<"orders">[]; soon: Doc<"orders">[] };

/**
 * Горящие сроки сотрудника — по индексу by_status (статус, срок) в диапазоне сроков (E23): читаем только просроченные
 * и истекающие в ближайшие 3 часа и останавливаемся, когда набрали, сколько показываем. Порядок — как раньше:
 * статусы по порядку ACTIVE_STATUSES, внутри — по сроку. Срок хранится строкой toISOString — порядок строк = порядок времени.
 */
async function staffBurning(ctx: QueryCtx, scope: string[] | null, now: number): Promise<Burning> {
  const out: Burning = { late: [], soon: [] };
  const nowIso = new Date(now).toISOString();
  const soonIso = new Date(now + SOON_MS).toISOString();
  for (const s of ACTIVE_STATUSES) {
    if (out.late.length < LATE_MAX) {
      for await (const o of ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s).lt("deadline", nowIso))) {
        if (!inScope(scope, o.category) || !(Date.parse(o.deadline) < now)) continue;
        out.late.push(o);
        if (out.late.length >= LATE_MAX) break;
      }
    }
    if (out.soon.length < SOON_MAX) {
      for await (const o of ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s).gte("deadline", nowIso).lt("deadline", soonIso))) {
        const t = Date.parse(o.deadline);
        if (!inScope(scope, o.category) || !(t >= now && t - now < SOON_MS)) continue;
        out.soon.push(o);
        if (out.soon.length >= SOON_MAX) break;
      }
    }
  }
  return out;
}

/**
 * Горящие сроки исполнителя: только его активные заказы — по индексу by_executor (исполнитель, статус), без истории
 * выполненных (E23). Статусы — по алфавиту, как их отдаёт индекс: порядок в колокольчике прежний.
 */
async function executorBurning(ctx: QueryCtx, executorId: Id<"executors">, now: number): Promise<Burning> {
  const out: Burning = { late: [], soon: [] };
  for (const s of [...ACTIVE_STATUSES].sort()) {
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_executor", (q) => q.eq("executorId", executorId).eq("status", s))
      .collect();
    for (const o of rows) {
      const t = Date.parse(o.deadline);
      if (t < now) out.late.push(o);
      else if (t >= now && t - now < SOON_MS) out.soon.push(o);
    }
  }
  return { late: out.late.slice(0, LATE_MAX), soon: out.soon.slice(0, SOON_MAX) };
}

/** Колокольчик: последние уведомления + горящие сроки (считаются на лету, в базе не хранятся). */
export const mine = query({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const me = await currentUser(ctx);
    if (!me) return null;
    const items = await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", me._id)).order("desc").take(20);
    const base = me.role === "executor" ? "/w/orders/" : "/orders/";
    // «Сейчас» приходит из браузера: не дата — горящих сроков нет (как и раньше: сравнения с NaN ложны).
    const valid = Number.isFinite(now) && Math.abs(now) <= 8e15;
    const empty: Burning = { late: [], soon: [] };
    const burning = !valid ? empty : me.role === "executor" ? (me.executorId ? await executorBurning(ctx, me.executorId, now) : empty) : await staffBurning(ctx, scopeOf(me), now);
    return {
      items: items.map(toNotification),
      alerts: [
        ...burning.late.map((o) => ({ id: `late-${o._id}`, text: `Просрочка по заказу №${o.number}`, link: base + o._id, tone: "bad" as const })),
        ...burning.soon.map((o) => ({ id: `soon-${o._id}`, text: `Скоро срок: заказ №${o.number}`, link: base + o._id, tone: "warn" as const })),
      ],
    };
  },
});

export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) return;
    for (const n of await ctx.db.query("notifications").withIndex("by_user_read", (q) => q.eq("userId", me._id).eq("read", false)).collect()) {
      await ctx.db.patch(n._id, { read: true });
    }
  },
});
