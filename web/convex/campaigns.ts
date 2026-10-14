// Кампании (ТЗ п.6.6, п.28.5): заявки, заказы, выручка, CPL/CPO/ROMI по рекламной кампании за период и расходы
// на кампании по месяцам. Деньги компании — только владельцу. Формулы — src/data/campaigns.ts (общие с интерфейсом).
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./lib/functions";
import { OWNER, requirePerm, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { cleanMoney } from "./lib/limits";
import { FIRST_MONTH, MONTH_RE, monthLabel, monthOf } from "../src/data/analytics";
import { campaignRows, type CampaignRow, type CampaignSpendRow } from "../src/data/campaigns";
import { cleanUtmValue } from "../src/data/utm";
import { money } from "../src/lib/format";
import { requireModule } from "./lib/tenant";

/** Период отчёта — не длиннее года: запрос «за всё время» упёрся бы в лимиты чтения. */
const MAX_SPAN_MS = 366 * 86400_000;
/** Кампании для подсказки в редакторе расходов — из заявок последних 120 дней. */
const KNOWN_DAYS = 120;
const MAX_ITEMS = 50;

function span(from: string, to: string): { from: number; to: number } {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (!Number.isFinite(f) || !Number.isFinite(t) || f > t) throw new ConvexError("Неверный период");
  if (t - f > MAX_SPAN_MS) throw new ConvexError("Период — не больше года");
  return { from: f, to: t };
}

async function spendRows(ctx: Parameters<typeof requireRole>[0], first: string, last: string): Promise<CampaignSpendRow[]> {
  const rows = await ctx.db
    .query("campaignSpend")
    .withIndex("by_month", (q) => q.gte("month", first).lte("month", last))
    .collect();
  return rows.map((r) => ({ month: r.month, campaign: r.campaign, amount: r.amount }));
}

/** Карточка «Кампании»: строки по кампаниям за период [from; to]. */
export const stats = query({
  args: { from: v.string(), to: v.string() },
  handler: async (ctx, a): Promise<CampaignRow[]> => {
    // Суммы компании — как в «Аналитике» (convex/stats.ts viewer): право «Выплаты мастерам и маржа», руководителю — нет.
    const me = await requirePerm(ctx, "money.payouts");
    if (me.role === "manager") throw new ConvexError("Нет доступа");
    await requireModule(ctx, me.tenantId, "analytics_pro");
    const s = span(a.from, a.to);
    const fromIso = new Date(s.from).toISOString();
    const toIso = new Date(s.to).toISOString();
    const [leads, done, spend] = await Promise.all([
      ctx.db
        .query("leads")
        .withIndex("by_created", (q) => q.gte("createdAt", fromIso).lte("createdAt", toIso))
        .collect(),
      ctx.db
        .query("orders")
        .withIndex("by_done", (q) => q.gte("doneAt", fromIso).lte("doneAt", toIso))
        .collect(),
      spendRows(ctx, monthOf(s.from), monthOf(s.to)),
    ]);
    return campaignRows(leads, done, spend, s);
  },
});

/** Редактор расходов: суммы за месяц и кампании, которые встречались в заявках недавно. */
export const spendMonth = query({
  args: { month: v.string() },
  handler: async (ctx, { month }): Promise<{ rows: CampaignSpendRow[]; known: string[] }> => {
    await requireRole(ctx, OWNER);
    if (!MONTH_RE.test(month)) throw new ConvexError("Неверный месяц");
    const since = new Date(Date.now() - KNOWN_DAYS * 86400_000).toISOString();
    const recent = await ctx.db
      .query("leads")
      .withIndex("by_created", (q) => q.gte("createdAt", since))
      .order("desc")
      .take(3000);
    const known = [...new Set(recent.map((l) => l.campaign).filter((c): c is string => !!c))].sort((x, y) => x.localeCompare(y)).slice(0, 200);
    return { rows: await spendRows(ctx, month, month), known };
  },
});

/**
 * Расходы на кампании за месяц: есть строка — обновляем, нет — создаём, 0 — убираем. Название кампании — как в
 * utm_campaign (то же правило очистки). Ничего не поменялось — ни записи, ни строки в журнале.
 */
export const setSpend = mutation({
  args: { month: v.string(), items: v.array(v.object({ campaign: v.string(), amount: v.number() })) },
  handler: async (ctx, { month, items }): Promise<{ changed: number }> => {
    const me = await requireRole(ctx, OWNER);
    await requireModule(ctx, me.tenantId, "analytics_pro");
    if (!MONTH_RE.test(month) || month < FIRST_MONTH) throw new ConvexError("Неверный месяц");
    if (month > monthOf(Date.now())) throw new ConvexError("Расходы вносятся за прошедшие месяцы и текущий");
    if (items.length > MAX_ITEMS) throw new ConvexError(`Не больше ${MAX_ITEMS} кампаний за раз`);
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const item of items) {
      const campaign = cleanUtmValue(item.campaign);
      if (!campaign) throw new ConvexError("Укажите название кампании");
      if (seen.has(campaign)) throw new ConvexError(`Кампания «${campaign}» указана дважды`);
      seen.add(campaign);
      const amount = cleanMoney(item.amount, `Расходы «${campaign}»`);
      const row = await ctx.db
        .query("campaignSpend")
        .withIndex("by_month", (q) => q.eq("month", month).eq("campaign", campaign))
        .first();
      const before = row?.amount ?? 0;
      if (before === amount) continue;
      if (row && amount === 0) await ctx.db.delete(row._id);
      else if (row) await ctx.db.patch(row._id, { amount, updatedAt: nowIso(), updatedBy: me._id });
      else await ctx.db.insert("campaignSpend", { month, campaign, amount, updatedAt: nowIso(), updatedBy: me._id });
      parts.push(`«${campaign}» ${money(before)} → ${money(amount)}`);
    }
    if (!parts.length) return { changed: 0 };
    await audit(ctx, me, "settings.campaign_spend_updated", `Расходы на кампании за ${monthLabel(month)}: ${parts.join(", ")}`, { meta: { month, count: parts.length } });
    return { changed: parts.length };
  },
});
