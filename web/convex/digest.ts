// Утренняя сводка в Telegram (9:00 по Алматы) и короткая сводка по команде /orders для сотрудников.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { can, inScope, scopeOf, type Me } from "./lib/access";
import { canSeeCompanyMoney } from "../src/data/permissions";
import { almatyDayStart, esc, whenAlmaty } from "./lib/tg";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { ACTIVE_STATUSES, APP_NAME, FINISHED_STATUSES, SOURCES } from "../src/data/catalog";
import { sums } from "../src/data/analytics";
import { contactsOpen, paidAmount, payout } from "../src/data/logic";
import { money } from "../src/lib/format";

async function activeOrders(ctx: QueryCtx) {
  const out: Doc<"orders">[] = [];
  for (const s of ACTIVE_STATUSES) out.push(...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()));
  return out;
}

/** Цифры для сотрудника: вчера (по Алматы) и прямо сейчас. Руководителю — только его направления. */
async function numbers(ctx: QueryCtx, me: Me, now: number) {
  const scope = scopeOf(me);
  const today = almatyDayStart(now);
  const from = new Date(today - 86400_000).toISOString();
  const to = new Date(today).toISOString();
  const cat = scope ? await loadCatalog(ctx) : null;
  const catOf = (sid: string) => cat?.services.find((s) => s.id === sid)?.category ?? "";
  const leads = (await ctx.db.query("leads").withIndex("by_created", (q) => q.gte("createdAt", from).lt("createdAt", to)).collect()).filter((l) => !scope || inScope(scope, catOf(l.serviceId)));
  const done = (await ctx.db.query("orders").withIndex("by_done", (q) => q.gte("doneAt", from).lt("doneAt", to)).collect()).filter((o) => FINISHED_STATUSES.includes(o.status) && inScope(scope, o.category));
  const active = (await activeOrders(ctx)).filter((o) => inScope(scope, o.category));
  const bySource = new Map<string, number>();
  for (const l of leads) bySource.set(l.source, (bySource.get(l.source) ?? 0) + 1);
  // Долг клиентов — по сданным работам, ещё не оплаченным полностью; сторнированные оплаты не считаются.
  const unpaid = [...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "awaiting_payment")).collect()), ...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "done")).collect())];
  const debt = unpaid.filter((o) => inScope(scope, o.category)).reduce((s, o) => s + Math.max(0, o.clientPrice - paidAmount(o)), 0);
  const totals = sums(done);
  return {
    leads: leads.length,
    sources: [...bySource.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${SOURCES[s as keyof typeof SOURCES]?.label ?? s} ${n}`),
    done: done.length,
    revenue: totals.revenue,
    margin: totals.margin,
    active: active.length,
    waiting: active.filter((o) => o.status === "awaiting_executor").length,
    fresh: active.filter((o) => o.status === "new").length,
    overdue: active.filter((o) => Date.parse(o.deadline) < now).length,
    debt,
  };
}

function staffText(me: Me, n: Awaited<ReturnType<typeof numbers>>, morning: boolean): string {
  const lines = [morning ? `<b>☀️ Доброе утро${me.name ? `, ${esc(me.name.split(" ")[0]!)}` : ""}!</b>` : `<b>Сводка ${esc(APP_NAME)}</b>`, ""];
  if (morning) {
    lines.push(`Вчера: заявок <b>${n.leads}</b>${n.sources.length ? ` (${esc(n.sources.join(", "))})` : ""}, выполнено заказов <b>${n.done}</b>`);
    // Деньги в сводке — по правам (ТЗ п.5.12), как на «Главной».
    if (canSeeCompanyMoney(me)) lines.push(`Выручка ${esc(money(n.revenue))}, маржа <b>${esc(money(n.margin))}</b>`);
    lines.push("");
  }
  lines.push(`Сейчас в работе: <b>${n.active}</b>`);
  if (n.fresh) lines.push(`• без цены / не опубликованы: ${n.fresh}`);
  if (n.waiting) lines.push(`• ждут исполнителя: ${n.waiting}`);
  if (n.overdue) lines.push(`• 🔴 просрочено: <b>${n.overdue}</b>`);
  if (can(me, "money.view") && n.debt) lines.push(`• клиенты должны: ${esc(money(n.debt))}`);
  return lines.join("\n");
}

/** Крон 9:00 по Алматы: сотрудникам — сводка, мастерам — заказы на сегодня. */
export const run = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const appUrl = env("APP_URL");
    const users = (await ctx.db.query("users").collect()).filter((u) => u.telegramChatId && u.active !== false && u.role);
    const endOfToday = almatyDayStart(now) + 86400_000;
    for (const u of users as Me[]) {
      if (u.role === "executor") {
        if (!u.executorId) continue;
        const mine = (await ctx.db.query("orders").withIndex("by_executor", (q) => q.eq("executorId", u.executorId)).collect()).filter(
          (o) => ACTIVE_STATUSES.includes(o.status) && Date.parse(o.deadline) < endOfToday,
        );
        if (!mine.length) continue;
        mine.sort((a, b) => a.deadline.localeCompare(b.deadline));
        // Адрес — по тому же правилу, что в кабинете: у ещё не подтверждённого заказа его нет (аудит L-5).
        const list = mine.map((o) => `• №${o.number} — ${esc(whenAlmaty(o.deadline, now))}, ${esc(o.city)}${o.address && contactsOpen(o) ? `, ${esc(o.address)}` : ""} · ${esc(money(payout(o)))}`);
        const html = [`<b>☀️ Доброе утро! Заказы на сегодня: ${mine.length}</b>`, "", ...list, "", "Кнопки по каждому — команда /orders"].join("\n");
        await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId: u.telegramChatId!, text: "", html, buttons: appUrl ? [[{ text: "Мои заказы", url: `${appUrl.replace(/\/$/, "")}/w/my` }]] : undefined });
        continue;
      }
      const n = await numbers(ctx, u, now);
      await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId: u.telegramChatId!, text: "", html: staffText(u, n, true), buttons: appUrl ? [[{ text: "Открыть кабинет", url: appUrl }]] : undefined });
    }
  },
});

/** /orders от сотрудника — сводка «сейчас». */
export const _staffSnapshot = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }): Promise<string | null> => {
    const u = await ctx.db.query("users").withIndex("by_telegram_chat", (q) => q.eq("telegramChatId", chatId)).first();
    if (!u || !u.role || u.role === "executor" || u.active === false) return null;
    return staffText(u as Me, await numbers(ctx, u as Me, Date.now()), false);
  },
});

