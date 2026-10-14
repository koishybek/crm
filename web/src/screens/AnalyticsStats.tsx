// Карточки «Аналитики» из предрасчёта (ТЗ 17.10, 23.4, §26.6): свой период и фильтры, полная таблица исполнителей
// с сортировкой и выгрузкой, повторные клиенты, сравнение по месяцам, свежесть показателей. Цифры — итоги convex/stats.ts,
// строки считает src/data/dailyStats.ts; деньги приходят только владельцу.
import { useQuery } from "convex/react";
import { ArrowDown, ArrowUp, CalendarDays, Download, MapPin, RefreshCw, Repeat, Tags, Radio } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../../convex/_generated/api";
import { ExecutorRating } from "../components/Rating";
import { Avatar, Button, Card, Input, Loading, Select } from "../components/ui";
import { durationText } from "../data/analytics";
import { categoryById, CITIES, SOURCES, SOURCE_IDS } from "../data/catalog";
import { moneyOf, n, repeatOf, type Counts, type ExecutorRow, type TotalKey } from "../data/dailyStats";
import { PRESETS, periodLabel, rangeProblem, type DayRange, type PresetId } from "../data/statsPeriod";
import { rebuildStats } from "../data/statsActions";
import { report } from "../data/store";
import type { SourceId } from "../data/types";
import { exportCsv, type CsvValue } from "../lib/csv";
import { cn, money, moneyShort, num, whenShort } from "../lib/format";

const share = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);
const FIELD = "[&_select]:h-[46px] [&_select]:rounded-[12px] [&_select]:border-line [&_select]:bg-white [&_select]:text-[15px]";

// ── Период и фильтры ─────────────────────────────────────────────────────────

export interface StatsFilters {
  city?: string;
  category?: string;
  source?: SourceId;
}

/** Пресет или свой период (две даты) — для «Аналитики». */
export function PeriodPicker({ preset, onPreset, custom, onCustom }: { preset: PresetId; onPreset: (p: PresetId) => void; custom: DayRange; onCustom: (r: DayRange) => void }) {
  const problem = preset === "custom" ? rangeProblem(custom) : null;
  return (
    <div className="flex flex-wrap items-start gap-2">
      <Select icon={CalendarDays} aria-label="Период" value={preset} onChange={(e) => onPreset(e.target.value as PresetId)} className={cn("w-[250px]", FIELD)}>
        {PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>
      {preset === "custom" && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Input type="date" aria-label="Начало периода" value={custom.from} max={custom.to} onChange={(e) => onCustom({ ...custom, from: e.target.value })} className="w-[160px] [&_input]:h-[46px] [&_input]:bg-white" />
            <span className="text-muted" aria-hidden>
              —
            </span>
            <Input type="date" aria-label="Конец периода" value={custom.to} min={custom.from} onChange={(e) => onCustom({ ...custom, to: e.target.value })} className="w-[160px] [&_input]:h-[46px] [&_input]:bg-white" />
          </div>
          {problem && <span className="text-[12.5px] font-medium text-bad-ink">{problem}</span>}
        </div>
      )}
    </div>
  );
}

/** Город, направление, источник. categories — какие направления можно выбрать (руководителю — только свои). */
export function FiltersBar({ value, onChange, categories }: { value: StatsFilters; onChange: (f: StatsFilters) => void; categories: readonly string[] }) {
  const set = (patch: StatsFilters) => onChange({ ...value, ...patch });
  const any = !!(value.city || value.category || value.source);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      <Select icon={MapPin} aria-label="Город" value={value.city ?? ""} onChange={(e) => set({ city: e.target.value || undefined })} className={cn("w-[200px]", FIELD)}>
        <option value="">Все города</option>
        {CITIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </Select>
      <Select icon={Tags} aria-label="Направление" value={value.category ?? ""} onChange={(e) => set({ category: e.target.value || undefined })} className={cn("w-[230px]", FIELD)}>
        <option value="">{categories.length > 1 ? "Все направления" : "Направление"}</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {categoryById(c).label}
          </option>
        ))}
      </Select>
      <Select icon={Radio} aria-label="Источник" value={value.source ?? ""} onChange={(e) => set({ source: (e.target.value || undefined) as SourceId | undefined })} className={cn("w-[200px]", FIELD)}>
        <option value="">Все источники</option>
        {SOURCE_IDS.map((s) => (
          <option key={s} value={s}>
            {SOURCES[s].label}
          </option>
        ))}
      </Select>
      {any && (
        <Button variant="ghost" onClick={() => onChange({})}>
          Сбросить фильтры
        </Button>
      )}
    </div>
  );
}

