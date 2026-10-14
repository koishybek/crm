// Аналитика владельца (ТЗ п.5 «Dashboard: выплаты, маржа», п.17): расходы на рекламу, выплаты исполнителям
// и кто на самом деле завёл заявку. Только с правом «Аналитика» и правами на деньги (ТЗ п.5.12; по умолчанию — владелец).
// Формулы — общие с интерфейсом (src/data/analytics.ts).
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { can, noAccess, requirePerm, STAFF } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { cleanMoney } from "./lib/limits";
import { source } from "./schema";
import { FIRST_MONTH, MONTH_RE, monthLabel, monthOf, payoutSummary, type AdSpendRow, type PayoutSummary } from "../src/data/analytics";
import { totalsOf } from "./lib/statsRead";
import { dayOf, dayStart, n, todayDay } from "../src/data/dailyStats";
import { SOURCE_IDS, SOURCES } from "../src/data/catalog";
import type { SourceId } from "../src/data/types";
import { money } from "../src/lib/format";

/**
 * Заявки, которые пришли сами и которые никто из команды не ведёт (E12): бот Telegram, сайт, API, WhatsApp, OLX,
 * AI по звонку, который не принимал никто из сотрудников, — пока их не взяли в работу, оператора у них нет.
 * В работе операторов их не засчитываем никому. Взятую в работу заявку засчитываем тому, кто её взял.
 * Заявки, заведённые до учёта источника (нет origin), каналы записывали на владельца: кто завёл такую заявку —
 * по записи «lead.created» в журнале (автор — сотрудник или «Telegram», «Сайт», «API», «AI»…).
 */
export async function autoLeadIds(ctx: QueryCtx, leads: readonly Doc<"leads">[]): Promise<string[]> {
  const owners = new Set<string>((await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect()).map((u) => u._id));
  const out: string[] = [];
  for (const l of leads) {
    if (!l.operatorId) {
      out.push(l._id);
      continue;
    }
    // У новых заявок оператор настоящий: завёл сам, взял в работу или принял звонок.
    if (l.origin) continue;
    // Каналы записывали заявку на владельца; AI-заявку из звонка — на сотрудника, который его принял: это его работа.
    if (!owners.has(l.operatorId)) continue;
    const created = await ctx.db
      .query("audit")
      .withIndex("by_entity", (q) => q.eq("entity", "lead").eq("entityId", l._id))
      .first();
    if (!created || created.action !== "lead.created" || created.actorId) continue;
    // Звонок принял или загрузил сам владелец — AI лишь оформил его разговор.
    const call = l.callId ? await ctx.db.get(l.callId) : null;
    if (call?.operatorId === l.operatorId) continue;
    out.push(l._id);
  }
  return out;
}

/** Расходы на рекламу за месяцы first…last (YYYY-MM) включительно. */
export async function spendRows(ctx: QueryCtx, first: string, last: string): Promise<AdSpendRow[]> {
  const rows = await ctx.db
    .query("adSpend")
    .withIndex("by_month", (q) => q.gte("month", first).lte("month", last))
    .collect();
  return rows.map((r) => ({ month: r.month, source: r.source, amount: r.amount }));
}

/** Месяц расходов: формат YYYY-MM, не раньше FIRST_MONTH и не позже текущего (по Алматы). */
function checkMonth(month: string): void {
  if (!MONTH_RE.test(month) || month < FIRST_MONTH) throw new ConvexError("Неверный месяц");
  if (month > monthOf(Date.now())) throw new ConvexError("Расходы вносятся за прошедшие месяцы и текущий");
}

/** Расходы на рекламу за месяц по источникам — для редактора на экране «Аналитика». */
export const adSpendMonth = query({
  args: { month: v.string() },
  handler: async (ctx, { month }): Promise<AdSpendRow[]> => {
    const me = await requirePerm(ctx, "analytics.view", STAFF);
    if (!can(me, "money.view")) throw new ConvexError(noAccess("money.view"));
    if (!MONTH_RE.test(month)) throw new ConvexError("Неверный месяц");
    return spendRows(ctx, month, month);
  },
});

/**
 * Владелец вносит расходы на рекламу за месяц по источникам (ТЗ п.17 «стоимость привлечения»): строка есть —
 * обновляем, нет — создаём, 0 — расходов не было, строку убираем. Ничего не поменялось — ни записи, ни шума в журнале.
 */
