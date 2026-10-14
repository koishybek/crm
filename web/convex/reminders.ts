import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation } from "./_generated/server";
import { almatyStamp, audit } from "./lib/audit";
import { executorUser, notify, staffRoster } from "./lib/domain";
import { markOk } from "./lib/health";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import { loadCatalog } from "./catalog";

const SOON_MS = 2 * 3600_000;
/**
 * Заказов с напоминанием за один запуск. Остальные — следующим запуском сразу после этого: транзакция не растёт
 * вместе с базой (E22), а уже отмеченные заказы второй раз не уведомляются.
 */
export const REMINDER_BATCH = 50;

type Due = { o: Doc<"orders">; overdue: boolean };

/**
 * Раз в 15 минут: «скоро срок» исполнителю и оператору, «просрочка» — им же и владельцу. Каждое — один раз.
 * Читаем не все активные заказы, а только со сроком до «сейчас + 2 часа» — диапазон индекса by_status (статус, срок);
 * сотрудников — один раз на запуск, список направления — один раз на направление. Срок хранится строкой
 * toISOString (UTC), поэтому порядок строк в индексе совпадает с порядком времени.
 */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const horizon = new Date(now + SOON_MS).toISOString();
    let checked = 0;
    let more = false;
    const due: Due[] = [];
    scan: for (const s of ACTIVE_STATUSES) {
      const range = ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s).lte("deadline", horizon));
      for await (const o of range) {
        checked++;
        const t = Date.parse(o.deadline);
        const overdue = t < now && !o.overdueNotified;
        const soon = !overdue && t >= now && t - now <= SOON_MS && !o.soonNotified;
        if (!overdue && !soon) continue;
        if (due.length >= REMINDER_BATCH) {
          more = true;
          break scan;
        }
        due.push({ o, overdue });
      }
    }

    if (due.length) {
      const cat = await loadCatalog(ctx);
      const roster = await staffRoster(ctx);
      const executors = new Map<Id<"executors">, Id<"users"> | undefined>();
      const executorOf = async (id: Id<"executors">) => {
        if (!executors.has(id)) executors.set(id, (await executorUser(ctx, id))?._id);
        return executors.get(id);
      };
      for (const { o, overdue } of due) {
        const ex = o.executorId ? await executorOf(o.executorId) : undefined;
        const label = `№${o.number} (${cat.label(o.serviceId)})`;
        const staff = roster.staff(o.category);
        if (overdue) {
          const escalated = [...new Set([...roster.owners, ...staff])];
          await ctx.db.patch(o._id, { overdueNotified: true, soonNotified: true });
          await notify(ctx, escalated, `Просрочка: заказ ${label}`, { link: `/orders/${o._id}`, tone: "bad", email: { kind: "order_overdue" } });
          if (ex) await notify(ctx, [ex], `Просрочен срок по заказу ${label} — сообщите оператору, когда закончите`, { link: `/w/orders/${o._id}`, tone: "bad" });
          // ТЗ п.15: эскалация — ключевое событие заказа; её делает система, а не сотрудник.
          await audit(ctx, "Система", "order.overdue", `Заказ №${o.number}: просрочен срок ${almatyStamp(o.deadline)} — уведомлены владелец и ответственные (${escalated.length})${ex ? " и исполнитель" : ""}`, {
            entityId: o._id,
            meta: { deadline: o.deadline, status: o.status, notified: escalated.length, executorNotified: !!ex },
          });
        } else {
          await ctx.db.patch(o._id, { soonNotified: true });
          await notify(ctx, staff, `Скоро срок: заказ ${label}`, { link: `/orders/${o._id}`, tone: "warn" });
          if (ex) await notify(ctx, [ex], `Через 2 часа срок по заказу ${label}`, { link: `/w/orders/${o._id}`, tone: "warn" });
        }
      }
    }
    // Не всё уместилось в один запуск — продолжаем сразу, не дожидаясь следующего срабатывания крона.
    if (more) await ctx.scheduler.runAfter(0, internal.reminders.run, {});
    // Отметка для «Состояния системы»: давно нет — крон не запускается или падает.
    await markOk(ctx, "reminders", `Проверено активных заказов: ${checked}`);
  },
});
