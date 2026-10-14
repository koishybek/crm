import { ChartNoAxesColumn, Clock, FileText, Briefcase, Hourglass, CalendarDays, ChevronRight, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { serviceById } from "../data/catalog";
import { useMe, useNow, useTeam, useUi } from "../data/hooks";
import { can, canSeeCompanyMoney } from "../data/permissions";
import { EXEC_STATE, executorState, isActive, isDueSoon, isOverdue, leadBadge, orderBadge } from "../data/logic";
import { PERIODS, trend, type PeriodId } from "../data/metrics";
import { dayStart, daysBetween, funnelOfTotals, moneyOf, n, shiftDay } from "../data/dailyStats";
import { PRESETS, presetRange, type DayRange } from "../data/statsPeriod";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Order } from "../data/types";
import { Source } from "../components/icons";
import { DebtorsCard, OwnerMoneyKpis } from "../components/OwnerMoney";
import { PayoutsCard } from "../components/PayoutsCard";
import { Avatar, Badge, Card, KpiCard, Loading, PageHeader, Select, TextLink } from "../components/ui";
import { cn, dayDiff, deadline, num, shortName, whenShort } from "../lib/format";

export function PeriodSelect({ value, onChange, options = PERIODS.map((p) => p.id) }: { value: PeriodId; onChange: (p: PeriodId) => void; options?: PeriodId[] }) {
  return (
    <Select icon={CalendarDays} value={value} onChange={(e) => onChange(e.target.value as PeriodId)} className="w-[250px] [&_select]:h-[46px] [&_select]:rounded-[12px] [&_select]:border-line [&_select]:bg-white [&_select]:text-[15px]">
      {PERIODS.filter((p) => options.includes(p.id)).map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
        </option>
      ))}
    </Select>
  );
}

/** Пресеты «Главной» — последние дни; своего периода здесь нет. */
const NO_CUSTOM: DayRange = { from: "", to: "" };

/** Почему заказ требует внимания — для подписи. */
function attentionReason(o: Order, now: number): { rank: number } | null {
  if (isOverdue(o, now)) return { rank: 0 };
  if (isDueSoon(o, now) || (isActive(o) && dayDiff(new Date(o.deadline), new Date(now)) === 0)) return { rank: 1 };
  if (o.status === "awaiting_executor" && now - new Date(o.createdAt).getTime() > 3 * 3600_000) return { rank: 2 };
  if (o.status === "awaiting_payment" && o.doneAt && now - new Date(o.doneAt).getTime() > 86400_000) return { rank: 3 };
  return null;
}

