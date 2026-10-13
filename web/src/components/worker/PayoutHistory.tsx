// «Выплаты» в «Доходе» мастера (ТЗ п.14 «доход»): что офис уже перевёл — дата, сумма, способ и за какие заказы.
// Данные — реестр выплат (convex/payouts.ts mine): только свои выплаты, без комментариев офиса.
import { useQuery } from "convex/react";
import { Banknote } from "lucide-react";
import { Link } from "react-router";
import { api } from "../../../convex/_generated/api";
import { PAYMENT_METHODS } from "../../data/catalog";
import { dateAlmaty } from "../../data/workerTime";
import { cn, money } from "../../lib/format";
import { MUTED, Section } from "./kit";

export function PayoutHistory({ now }: { now: number }) {
  const rows = useQuery(api.payouts.mine);
  if (!rows?.length) return null;
  return (
    <Section title="Выплаты от офиса" className="mt-3">
      <ul>
        {rows.map((p) => (
          <li key={p.id} className="flex items-start gap-3 border-t border-line py-3 first:border-t-0 first:pt-0">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#e3f6ea] text-[#067a46]">
              <Banknote size={20} strokeWidth={1.8} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] text-ink">
                {dateAlmaty(p.at, now)} · {PAYMENT_METHODS[p.method]}
              </span>
              <span className={cn("mt-0.5 flex flex-wrap gap-x-2 text-[13.5px]", MUTED)}>
                за заказы:
                {p.orders.map((o) => (
                  <Link key={o.id} to={`/w/orders/${o.id}`} className="font-medium text-[#855600] underline underline-offset-2">
                    №{o.number}
                  </Link>
                ))}
              </span>
            </span>
            <span className="shrink-0 text-[16px] font-semibold text-ink tabular-nums">{money(p.amount)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}
