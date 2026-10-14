// Чтение предрасчёта аналитики (convex/stats.ts, ТЗ §26.6): итоги за период по дням или по месяцам — O(дней × разрезов).
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "./functions";
import { DAILY_SERIES_MAX, daysBetween, matchesFilter, monthBounds, monthOfDay, shiftDay, shiftMonth, summarize, type Cell, type Counts, type StatsFilter, type TotalKey } from "../../src/data/dailyStats";

export const rowsOf = (ctx: QueryCtx, grain: Doc<"dailyStats">["grain"], from: string, to: string) =>
  ctx.db
    .query("dailyStats")
    .withIndex("by_period", (q) => q.eq("grain", grain).gte("period", from).lte("period", to))
    .collect();

export interface PeriodRow {
  /** День или месяц точки ряда. */
  period: string;
  cell: Cell;
}

/**
 * Итоги за период (дни YYYY-MM-DD включительно). До DAILY_SERIES_MAX дней — дневные итоги (ряд по дням); длиннее — целые
 * месяцы месячными итогами, края — днями (ряд по месяцам): так даже год читается за пару тысяч строк.
 */
export async function readRange(ctx: QueryCtx, from: string, to: string, f: StatsFilter): Promise<{ grain: "day" | "month"; rows: PeriodRow[] }> {
  const pick = (rows: Doc<"dailyStats">[], period: (r: Doc<"dailyStats">) => string): PeriodRow[] => rows.filter((r) => matchesFilter(r, f)).map((r) => ({ period: period(r), cell: r }));
  if (daysBetween(from, to) <= DAILY_SERIES_MAX) return { grain: "day", rows: pick(await rowsOf(ctx, "day", from, to), (r) => r.period) };
  const byMonth = (r: Doc<"dailyStats">) => monthOfDay(r.period);
  const firstFull = from.endsWith("-01") ? monthOfDay(from) : shiftMonth(monthOfDay(from), 1);
  const lastFull = monthBounds(monthOfDay(to)).last === to ? monthOfDay(to) : shiftMonth(monthOfDay(to), -1);
  if (firstFull > lastFull) return { grain: "month", rows: pick(await rowsOf(ctx, "day", from, to), byMonth) };
  const head = `${firstFull}-01`;
  const tail = monthBounds(lastFull).last;
  const rows = pick(await rowsOf(ctx, "month", firstFull, lastFull), (r) => r.period);
  if (from < head) rows.push(...pick(await rowsOf(ctx, "day", from, shiftDay(head, -1)), byMonth));
  if (to > tail) rows.push(...pick(await rowsOf(ctx, "day", shiftDay(tail, 1), to), byMonth));
  return { grain: "month", rows };
}

/** Итог за период одной строкой. */
export async function totalsOf(ctx: QueryCtx, from: string, to: string, f: StatsFilter = {}): Promise<Counts<TotalKey>> {
  return summarize((await readRange(ctx, from, to, f)).rows.map((r) => r.cell)).t;
}