// ── Свежесть показателей ─────────────────────────────────────────────────────

/** Владельцу: когда показатели собраны, сколько изменений ждут пересчёта, и кнопка полного пересчёта. */
export function FreshnessLine() {
  const s = useQuery(api.stats.state, {});
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  const run = async () => {
    setBusy(true);
    report(await rebuildStats(), "Пересчёт запущен — займёт несколько минут");
    setBusy(false);
  };
  const text = s.rebuilding
    ? "Идёт полный пересчёт показателей — цифры обновятся через несколько минут"
    : !s.builtAt
      ? "Показатели собираются впервые — это займёт несколько минут"
      : s.pending > 0
        ? `Показатели обновляются раз в минуту: изменений в очереди — ${s.pending >= 1000 ? "больше 1000" : s.pending}`
        : `Показатели актуальны · собраны целиком ${whenShort(s.builtAt, new Date())}`;
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted">
      <span>{text}</span>
      {!s.rebuilding && (
        <button type="button" onClick={run} disabled={busy} className="inline-flex items-center gap-1 font-medium text-[#b07200] hover:underline disabled:opacity-50">
          <RefreshCw size={13} aria-hidden /> Пересчитать всё
        </button>
      )}
    </div>
  );
}

// ── Исполнители ──────────────────────────────────────────────────────────────

type SortKey = "name" | "done" | "onTime" | "late" | "cancelled" | "refusals" | "avgTakeMs" | "avgWorkMs" | "accrued" | "paidOut" | "margin" | "rating" | "reviews";

interface Column {
  key: SortKey;
  label: string;
  money?: boolean;
  value: (r: ExecutorRow) => number | string | null;
  show: (r: ExecutorRow) => CsvValue;
}

const hours = (ms: number | null) => (ms === null ? "—" : durationText(ms));
const COLUMNS: Column[] = [
  { key: "name", label: "Исполнитель", value: (r) => r.name, show: (r) => r.name },
  { key: "done", label: "Выполнено", value: (r) => r.done, show: (r) => r.done },
  { key: "onTime", label: "Вовремя", value: (r) => r.onTime, show: (r) => share(r.onTime) },
  { key: "late", label: "Опоздания", value: (r) => r.late, show: (r) => r.late },
  { key: "cancelled", label: "Отмены", value: (r) => r.cancelled, show: (r) => r.cancelled },
  { key: "refusals", label: "Отказы", value: (r) => r.refusals, show: (r) => r.refusals },
  { key: "avgTakeMs", label: "До взятия", value: (r) => r.avgTakeMs, show: (r) => hours(r.avgTakeMs) },
  { key: "avgWorkMs", label: "На заказ", value: (r) => r.avgWorkMs, show: (r) => hours(r.avgWorkMs) },
  { key: "accrued", label: "Начислено", money: true, value: (r) => r.accrued ?? 0, show: (r) => r.accrued ?? 0 },
  { key: "paidOut", label: "Выплачено", money: true, value: (r) => r.paidOut ?? 0, show: (r) => r.paidOut ?? 0 },
  { key: "margin", label: "Маржа", money: true, value: (r) => r.margin ?? 0, show: (r) => r.margin ?? 0 },
  { key: "rating", label: "Рейтинг", value: (r) => (r.reviews ? r.rating : null), show: (r) => (r.reviews ? r.rating.toFixed(1) : "") },
  { key: "reviews", label: "Отзывы", value: (r) => r.reviews, show: (r) => r.reviews },
];

function compare(a: number | string | null, b: number | string | null): number {
  // Пустые (нет замеров) — всегда внизу, в какую сторону ни сортируй.
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
  return typeof a === "string" || typeof b === "string" ? String(a).localeCompare(String(b), "ru") : a - b;
}

/**
 * Полная таблица исполнителей за период (ТЗ 17.10): выполнено, доля вовремя, опоздания, отмены и отказы, среднее время
 * до взятия и на заказ, начислено и выплачено (владельцу), рейтинг и отзывы. Сортировка по любому столбцу, выгрузка CSV.
 */