export default function Dashboard() {
  const me = useMe()!;
  const now = useNow();
  const nav = useNavigate();
  const ui = useUi();
  const team = useTeam();
  const [period, setPeriod] = useState<PeriodId>("7d");
  const [funnelPeriod, setFunnelPeriod] = useState<PeriodId>("30d");
  // Что живёт минутами (заказы в работе, последние заявки) — с сервера как есть; показатели за период — из предрасчёта
  // (convex/stats.ts): «Главная» не тянет срез заказов за 90 дней.
  const data = useQuery(api.board.live, {});
  const cur = presetRange(period, NO_CUSTOM, now);
  const days = daysBetween(cur.from, cur.to);
  const t = useQuery(api.stats.totals, cur);
  const prevT = useQuery(api.stats.totals, { from: shiftDay(cur.from, -days), to: shiftDay(cur.from, -1) });
  const funnelT = useQuery(api.stats.totals, presetRange(funnelPeriod, NO_CUSTOM, now));
  const db = useMemo(() => ({ leads: data?.leads ?? [], orders: data?.orders ?? [], executors: team.executors, users: team.users }), [data, team]);
  // Денежные плитки — по правам (ТЗ п.5.12): выручка и маржа, выплаты — «Выплаты мастерам и маржа», долги — «Цена клиента и оплаты».
  const seesPayouts = canSeeCompanyMoney(me);
  const seesMoney = can(me, "money.view");

  const k = useMemo(() => {
    const caption = PRESETS.find((p) => p.id === period)!.prev;
    const c = t ?? {};
    const p = prevT ?? {};
    const active = db.orders.filter(isActive);
    const overdue = db.orders.filter((o) => isOverdue(o, now));
    // Деньги — по правам: без них сервер не отдаёт ни сумм в заказах, ни денежных итогов.
    const done = moneyOf(c);
    const donePrev = moneyOf(p);
    return {
      leads: { value: n(c, "leads"), trend: trend(n(c, "leads"), n(p, "leads"), caption) },
      active: { value: active.length, created: n(c, "created") },
      overdue: overdue.length,
      waiting: db.orders.filter((o) => o.status === "awaiting_executor").length,
      revenue: { value: done.revenue, trend: trend(done.revenue, donePrev.revenue, caption) },
      margin: { value: done.margin, trend: trend(done.margin, donePrev.margin, caption) },
    };
  }, [db, t, prevT, period, now]);

  const lastLeads = [...db.leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const attention = db.orders
    .map((o) => ({ o, r: attentionReason(o, now) }))
    .filter((x) => x.r)
    .sort((a, b) => a.r!.rank - b.r!.rank || a.o.deadline.localeCompare(b.o.deadline));
  const execs = db.executors
    .map((e) => ({ e, st: executorState(e, db.orders) }))
    .sort((a, b) => ["onsite", "busy", "free", "off"].indexOf(a.st) - ["onsite", "busy", "free", "off"].indexOf(b.st));
  const onShift = execs.filter((x) => x.st !== "off").length;
  const f = funnelOfTotals(funnelT ?? {});
  const fMax = Math.max(1, ...f.map((x) => x.value));

  if (!data || !t || !prevT || !team.loaded) return <Loading />;

  return (
    <>
      <PageHeader title="Главная" subtitle="Ключевые показатели и свежая информация по вашему бизнесу" actions={<PeriodSelect value={period} onChange={setPeriod} options={["today", "7d", "30d"]} />} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard deco icon={FileText} tone="yellow" label="Новые заявки" value={num(k.leads.value)} trend={k.leads.trend} onClick={() => nav("/leads")} />
        <KpiCard deco
          icon={Briefcase}
          tone="green"
          label="Активные заказы"
          value={num(k.active.value)}
          trend={{ value: `+${k.active.created}`, up: true, good: true, caption: "новых за период" }}
          onClick={() => nav("/orders")}
        />
        <KpiCard deco
          icon={Clock}
          tone="red"
          label="Просрочки"
          value={num(k.overdue)}
          caption={k.overdue ? <span className="font-medium text-bad-ink">требуют реакции сейчас</span> : "всё в срок"}
          onClick={() => nav("/orders?late=1")}
        />
        <KpiCard deco icon={Hourglass} tone="amber" label="Ждут исполнителя" value={num(k.waiting)} caption="в ленте исполнителей" onClick={() => nav("/orders")} />
      </div>
      {seesPayouts && <OwnerMoneyKpis from={dayStart(cur.from)} revenue={k.revenue} margin={k.margin} />}

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1fr]">
        <Card icon={FileText} title="Последние заявки" action={<TextLink to="/leads">Все заявки</TextLink>} bodyClass="px-3 pb-3 sm:px-4">
          <div className="scroll-x">
            <table className="tbl min-w-[560px]">
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>Источник</th>
                  <th>Услуга</th>
                  <th>Статус</th>
                  <th className="text-right">Время</th>
                </tr>
              </thead>
              <tbody>
                {lastLeads.map((l) => {
                  const b = leadBadge(l, db.orders.find((o) => o.id === l.orderId), now);
                  return (
                    <tr key={l.id} className="row-link" onClick={() => ui.openLead({ leadId: l.id })}>
                      <td>
                        <span className="flex items-center gap-2.5">
                          <Avatar name={l.clientName} size={30} />
                          <span className="max-w-[150px] truncate font-medium text-ink">{l.clientName}</span>
                        </span>
                      </td>
                      <td>
                        <Source source={l.source} />
                      </td>
                      <td className="max-w-[170px] truncate text-ink-2">{serviceById(l.serviceId).label}</td>
                      <td>
                        <Badge tone={b.tone}>{b.label}</Badge>
                      </td>
                      <td className="text-right whitespace-nowrap text-muted">{whenShort(l.createdAt, new Date(now))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card
          icon={Clock}
          title="Заказы, требующие внимания"
          titleExtra={attention.length > 0 && <span className="inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-bad px-2 text-[13px] font-bold text-white">{attention.length}</span>}
          action={<TextLink to="/orders">Все заказы</TextLink>}
          bodyClass="px-3 pb-3 sm:px-4"
        >
          {attention.length === 0 ? (
            <div className="px-2 py-10 text-center text-[14px] text-muted">Всё под контролем — срочных заказов нет</div>
          ) : (
            <div className="scroll-x">
              <table className="tbl min-w-[560px]">
                <thead>
                  <tr>
                    <th>Заказ</th>
                    <th>Клиент</th>
                    <th>Срок</th>
                    <th>Исполнитель</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.slice(0, 5).map(({ o }) => {
                    const ex = db.executors.find((e) => e.id === o.executorId);
                    const late = isOverdue(o, now);
                    const today = dayDiff(new Date(o.deadline), new Date(now)) === 0;
                    const b = orderBadge(o, now);
                    return (
                      <tr key={o.id} className="row-link" onClick={() => nav(`/orders/${o.id}`)}>
                        <td className="font-semibold text-ink">№{o.number}</td>
                        <td className="max-w-[130px] truncate text-ink-2">{shortName(o.clientName)}</td>
                        <td className={cn("whitespace-nowrap font-medium", late ? "text-bad" : today ? "text-warn" : "text-ink-2")}>{deadline(o.deadline, new Date(now)).replace(",", "")}</td>
                        <td>
                          {ex ? (
                            <span className="flex items-center gap-2">
                              <Avatar name={ex.name} size={28} variant="person" />
                              <span className="text-ink-2">{ex.name.split(" ")[0]}</span>
                            </span>
                          ) : (
                            <span className="text-muted">не назначен</span>
                          )}
                        </td>
                        <td>
                          <Badge tone={b.tone}>{b.label}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card
          icon={Users}
          title="Исполнители сегодня"
          titleExtra={
            <span className="text-[14px] font-normal text-muted">
              {onShift} из {execs.length} на смене
            </span>
          }
          action={<TextLink to="/executors">Все исполнители</TextLink>}
        >
          <div className="scroll-x scroll-thin -mx-1 flex gap-3 px-1 pt-2 pb-1">
            {execs.slice(0, 10).map(({ e, st }) => (
              <button key={e.id} onClick={() => nav(`/executors/${e.id}`)} className="flex w-[84px] shrink-0 flex-col items-center gap-1.5 rounded-[12px] py-1 text-center hover:bg-[#f8f6f1]">
                <Avatar name={e.name} size={56} variant="person" status={st === "off" ? "red" : st === "free" ? "green" : st === "onsite" ? "orange" : "blue"} />
                <span className="w-full truncate text-[14px] font-medium text-ink">{e.name.split(" ")[0]}</span>
                <span className={cn("text-[12.5px]", st === "free" ? "font-medium text-ok-ink" : "text-muted")}>{EXEC_STATE[st].label}</span>
              </button>
            ))}
          </div>
        </Card>

        <Card icon={ChartNoAxesColumn} title="Воронка заявок" action={<PeriodSelect value={funnelPeriod} onChange={setFunnelPeriod} options={["7d", "30d", "90d"]} />}>
          <div className="flex h-[176px] items-end gap-1 pt-2 sm:gap-2">
            {f.map((s, i) => (
              <div key={s.label} className="flex min-w-0 flex-1 items-end gap-1 sm:gap-2">
                <div className="flex min-w-0 flex-1 flex-col items-center">
                  <span className="mb-1.5 text-[16px] font-bold text-ink tabular-nums">{s.value}</span>
                  <div
                    className={cn("w-full rounded-t-[6px]", i === f.length - 1 ? "bg-brand" : ["bg-brand", "bg-[#ffe08a]", "bg-[#ffe9ad]", "bg-[#fff0c9]"][i])}
                    style={{ height: Math.max(8, (s.value / fMax) * 110) }}
                  />
                  <span className="mt-2 w-full truncate text-center text-[12.5px] leading-tight text-muted">{s.label}</span>
                </div>
                {i < f.length - 1 && <ChevronRight size={16} className="mb-[52px] shrink-0 text-faint" aria-hidden />}
              </div>
            ))}
          </div>
        </Card>

        {seesPayouts && <PayoutsCard from={dayStart(cur.from)} period={`за ${PERIODS.find((p) => p.id === period)!.label.toLowerCase()}`} className="xl:col-span-2" />}
        {seesMoney && <DebtorsCard className="xl:col-span-2" />}
      </div>
    </>
  );
}
