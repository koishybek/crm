import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { currentUser, inScope, scopeOf } from "./lib/access";
import { toNotification } from "./lib/dto";
import { ACTIVE_STATUSES } from "../src/data/catalog";

/** Колокольчик: последние уведомления + горящие сроки (считаются на лету, в базе не хранятся). */
export const mine = query({
  args: { now: v.number() },
  handler: async (ctx, { now }) => {
    const me = await currentUser(ctx);
    if (!me) return null;
    const items = await ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", me._id)).order("desc").take(20);
    let scope: Doc<"orders">[] = [];
    if (me.role === "executor") {
      scope = me.executorId ? await ctx.db.query("orders").withIndex("by_executor", (q) => q.eq("executorId", me.executorId)).collect() : [];
    } else {
      for (const s of ACTIVE_STATUSES) scope.push(...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()));
    }
    const visible = scopeOf(me);
    const active = scope.filter((o) => ACTIVE_STATUSES.includes(o.status) && inScope(visible, o.category));
    const base = me.role === "executor" ? "/w/orders/" : "/orders/";
    const late = active.filter((o) => Date.parse(o.deadline) < now);
    const soon = active.filter((o) => {
      const t = Date.parse(o.deadline);
      return t >= now && t - now < 3 * 3600_000;
    });
    return {
      items: items.map(toNotification),
      alerts: [
        ...late.slice(0, 4).map((o) => ({ id: `late-${o._id}`, text: `Просрочка по заказу №${o.number}`, link: base + o._id, tone: "bad" as const })),
        ...soon.slice(0, 3).map((o) => ({ id: `soon-${o._id}`, text: `Скоро срок: заказ №${o.number}`, link: base + o._id, tone: "warn" as const })),
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
