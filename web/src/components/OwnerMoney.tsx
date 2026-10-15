// «Главная» владельца (ТЗ п.5 «Dashboard: выручка, выплаты, маржа», п.13 «задолженность»): плитки денег за период
// и список должников со ссылками на заказы. Эти суммы сервер отдаёт только владельцу (аудит M-2).
import { useQuery } from "convex/react";
import { Banknote, ChartNoAxesColumn, Receipt, Wallet } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { useNow } from "../data/hooks";
import { debtDays } from "../data/receivables";
import { cn, money, plural } from "../lib/format";
import { Avatar, Card, KpiCard, Loading, type Trend } from "./ui";

type Figure = { value: number; trend: Trend };

const DEBTORS_ID = "debtors";
const TOP = 8;
const orders = (n: number) => `${n} ${plural(n, "заказ", "заказа", "заказов")}`;
const waited = (days: number) => (days === 0 ? "сегодня" : `${days} ${plural(days, "день", "дня", "дней")}`);

/**
 * Вторая строка плиток владельца: выручка и маржа за период (по выполненным заказам, без возвратов — как в «Аналитике»),
 * выплачено исполнителям по датам выплат и долги клиентов сейчас. from — начало периода (мс).
 */
export function OwnerMoneyKpis({ from, revenue, margin }: { from: number; revenue: Figure; margin: Figure }) {
  const nav = useNavigate();
  const payouts = useQuery(api.analytics.payouts, { from: new Date(from).toISOString() });
  const debts = useQuery(api.receivables.list, {});
  const now = useNow();
  const oldest = debts?.debtors[0];
  return (
    <div className="mt-3 grid grid-cols-2 gap-3 sm:mt-4 sm:gap-4 xl:grid-cols-4">
      <KpiCard deco icon={Banknote} tone="green" label="Выручка" value={money(revenue.value)} trend={revenue.trend} onClick={() => nav("/analytics")} />
      <KpiCard deco icon={ChartNoAxesColumn} tone="amber" label="Маржа" value={money(margin.value)} trend={margin.trend} onClick={() => nav("/analytics")} />
      <KpiCard
        icon={Wallet}
        tone="violet"
        label="Выплаты исполнителям"
        value={payouts ? money(payouts.paidOut.amount) : "…"}
        caption={payouts && (payouts.owed.total > 0 ? `выплачено за период · к выплате ${money(payouts.owed.total)}` : "выплачено за период · долгов перед мастерами нет")}
        onClick={() => nav("/payouts")}
      />
      <KpiCard
        icon={Receipt}
        tone="red"
        label="Долги клиентов"
        value={debts ? money(debts.total) : "…"}
        caption={
          debts &&
          (oldest ? <span className={cn(debtDays(oldest.since, now) > 7 && "font-medium text-bad-ink")}>{`${orders(debts.count)} · самый давний — ${waited(debtDays(oldest.since, now))}`}</span> : "все сданные заказы оплачены")
        }
        onClick={() => document.getElementById(DEBTORS_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })}
      />
    </div>
  );
}

/** Должники: клиент, заказ, долг и сколько дней ждём оплату; самые давние — сверху. Строка ведёт в заказ. */
export function DebtorsCard({ className }: { className?: string }) {
  const d = useQuery(api.receivables.list, {});
  const now = useNow();
  const nav = useNavigate();
  const [all, setAll] = useState(false);
  const rows = d ? (all ? d.debtors : d.debtors.slice(0, TOP)) : [];
  return (
    <div id={DEBTORS_ID} className={cn("min-w-0 scroll-mt-4", className)}>
      <Card
        icon={Receipt}
        title="Долги клиентов"
        titleExtra={d && d.count > 0 && <span className="text-[14px] font-normal text-muted">{`${orders(d.count)} на ${money(d.total)}`}</span>}
        action={
          d && d.count > TOP ? (
            <button onClick={() => setAll((v) => !v)} className="text-[13.5px] font-medium text-brand-ink">
              {all ? "Свернуть" : `Все должники (${d.count}) →`}
            </button>
          ) : undefined
        }
        bodyClass="px-3 pb-3 sm:px-4"
      >
        {!d ? (
          <Loading className="py-10" />
        ) : d.count === 0 ? (
          <div className="px-2 py-10 text-center text-[14px] text-muted">Долгов нет — все сданные заказы клиенты оплатили полностью</div>
        ) : (
          <>
            <div className="scroll-x">
              <table className="tbl min-w-[560px]">
                <thead>
                  <tr>
                    <th>Клиент</th>
                    <th>Заказ</th>
                    <th className="text-right">Долг</th>
                    <th className="text-right">Ждём оплату</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((x) => {
                    const days = debtDays(x.since, now);
                    return (
                      <tr key={x.orderId} className="row-link" onClick={() => nav(`/orders/${x.orderId}`)}>
                        <td>
                          <span className="flex items-center gap-2.5">
                            <Avatar name={x.clientName} size={30} />
                            <Link to={`/clients/${x.clientId}`} onClick={(e) => e.stopPropagation()} className="max-w-[200px] truncate font-medium text-ink hover:text-brand-ink">
                              {x.clientName}
                            </Link>
                          </span>
                        </td>
                        <td className="font-semibold text-ink">
                          <Link to={`/orders/${x.orderId}`} onClick={(e) => e.stopPropagation()}>
                            №{x.number}
                          </Link>
                        </td>
                        <td className="text-right font-semibold whitespace-nowrap text-bad-ink tabular-nums">{money(x.debt)}</td>
                        <td className={cn("text-right whitespace-nowrap", days > 7 ? "font-medium text-bad" : days > 2 ? "text-warn" : "text-muted")}>{waited(days)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {d.truncated && <p className="px-2 pt-2 text-[12.5px] text-muted">Показаны первые {d.count} должников — остальные в «Заказах», статус «Ожидает оплаты».</p>}
          </>
        )}
      </Card>
    </div>
  );
}
