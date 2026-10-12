import { Briefcase, ChartNoAxesColumn, Download, Wallet, Banknote, Star } from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CATEGORIES, SOURCES, serviceById } from "../data/catalog";
import { useNow } from "../data/hooks";
import { PERIODS, dailySeries, doneIn, funnel, operatorStats, rangeOf, revenueBySource, sums, topExecutors, trend, type PeriodId } from "../data/metrics";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useTeam } from "../data/hooks";
import type { SourceId } from "../data/types";
import { Source, SourceIcon } from "../components/icons";
import { Avatar, Button, Card, KpiCard, Loading, PageHeader } from "../components/ui";
import { PeriodSelect } from "./Dashboard";
import { dayLabel, money, moneyShort, num, pct } from "../lib/format";
import { exportCsv } from "../lib/csv";
import { margin, payout } from "../data/logic";

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
  const now = useNow(60_000);
  const team = useTeam();
  const [period, setPeriod] = useState<PeriodId>("30d");
  // С сервера — срез от начала прошлого периода (для сравнения), формулы — общие с «Главной».
  const slice = useQuery(api.metrics.analytics, { from: new Date(rangeOf(period, now).prev.from).toISOString() });
  const db = useMemo(() => ({ leads: slice?.leads ?? [], orders: slice?.orders ?? [], executors: team.executors, users: team.users }), [slice, team]);

  const d = useMemo(() => {
    const { cur, prev, days } = rangeOf(period, now);
    const caption = PERIODS.find((p) => p.id === period)!.prev;
    const s = sums(doneIn(db, cur));
    const p = sums(doneIn(db, prev));
    const byCat = CATEGORIES.map((c) => {
      const orders = doneIn(db, cur).filter((o) => serviceById(o.serviceId).category === c.id);
      return { label: c.label, ...sums(orders) };
    })
      .filter((x) => x.count)
      .sort((a, b) => b.margin - a.margin);
    return {
      cur,
      s,
      trends: {
        revenue: trend(s.revenue, p.revenue, caption),
        payouts: trend(s.payouts, p.payouts, caption),
        margin: trend(s.margin, p.margin, caption),
        count: trend(s.count, p.count, caption),
      },
      sources: revenueBySource(db, cur),
      series: dailySeries(db, cur, days).map((x) => ({ ...x, label: dayLabel(x.day) })),
      funnel: funnel(db, cur),
      top: topExecutors(db, cur, 5),
      ops: operatorStats(db, cur),
      byCat,
    };
  }, [db, period, now]);

  const fTop = Math.max(1, d.funnel[0]!.value);

  const download = () => {
    const rows: (string | number)[][] = [["Заказ", "Дата выполнения", "Клиент", "Услуга", "Город", "Источник", "Исполнитель", "Цена клиента", "Выплата", "Маржа"]];
    for (const o of doneIn(db, d.cur)) {
      rows.push([
        o.number,
        o.doneAt ? new Date(o.doneAt).toLocaleString("ru-RU") : "",
        o.clientName,
        serviceById(o.serviceId).label,
        o.city,
        SOURCES[o.source].label,
        db.executors.find((e) => e.id === o.executorId)?.name ?? "",
        o.clientPrice,
        payout(o),
        margin(o),
      ]);
    }
    exportCsv(rows, `homemax-zakazy-${period}.csv`);
  };

  if (!slice || !team.loaded) return <Loading text="Считаем показатели…" />;

  return (
    <>
      <PageHeader
        title="Аналитика"
        subtitle="Ключевые показатели и динамика по вашему бизнесу"
        actions={
          <>
            <Button variant="secondary" icon={Download} className="h-[46px] bg-white" onClick={download}>
              Экспорт CSV
            </Button>
            <PeriodSelect value={period} onChange={setPeriod} options={["7d", "30d", "90d"]} />
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={Briefcase} tone="green" label="Выручка" value={money(d.s.revenue)} trend={d.trends.revenue} />
        <KpiCard icon={Wallet} tone="red" label="Выплаты" value={money(d.s.payouts)} trend={{ ...d.trends.payouts, good: true }} />
        <KpiCard icon={ChartNoAxesColumn} tone="violet" label="Маржа" value={money(d.s.margin)} trend={d.trends.margin} />
        <KpiCard icon={Banknote} tone="yellow" label="Выполнено заказов" value={num(d.s.count)} trend={d.trends.count} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr_0.85fr]">
        <Card title="Выручка по источникам">
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.sources.map((x) => ({ value: x.revenue, source: x.source }))} margin={{ top: 24, right: 4, left: -6, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#efece6" />
                <XAxis dataKey="source" tickLine={false} axisLine={false} tick={SourceTick} interval={0} height={30} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#77736b" }} tickFormatter={moneyShort} width={52} />
                <Tooltip cursor={{ fill: "#f6f4ee" }} labelFormatter={(s) => SOURCES[s as SourceId]?.label ?? String(s)} formatter={(v) => [money(Number(v)), "Выручка"]} contentStyle={{ borderRadius: 12, border: "1px solid #ece9e2", fontSize: 13 }} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={58}>
                  {d.sources.map((x) => (
                    <Cell key={x.source} fill={SOURCE_COLOR[x.source]} />
                  ))}
                  <LabelList dataKey="value" position="top" formatter={(v) => moneyShort(Number(v))} style={{ fontSize: 12, fontWeight: 700, fill: "#141414" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card title="Динамика заказов">
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
                <Tooltip formatter={(v, n) => [num(Number(v)), n === "orders" ? "Заказов" : "Заявок"]} contentStyle={{ borderRadius: 12, border: "1px solid #ece9e2", fontSize: 13 }} />
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

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card title="Топ исполнителей" bodyClass="px-3 pb-3 sm:px-4">
          <div className="scroll-x">
            <table className="tbl min-w-[620px]">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Исполнитель</th>
                  <th className="text-center">Выполнено</th>
                  <th className="text-right">Выручка</th>
                  <th className="text-right">Маржа</th>
                  <th className="text-right">Рейтинг</th>
                </tr>
              </thead>
              <tbody>
                {d.top.map((x, i) => (
                  <tr key={x.e.id}>
                    <td className="text-muted">{i + 1}</td>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={x.e.name} size={32} variant="person" />
                        <span className="font-medium text-ink">{x.e.name}</span>
                      </span>
                    </td>
                    <td className="text-center tabular-nums">{x.count}</td>
                    <td className="text-right tabular-nums">{money(x.revenue)}</td>
                    <td className="text-right font-semibold text-ok-ink tabular-nums">{money(x.margin)}</td>
                    <td className="text-right">
                      <span className="inline-flex items-center gap-1 font-medium">
                        <Star size={15} className="fill-[#ffb547] text-[#ffb547]" />
                        {x.e.rating.toFixed(1)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Маржа по направлениям">
          <div className="flex flex-col gap-3">
            {d.byCat.slice(0, 7).map((c) => {
              const max = d.byCat[0]!.margin || 1;
              return (
                <div key={c.label}>
                  <div className="mb-1 flex items-baseline justify-between gap-3 text-[13.5px]">
                    <span className="truncate text-ink-2">{c.label}</span>
                    <span className="shrink-0 font-semibold text-ink tabular-nums">
                      {money(c.margin)} <span className="font-normal text-muted">· {pct(c.margin, c.revenue)}%</span>
                    </span>
                  </div>
                  <div className="h-2.5 rounded-full bg-[#f1efe9]">
                    <div className="h-full rounded-full bg-[linear-gradient(90deg,#f5b800,#ffd96b)]" style={{ width: `${(c.margin / max) * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.35fr_1fr]">
        <Card title="Эффективность источников" bodyClass="px-3 pb-3 sm:px-4">
          <div className="scroll-x">
            <table className="tbl min-w-[620px]">
              <thead>
                <tr>
                  <th>Источник</th>
                  <th className="text-center">Заявок</th>
                  <th className="text-center">Конверсия</th>
                  <th className="text-right">Средний чек</th>
                  <th className="text-right">Маржа</th>
                </tr>
              </thead>
              <tbody>
                {d.sources.map((x) => (
                  <tr key={x.source}>
                    <td>
                      <Source source={x.source} className="font-medium text-ink" />
                    </td>
                    <td className="text-center tabular-nums">{x.leads}</td>
                    <td className="text-center tabular-nums">{Math.round(x.conv * 100)}%</td>
                    <td className="text-right tabular-nums">{x.count ? money(x.avg) : "—"}</td>
                    <td className="text-right font-semibold text-ok-ink tabular-nums">{money(x.margin)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="px-1 pt-3 text-[12.5px] text-muted">Стоимость привлечения появится, когда подключим расходы на рекламу (OLX, Instagram).</p>
        </Card>

        <Card title="Операторы" bodyClass="px-3 pb-3 sm:px-4">
          <div className="scroll-x">
            <table className="tbl min-w-[380px]">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th className="text-center">Заявок</th>
                  <th className="text-center">В заказ</th>
                  <th className="text-right">Конверсия</th>
                </tr>
              </thead>
              <tbody>
                {d.ops.map((x) => (
                  <tr key={x.u.id}>
                    <td>
                      <span className="flex items-center gap-2.5">
                        <Avatar name={x.u.name} size={30} variant="person" />
                        <span className="font-medium text-ink">{x.u.name.split(" ")[0]}</span>
                      </span>
                    </td>
                    <td className="text-center tabular-nums">{x.leads}</td>
                    <td className="text-center tabular-nums">{x.conv}</td>
                    <td className="text-right font-semibold tabular-nums">{Math.round(x.rate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </>
  );
}
