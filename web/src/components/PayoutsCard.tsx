// Выплаты исполнителям (ТЗ п.5 «Dashboard: выплаты», п.17): начислено за период, выплачено мастерам по датам выплат
// (реестр «Выплаты мастерам»), кому и сколько компания должна сейчас. Только владельцу — эти суммы сервер отдаёт одному OWNER.
import { useQuery } from "convex/react";
import { Wallet } from "lucide-react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { cn, money, plural } from "../lib/format";
import { Avatar, Card, Loading, TextLink } from "./ui";

const TOP = 4;
const orders = (n: number) => `${n} ${plural(n, "заказ", "заказа", "заказов")}`;

/** from — начало периода (мс), period — подпись к нему: «за последние 7 дней». */
export function PayoutsCard({ from, period, className }: { from: number; period: string; className?: string }) {
  const d = useQuery(api.analytics.payouts, { from: new Date(from).toISOString() });
  const paidShare = d && d.period.accrued > 0 ? Math.round((d.period.paid / d.period.accrued) * 100) : 0;
  const more = d ? d.owed.executors.length - TOP : 0;

  return (
    <Card icon={Wallet} title="Выплаты исполнителям" action={<TextLink to="/payouts">Выплаты мастерам</TextLink>} className={cn("@container", className)}>
      {!d ? (
        <Loading className="py-10" />
      ) : (
        <div className="grid grid-cols-1 gap-5 @xl:grid-cols-2 @xl:gap-8">
          <section aria-label={`Начислено ${period}`}>
            <div className="text-[14px] text-ink-2">Начислено {period}</div>
            <div className="mt-0.5 text-[28px] leading-tight font-bold tracking-[-0.02em] text-ink tabular-nums">{money(d.period.accrued)}</div>
            <div className="text-[13px] text-muted">{d.period.orders ? `выполнено заказов: ${d.period.orders}` : "выполненных заказов в периоде нет"}</div>
            <div className="mt-3 h-2.5 overflow-hidden rounded-full bg-[#f1efe9]" role="img" aria-label={`Выплачено ${paidShare}% начисленного`}>
              <div className="h-full rounded-full bg-ok" style={{ width: `${paidShare}%` }} />
            </div>
            <dl className="mt-2.5 grid grid-cols-2 gap-3 text-[13.5px]">
              <div>
                <dt className="text-muted">Выплачено мастерам {period}</dt>
                <dd className="font-semibold text-ok-ink tabular-nums">{money(d.paidOut.amount)}</dd>
              </div>
              <div>
                <dt className="text-muted">Из начисленного не выплачено</dt>
                <dd className={cn("font-semibold tabular-nums", d.period.unpaid > 0 ? "text-warn-ink" : "text-ink")}>{money(d.period.unpaid)}</dd>
              </div>
            </dl>
          </section>

          <section aria-label="К выплате сейчас" className="@xl:border-l @xl:border-line @xl:pl-8">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-[14px] text-ink-2">К выплате сейчас</span>
              {d.owed.orders > 0 && <span className="text-[13px] text-muted">{orders(d.owed.orders)}</span>}
            </div>
            <div className={cn("mt-0.5 text-[28px] leading-tight font-bold tracking-[-0.02em] tabular-nums", d.owed.total > 0 ? "text-ink" : "text-ok-ink")}>{money(d.owed.total)}</div>
            {d.owed.executors.length === 0 ? (
              <p className="mt-1 text-[13.5px] text-muted">Долгов перед исполнителями нет — все выполненные заказы оплачены мастерам.</p>
            ) : (
              <ul className="mt-2 divide-y divide-line">
                {d.owed.executors.slice(0, TOP).map((x) => (
                  <li key={x.id}>
                    <Link to={`/executors/${x.id}`} className="-mx-2 flex items-center gap-3 rounded-[10px] px-2 py-2 hover:bg-hover">
                      <Avatar name={x.name} size={30} variant="person" />
                      <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{x.name}</span>
                      <span className="shrink-0 text-[12.5px] text-muted">{orders(x.orders)}</span>
                      <b className="shrink-0 text-[14px] text-ink tabular-nums">{money(x.amount)}</b>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {more > 0 && <p className="mt-1 text-[12.5px] text-muted">и ещё {more} {plural(more, "исполнитель", "исполнителя", "исполнителей")}</p>}
          </section>
        </div>
      )}
    </Card>
  );
}