export const setAdSpend = mutation({
  args: { month: v.string(), items: v.array(v.object({ source, amount: v.number() })) },
  handler: async (ctx, { month, items }): Promise<{ changed: number }> => {
    const me = await requirePerm(ctx, "analytics.view", STAFF);
    if (!can(me, "money.edit")) throw new ConvexError(noAccess("money.edit"));
    checkMonth(month);
    if (items.length > SOURCE_IDS.length) throw new ConvexError("Слишком много строк");
    const seen = new Set<SourceId>();
    const changes: Record<string, { from: number; to: number }> = {};
    const parts: string[] = [];
    for (const item of items) {
      if (seen.has(item.source)) throw new ConvexError("Источник указан дважды");
      seen.add(item.source);
      const amount = cleanMoney(item.amount, `Расходы «${SOURCES[item.source].label}»`);
      const row = await ctx.db
        .query("adSpend")
        .withIndex("by_month", (q) => q.eq("month", month).eq("source", item.source))
        .first();
      const before = row?.amount ?? 0;
      if (before === amount) continue;
      if (row && amount === 0) await ctx.db.delete(row._id);
      else if (row) await ctx.db.patch(row._id, { amount, updatedAt: nowIso(), updatedBy: me._id });
      else await ctx.db.insert("adSpend", { month, source: item.source, amount, updatedAt: nowIso(), updatedBy: me._id });
      changes[item.source] = { from: before, to: amount };
      parts.push(`${SOURCES[item.source].label} ${money(before)} → ${money(amount)}`);
    }
    if (!parts.length) return { changed: 0 };
    await audit(ctx, me, "settings.ad_spend_updated", `Расходы на рекламу за ${monthLabel(month)}: ${parts.join(", ")}`, { meta: { month, changes } });
    return { changed: parts.length };
  },
});

/** Сводка выплат с именами мастеров, которым компания должна. */
export interface PayoutView {
  period: PayoutSummary["period"];
  owed: { total: number; orders: number; executors: { id: string; name: string; amount: number; orders: number }[] };
  /** Выплачено мастерам с даты from — по датам выплат из реестра (а не по дате выполнения заказов). */
  paidOut: { amount: number; count: number };
}

/**
 * Выплаты исполнителям для «Главной» и «Аналитики» владельца: начислено и выплачено за заказы, выполненные
 * с дня from (по Алматы) по сегодня — из предрасчёта (convex/stats.ts), выплачено мастерам с этого дня по реестру
 * и долг исполнителям сейчас — по мастерам.
 */
export const payouts = query({
  args: { from: v.string() },
  handler: async (ctx, { from }): Promise<PayoutView> => {
    await requirePerm(ctx, "money.payouts", STAFF);
    const start = Date.parse(from);
    if (Number.isNaN(start)) throw new ConvexError("Неверная дата");
    const fromDay = dayOf(new Date(start).toISOString());
    const registry = await ctx.db
      .query("payouts")
      .withIndex("by_at", (q) => q.gte("at", new Date(dayStart(fromDay)).toISOString()))
      .collect();
    const paidOut = { amount: registry.reduce((s, p) => s + p.amount, 0), count: registry.length };
    // Начислено за период — итоги дней (O(дней)); долг сейчас — невыплаченные выполненные по индексу, без всей истории.
    const t = await totalsOf(ctx, fromDay, todayDay());
    const unpaid = await ctx.db
      .query("orders")
      .withIndex("by_payout", (q) => q.eq("payoutPaid", false).gt("doneAt", ""))
      .collect();
    const accrued = n(t, "payouts");
    const paid = n(t, "accruedPaid");
    const summary = {
      period: { accrued, paid, unpaid: accrued - paid, orders: n(t, "done") },
      owed: payoutSummary(unpaid, { from: start, to: Date.now() }).owed,
    };
    const executors = await Promise.all(
      summary.owed.executors.map(async (x) => {
        const id = ctx.db.normalizeId("executors", x.id);
        const e = id ? await ctx.db.get(id) : null;
        return { ...x, name: e?.name ?? "Исполнитель удалён" };
      }),
    );
    return { ...summary, owed: { ...summary.owed, executors }, paidOut };
  },
});
