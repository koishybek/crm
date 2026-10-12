import { internalMutation } from "./_generated/server";
import { executorUser, notify, staffIds } from "./lib/domain";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import { loadCatalog } from "./catalog";

const SOON_MS = 2 * 3600_000;

/** Раз в 15 минут: «скоро срок» исполнителю и оператору, «просрочка» — им же и владельцу. Каждое — один раз. */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cat = await loadCatalog(ctx);
    const owners = (await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect()).map((u) => u._id);
    for (const s of ACTIVE_STATUSES) {
      for (const o of await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()) {
        const t = Date.parse(o.deadline);
        const ex = o.executorId ? (await executorUser(ctx, o.executorId))?._id : undefined;
        const label = `№${o.number} (${cat.label(o.serviceId)})`;
        const staff = await staffIds(ctx, o.category);
        if (t < now && !o.overdueNotified) {
          await ctx.db.patch(o._id, { overdueNotified: true, soonNotified: true });
          await notify(ctx, [...owners, ...staff], `Просрочка: заказ ${label}`, { link: `/orders/${o._id}`, tone: "bad" });
          if (ex) await notify(ctx, [ex], `Просрочен срок по заказу ${label} — сообщите оператору, когда закончите`, { link: `/w/orders/${o._id}`, tone: "bad" });
        } else if (t >= now && t - now <= SOON_MS && !o.soonNotified) {
          await ctx.db.patch(o._id, { soonNotified: true });
          await notify(ctx, staff, `Скоро срок: заказ ${label}`, { link: `/orders/${o._id}`, tone: "warn" });
          if (ex) await notify(ctx, [ex], `Через 2 часа срок по заказу ${label}`, { link: `/w/orders/${o._id}`, tone: "warn" });
        }
      }
    }
  },
});
