// «Аналитика» (ТЗ п.17, 17.10, 23.4): свой период и пресеты, фильтры по городу, направлению и источнику, сравнение
// с прошлым периодом и по месяцам, полная таблица исполнителей, повторные клиенты. Цифры — из предрасчёта
// (convex/stats.ts, O(дней)), формулы — общие с сервером (src/data/dailyStats.ts, src/data/analytics.ts).
// Владельцу — всё; руководителю направления — его направления и без денег (сервер денег ему не отдаёт).
import { BadgeCheck, Ban, Briefcase, ChartNoAxesColumn, Banknote, FileText, Percent, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { CATEGORIES, SOURCES, categoryById } from "../data/catalog";
import { useMe, useNow, useTeam } from "../data/hooks";
import { trend } from "../data/metrics";
import { dayStart, executorRowsOf, funnelOfTotals, moneyOf, n, operatorRowsOf, sourceRowsOf, todayDay } from "../data/dailyStats";
import { PRESETS, lastDays, periodLabel, presetRange, rangeLabel, rangeProblem, type DayRange, type PresetId } from "../data/statsPeriod";
import type { SourceId } from "../data/types";
import { SourceIcon } from "../components/icons";
import { ExportButton } from "../components/ExportButton";
import { Card, KpiCard, Loading, PageHeader } from "../components/ui";
import { PayoutsCard } from "../components/PayoutsCard";
import { CashFlowRow } from "../components/CashFlowRow";
import { AdSpendModal, OperatorsCard, SourceCostsCard } from "./AnalyticsCards";
import { ExecutorsTable, FiltersBar, FreshnessLine, MonthsCard, PeriodPicker, RepeatCard, type StatsFilters } from "./AnalyticsStats";
import { money, moneyShort, num, pct } from "../lib/format";

const SOURCE_COLOR: Record<SourceId, string> = {
  olx: "#3d8bfd",
  whatsapp: "#34c47c",
  telegram: "#55b8f6",
  site: "#8f6cf5",
  phone: "#fbbf3c",
  instagram: "#ef6a9a",
  referral: "#9aa8c0",
};
/** Под столбцами — иконки каналов: подписи на узкой оси наезжают друг на друга. */
function SourceTick({ x, y, payload }: { x?: number | string; y?: number | string; payload?: { value?: unknown } }) {
  const s = payload?.value as SourceId | undefined;
  if (!s) return null;
  return (
    <foreignObject x={Number(x) - 12} y={Number(y) + 2} width={24} height={24}>
      <div className="flex h-6 w-6 items-center justify-center" title={SOURCES[s].label}>
        <SourceIcon source={s} size={19} />
      </div>
    </foreignObject>
  );
}
const FUNNEL_COLOR = ["#ffc629", "#ffd965", "#ffe596", "#ffefc2", "#eeeae0"];

export default function Analytics() {
  const me = useMe()!;
  const now = useNow(60_000);
  const team = useTeam();
  const owner = me.role === "owner";
  const [preset, setPreset] = useState<PresetId>("30d");
  const [custom, setCustom] = useState<DayRange>(() => lastDays(30));
  const [filter, setFilter] = useState<StatsFilters>({});
  const [spendOpen, setSpendOpen] = useState(false);
  const range = presetRange(preset, custom, now);
  const valid = rangeProblem(range) === null;
  const r = useQuery(api.stats.report, valid ? { ...range, ...filter } : "skip");
  // Руководителю — только его направления: сервер всё равно отдаёт лишь их, список фильтра не обещает лишнего.
  const categories = owner ? CATEGORIES.map((c) => c.id) : (me.categories ?? []);
  const caption = PRESETS.find((p) => p.id === preset)!.prev;

  const d = useMemo(() => {
    if (!r) return null;
    const s = moneyOf(r.cur.t);
    const p = moneyOf(r.prev);
    const done = n(r.cur.t, "done");
    const onTime = done ? (done - n(r.cur.t, "late")) / done : null;
    const prevDone = n(r.prev, "done");
    const prevOnTime = prevDone ? (prevDone - n(r.prev, "late")) / prevDone : null;
    return {
      s,
      trends: {
        revenue: trend(s.revenue, p.revenue, caption),
        payouts: trend(s.payouts, p.payouts, caption),
        margin: trend(s.margin, p.margin, caption),
        count: trend(s.count, p.count, caption),
        leads: trend(n(r.cur.t, "leads"), n(r.prev, "leads"), caption),
        cancelled: trend(n(r.cur.t, "cancelled"), n(r.prev, "cancelled"), caption, false),
        onTime: onTime !== null && prevOnTime !== null ? trend(Math.round(onTime * 100), Math.round(prevOnTime * 100), caption) : undefined,
      },
      onTime,
      conversion: n(r.cur.t, "leads") ? n(r.cur.t, "converted") / n(r.cur.t, "leads") : 0,
      sources: sourceRowsOf(r.cur, r.spend),
      series: r.series.map((x) => ({ label: periodLabel(x.period), orders: n(x.t, "created"), leads: n(x.t, "leads"), done: n(x.t, "done") })),
      funnel: funnelOfTotals(r.cur.t),
      executors: executorRowsOf(r.cur, r.executors, r.money),
      ops: operatorRowsOf(r.cur),
      // По направлению заказа (а не услуги): заказ из удалённого или переименованного направления не теряется.
      byCat: r.cur.categories
        .map((c) => ({ id: c.category, label: categoryById(c.category).label, done: n(c.t, "done"), ...moneyOf(c.t) }))
        .filter((c) => c.done > 0)
        .sort((a, b) => (r.money ? b.margin - a.margin : b.done - a.done)),
    };
  }, [r, caption]);

  const header = (
    <>
      <PageHeader
        title={owner ? "Аналитика" : "Аналитика направления"}
        subtitle={`${rangeLabel(range)}${filter.city ? ` · ${filter.city}` : ""}${filter.category ? ` · ${categoryById(filter.category).label}` : ""}${filter.source ? ` · ${SOURCES[filter.source].label}` : ""}`}
        actions={
          <>
            {owner && <ExportButton kinds={["payments", "orders", "payouts", "leads", "calls", "executors", "audit"]} label="Выгрузки за период" />}
            <PeriodPicker preset={preset} onPreset={setPreset} custom={custom} onCustom={setCustom} />
          </>
        }
      />
      {owner && <FreshnessLine />}
      <FiltersBar value={filter} onChange={setFilter} categories={categories} />
    </>
  );
  if (!valid) return header;
  if (!r || !d || !team.loaded) return (
    <>
      {header}
      <Loading text="Считаем показатели…" />
    </>
  );

  const fTop = Math.max(1, d.funnel[0]!.value);
  const file = `homemax-ispolniteli-${range.from}_${range.to}.csv`;
  const sourceBars = d.sources.map((x) => ({ value: r.money ? x.revenue : x.leads, source: x.source }));

  return (
    <>
      {header}
      {r.money ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <KpiCard icon={Briefcase} tone="green" label="Выручка" value={money(d.s.revenue)} trend={d.trends.revenue} />
            <KpiCard icon={Wallet} tone="red" label="Начислено мастерам" value={money(d.s.payouts)} trend={{ ...d.trends.payouts, good: true }} />
            <KpiCard icon={ChartNoAxesColumn} tone="violet" label="Маржа" value={money(d.s.margin)} trend={d.trends.margin} />
            <KpiCard icon={Banknote} tone="yellow" label="Выполнено заказов" value={num(d.s.count)} trend={d.trends.count} />
          </div>
          <CashFlowRow cur={r.cur.t} prev={r.prev} caption={caption} />
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard icon={FileText} tone="yellow" label="Заявки" value={num(n(r.cur.t, "leads"))} trend={d.trends.leads} caption={`в заказ — ${Math.round(d.conversion * 100)}%`} />
          <KpiCard icon={Briefcase} tone="green" label="Выполнено заказов" value={num(d.s.count)} trend={d.trends.count} />
          <KpiCard icon={BadgeCheck} tone="violet" label="Сдано вовремя" value={d.onTime === null ? "—" : `${Math.round(d.onTime * 100)}%`} trend={d.trends.onTime} />
          <KpiCard icon={Ban} tone="red" label="Отменено заказов" value={num(n(r.cur.t, "cancelled"))} trend={d.trends.cancelled} />
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr_0.85fr]">
        <Card title={r.money ? "Выручка по источникам" : "Заявки по источникам"}>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={sourceBars} margin={{ top: 24, right: 4, left: -6, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#efece6" />
                <XAxis dataKey="source" tickLine={false} axisLine={false} tick={SourceTick} interval={0} height={30} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#77736b" }} tickFormatter={r.money ? moneyShort : undefined} allowDecimals={false} width={52} />
                <Tooltip
                  cursor={{ fill: "#f6f4ee" }}
                  labelFormatter={(s) => SOURCES[s as SourceId]?.label ?? String(s)}
                  formatter={(v) => [r.money ? money(Number(v)) : num(Number(v)), r.money ? "Выручка" : "Заявок"]}
                  contentStyle={{ borderRadius: 12, border: "1px solid #ece9e2", fontSize: 13 }}
                />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={58}>
                  {sourceBars.map((x) => (
                    <Cell key={x.source} fill={SOURCE_COLOR[x.source]} />
                  ))}
                  <LabelList dataKey="value" position="top" formatter={(v) => (r.money ? moneyShort(Number(v)) : num(Number(v)))} style={{ fontSize: 12, fontWeight: 700, fill: "#141414" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Динамика заказов" titleExtra={r.grain === "month" && <span className="text-[14px] font-normal text-muted">по месяцам</span>}>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={d.series} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="area-g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#ffc629" stopOpacity={0.35} />
                    <stop offset="1" stopColor="#ffc629" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#efece6" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#77736b" }} minTickGap={22} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#77736b" }} allowDecimals={false} />
                <Tooltip formatter={(v, name) => [num(Number(v)), name === "orders" ? "Заказов" : "Заявок"]} contentStyle={{ borderRadius: 12, border: "1px solid #ece9e2", fontSize: 13 }} />
                <Area type="monotone" dataKey="orders" stroke="#e9a800" strokeWidth={2.4} fill="url(#area-g)" dot={d.series.length <= 14 ? { r: 3.5, fill: "#e9a800", strokeWidth: 0 } : false} activeDot={{ r: 5 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Воронка заявок">
          <div className="flex flex-col gap-1.5 pt-1">
            {d.funnel.map((s, i) => {
              const w = 100 - i * 13;
              const next = 100 - (i + 1) * 13;
              return (
                <div key={s.label} className="flex items-center gap-3">
                  <svg viewBox="0 0 100 34" className="h-[42px] w-[38%] shrink-0" preserveAspectRatio="none" aria-hidden>
                    <polygon points={`${(100 - w) / 2},0 ${(100 + w) / 2},0 ${(100 + next) / 2},34 ${(100 - next) / 2},34`} fill={FUNNEL_COLOR[i]} />
                  </svg>
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="truncate text-[13px] text-ink-2">{s.label}</div>
                    <div className="text-[16px] font-bold text-ink tabular-nums">{num(s.value)}</div>
                  </div>
                  <span className="rounded-[8px] bg-[#fff4d4] px-2 py-1 text-[12.5px] font-semibold text-[#a86d00] tabular-nums">{pct(s.value, fTop)}%</span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="mt-4">
        <ExecutorsTable rows={d.executors} money={r.money} file={file} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card title={r.money ? "Маржа по направлениям" : "Выполнено по направлениям"} icon={Percent}>
          {d.byCat.length === 0 ? (
            <p className="py-8 text-center text-[14px] text-muted">За период выполненных заказов нет</p>
          ) : (
            <div className="flex flex-col gap-3">
              {d.byCat.slice(0, 7).map((c) => {
                const value = r.money ? c.margin : c.done;
                const max = (r.money ? d.byCat[0]!.margin : d.byCat[0]!.done) || 1;
                return (
                  <div key={c.id}>
                    <div className="mb-1 flex items-baseline justify-between gap-3 text-[13.5px]">
                      <span className="truncate text-ink-2">{c.label}</span>
                      <span className="shrink-0 font-semibold text-ink tabular-nums">
                        {r.money ? (
                          <>
                            {money(c.margin)} <span className="font-normal text-muted">· {pct(c.margin, c.revenue)}%</span>
                          </>
                        ) : (
                          `${num(c.done)} заказов`
                        )}
                      </span>
                    </div>
                    <div className="h-2.5 rounded-full bg-[#f1efe9]">
                      <div className="h-full rounded-full bg-[linear-gradient(90deg,#f5b800,#ffd96b)]" style={{ width: `${Math.max(0, (value / max) * 100)}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
        <RepeatCard t={r.cur.t} prev={r.prev} money={r.money} />
      </div>

      <div className="mt-4">
        <MonthsCard filter={filter} money={r.money} />
      </div>

      {r.money && (
        <>
          {/* Расходы на рекламу делятся только по источникам — с фильтром по городу или направлению их не к чему отнести. */}
          {!filter.city && !filter.category && (
            <div className="mt-4">
              <SourceCostsCard rows={d.sources} onSpend={() => setSpendOpen(true)} />
            </div>
          )}
          <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_1fr]">
            <OperatorsCard rows={d.ops.rows} auto={d.ops.auto} users={team.users} />
            {range.to === todayDay(now) && <PayoutsCard from={dayStart(range.from)} period={`за ${PRESETS.find((p) => p.id === preset)!.label.toLowerCase().replace("…", "")}`} />}
          </div>
        </>
      )}

      {spendOpen && <AdSpendModal onClose={() => setSpendOpen(false)} />}
    </>
  );
}
