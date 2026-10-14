// Кампании (ТЗ п.6.6, п.28.5): заявки, заказы, выручка и стоимость привлечения по рекламной кампании (utm_campaign).
// Чистые функции — общие для сервера (convex/campaigns.ts) и карточки «Кампании»; формулы — из analytics.ts.
import { costs, doneWithin, monthShare, sums, type Costs, type Span } from "./analytics";
import type { Lead, Order } from "./types";
import type { RevenueLike } from "./logic";

/** Расход на кампанию за месяц (YYYY-MM), ₸. */
export interface CampaignSpendRow {
  month: string;
  campaign: string;
  amount: number;
}

export interface CampaignRow extends Costs {
  campaign: string;
  /** Заявки кампании за период. */
  leads: number;
  /** Сколько из них стали заказом. */
  orders: number;
  conversion: number;
  /** Заказы кампании, выполненные за период (возвраты не считаются), — по ним выручка и маржа. */
  done: number;
  revenue: number;
  margin: number;
  /** Расходы на кампанию за период — доля месячных сумм. */
  spend: number;
}

type LeadLike = Pick<Lead, "status" | "createdAt"> & { campaign?: string };
type OrderLike = Pick<Order, "status" | "doneAt" | "payoutMode" | "payoutValue"> & RevenueLike & { campaign?: string };

const inSpan = (iso: string, s: Span) => {
  const t = Date.parse(iso);
  return t >= s.from && t <= s.to;
};

/** Расходы за период по кампаниям: месячная сумма — пропорционально дням периода. */
export function campaignSpendWithin(rows: readonly CampaignSpendRow[], s: Span): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const share = monthShare(r.month, s);
    if (share > 0 && r.amount > 0) out.set(r.campaign, (out.get(r.campaign) ?? 0) + r.amount * share);
  }
  return out;
}

/** Строки по кампаниям за период: только кампании с заявками, выполненными заказами или расходами. */
export function campaignRows(leads: readonly LeadLike[], orders: readonly OrderLike[], spendRows: readonly CampaignSpendRow[], s: Span): CampaignRow[] {
  const periodLeads = leads.filter((l) => l.campaign && inSpan(l.createdAt, s));
  const done = doneWithin(orders, s).filter((o) => o.campaign);
  const spend = campaignSpendWithin(spendRows, s);
  const names = new Set<string>([...periodLeads.map((l) => l.campaign!), ...done.map((o) => o.campaign!), ...spend.keys()]);
  return [...names]
    .map((campaign): CampaignRow => {
      const mine = periodLeads.filter((l) => l.campaign === campaign);
      const converted = mine.filter((l) => l.status === "converted").length;
      const money = sums(done.filter((o) => o.campaign === campaign));
      const spent = spend.get(campaign) ?? 0;
      return {
        campaign,
        leads: mine.length,
        orders: converted,
        conversion: mine.length ? converted / mine.length : 0,
        done: money.count,
        revenue: money.revenue,
        margin: money.margin,
        spend: spent,
        ...costs(spent, mine.length, converted, money.margin),
      };
    })
    .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads || a.campaign.localeCompare(b.campaign));
}

/** Итог по кампаниям — те же формулы на суммах. */
export function campaignTotals(rows: readonly CampaignRow[]): Omit<CampaignRow, "campaign"> {
  const t = rows.reduce(
    (a, r) => ({ spend: a.spend + r.spend, leads: a.leads + r.leads, orders: a.orders + r.orders, done: a.done + r.done, revenue: a.revenue + r.revenue, margin: a.margin + r.margin }),
    { spend: 0, leads: 0, orders: 0, done: 0, revenue: 0, margin: 0 },
  );
  return { ...t, conversion: t.leads ? t.orders / t.leads : 0, ...costs(t.spend, t.leads, t.orders, t.margin) };
}