export function ExecutorsTable({ rows, money: withMoney, file }: { rows: ExecutorRow[]; money: boolean; file: string }) {
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "done", desc: true });
  const cols = COLUMNS.filter((c) => withMoney || !c.money);
  const sorted = useMemo(() => {
    const col = COLUMNS.find((c) => c.key === sort.key)!;
    return [...rows].sort((a, b) => {
      const va = col.value(a);
      const vb = col.value(b);
      if (va === null || vb === null) return compare(va, vb);
      return (sort.desc ? -1 : 1) * compare(va, vb) || b.done - a.done || a.name.localeCompare(b.name, "ru");
    });
  }, [rows, sort]);
  const toggle = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));
  const download = () => exportCsv([cols.map((c) => c.label), ...sorted.map((r) => cols.map((c) => c.show(r)))], file);

  return (
    <Card
      title="Исполнители"
      titleExtra={<span className="text-[14px] font-normal text-muted">{rows.length}</span>}
      action={
        <Button variant="secondary" size="sm" icon={Download} onClick={download} disabled={!rows.length}>
          CSV
        </Button>
      }
      bodyClass="px-3 pb-3 sm:px-4"
    >
      {rows.length === 0 ? (
        <p className="px-1 py-8 text-center text-[14px] text-muted">Исполнителей в выбранной области нет</p>
      ) : (
        <div className="scroll-x">
          <table className={cn("tbl", withMoney ? "min-w-[1180px]" : "min-w-[900px]")}>
            <thead>
              <tr>
                {cols.map((c) => (
                  <th key={c.key} className={c.key === "name" ? "" : "text-right"} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                    <button type="button" onClick={() => toggle(c.key)} className="inline-flex items-center gap-1 font-[inherit] hover:text-ink">
                      {c.label}
                      {sort.key === c.key && (sort.desc ? <ArrowDown size={13} aria-hidden /> : <ArrowUp size={13} aria-hidden />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id}>
                  <td>
                    <span className="flex items-center gap-2.5">
                      <Avatar name={r.name} size={30} variant="person" />
                      <span className="font-medium text-ink">{r.name}</span>
                    </span>
                  </td>
                  <td className="text-right tabular-nums">{num(r.done)}</td>
                  <td className={cn("text-right tabular-nums", r.onTime !== null && r.onTime < 0.8 && "font-semibold text-warn-ink")}>{share(r.onTime)}</td>
                  <td className={cn("text-right tabular-nums", r.late > 0 && "text-bad-ink")}>{num(r.late)}</td>
                  <td className="text-right tabular-nums">{num(r.cancelled)}</td>
                  <td className={cn("text-right tabular-nums", r.refusals > 0 && "text-warn-ink")}>{num(r.refusals)}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">{hours(r.avgTakeMs)}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">{hours(r.avgWorkMs)}</td>
                  {withMoney && (
                    <>
                      <td className="text-right whitespace-nowrap tabular-nums">{money(r.accrued ?? 0)}</td>
                      <td className="text-right whitespace-nowrap tabular-nums">{money(r.paidOut ?? 0)}</td>
                      <td className="text-right font-semibold whitespace-nowrap text-ok-ink tabular-nums">{money(r.margin ?? 0)}</td>
                    </>
                  )}
                  <td className="text-right whitespace-nowrap">{r.reviews ? <ExecutorRating e={r} count={false} size={15} className="text-[13.5px]" /> : <span className="text-muted">—</span>}</td>
                  <td className="text-right tabular-nums">{num(r.reviews)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Повторные клиенты ────────────────────────────────────────────────────────

/** Доля выполненных заказов от клиентов, у которых заказ уже был, и выручка с них (владельцу). */
export function RepeatCard({ t, prev, money: withMoney }: { t: Counts<TotalKey>; prev: Counts<TotalKey>; money: boolean }) {
  const r = repeatOf(t);
  const before = repeatOf(prev);
  const done = n(t, "done");
  const delta = Math.round((r.share - before.share) * 100);
  return (
    <Card icon={Repeat} title="Повторные клиенты">
      {done === 0 ? (
        <p className="py-8 text-center text-[14px] text-muted">За период выполненных заказов нет</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-[13.5px] text-ink-2">Доля заказов от повторных клиентов</div>
            <div className="mt-0.5 flex items-baseline gap-3">
              <span className="text-[28px] leading-tight font-bold tracking-[-0.02em] text-ink tabular-nums">{share(r.share)}</span>
              <span className={cn("text-[13px] font-medium", delta >= 0 ? "text-ok-ink" : "text-bad-ink")}>
                {delta > 0 ? "+" : ""}
                {delta} п.п. к прошлому периоду
              </span>
            </div>
            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-[#f1efe9]" role="img" aria-label={`Повторные — ${share(r.share)} заказов`}>
              <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(r.share * 100)}%` }} />
            </div>
            <div className="mt-1.5 text-[13px] text-muted">
              {num(r.orders)} из {num(done)} выполненных заказов
            </div>
          </div>
          {withMoney && (
            <dl className="grid grid-cols-2 gap-3 text-[13.5px]">
              <div>
                <dt className="text-muted">Выручка с повторных</dt>
                <dd className="font-semibold text-ink tabular-nums">{money(r.revenue)}</dd>
              </div>
              <div>
                <dt className="text-muted">Доля выручки</dt>
                <dd className="font-semibold text-ink tabular-nums">{share(r.revenueShare)}</dd>
              </div>
            </dl>
          )}
          <p className="text-[12.5px] text-muted">Повторный — клиент, у которого уже был заказ раньше этого.</p>
        </div>
      )}
    </Card>
  );
}

// ── Сравнение по месяцам ─────────────────────────────────────────────────────

/** Последние 12 месяцев с теми же фильтрами: заявки, конверсия, выполнено, деньги (владельцу), повторные. */
export function MonthsCard({ filter, money: withMoney }: { filter: StatsFilters; money: boolean }) {
  const months = useQuery(api.stats.months, filter);
  const data = useMemo(
    () =>
      (months ?? []).map((m) => ({
        month: m.month,
        label: periodLabel(m.month),
        leads: n(m.t, "leads"),
        conversion: n(m.t, "leads") ? n(m.t, "converted") / n(m.t, "leads") : null,
        done: n(m.t, "done"),
        ...moneyOf(m.t),
        repeat: repeatOf(m.t).share,
      })),
    [months],
  );
  const key = withMoney ? "revenue" : "done";
  return (
    <Card title="По месяцам" titleExtra={<span className="text-[14px] font-normal text-muted">последние 12 месяцев</span>} bodyClass="px-3 pb-3 sm:px-4">
      {!months ? (
        <Loading className="py-10" />
      ) : (
        <>
          <div className="h-[220px] px-1">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 12, right: 4, left: -6, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#efece6" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#77736b" }} minTickGap={8} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 12, fill: "#77736b" }} tickFormatter={withMoney ? moneyShort : undefined} allowDecimals={false} width={52} />
                <Tooltip
                  cursor={{ fill: "#f6f4ee" }}
                  formatter={(v) => [withMoney ? money(Number(v)) : num(Number(v)), withMoney ? "Выручка" : "Выполнено"]}
                  contentStyle={{ borderRadius: 12, border: "1px solid #ece9e2", fontSize: 13 }}
                />
                <Bar dataKey={key} fill="#ffc629" radius={[6, 6, 0, 0]} maxBarSize={42} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="scroll-x mt-2">
            <table className={cn("tbl", withMoney ? "min-w-[860px]" : "min-w-[560px]")}>
              <thead>
                <tr>
                  <th>Месяц</th>
                  <th className="text-right">Заявки</th>
                  <th className="text-right">Конверсия</th>
                  <th className="text-right">Выполнено</th>
                  {withMoney && (
                    <>
                      <th className="text-right">Выручка</th>
                      <th className="text-right">Маржа</th>
                      <th className="text-right">Средний чек</th>
                    </>
                  )}
                  <th className="text-right">Повторные</th>
                </tr>
              </thead>
              <tbody>
                {[...data].reverse().map((m) => (
                  <tr key={m.month}>
                    <td className="whitespace-nowrap text-ink-2">{m.label}</td>
                    <td className="text-right tabular-nums">{num(m.leads)}</td>
                    <td className="text-right tabular-nums">{share(m.conversion)}</td>
                    <td className="text-right tabular-nums">{num(m.done)}</td>
                    {withMoney && (
                      <>
                        <td className="text-right whitespace-nowrap tabular-nums">{money(m.revenue)}</td>
                        <td className="text-right whitespace-nowrap font-semibold text-ok-ink tabular-nums">{money(m.margin)}</td>
                        <td className="text-right whitespace-nowrap tabular-nums">{m.count ? money(m.avg) : "—"}</td>
                      </>
                    )}
                    <td className="text-right tabular-nums">{m.done ? share(m.repeat) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
