// Движение денег за период (ТЗ п.17): «Получено от клиентов» — оплаты минус возвраты по их датам, «Выплачено мастерам» —
// по датам выплат из реестра. Выручка выше считается по выполненным заказам; здесь — когда деньги реально пришли и ушли.
// Цифры — из предрасчёта за период (convex/stats.ts), формулы те же, что receivedWithin и paidOutWithin.
import { ArrowDownToLine, ArrowUpFromLine, RotateCcw } from "lucide-react";
import { cashOf, n, type Counts, type TotalKey } from "../data/dailyStats";
import { trend } from "../data/metrics";
import { money } from "../lib/format";
import { KpiCard } from "./ui";

export function CashFlowRow({ cur, prev, caption }: { cur: Counts<TotalKey>; prev: Counts<TotalKey>; caption: string }) {
  const now = cashOf(cur);
  const before = cashOf(prev);
  const out = n(cur, "paidOut");
  const outBefore = n(prev, "paidOut");
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
      <KpiCard icon={ArrowDownToLine} tone="green" label="Получено от клиентов" value={money(now.net)} trend={trend(now.net, before.net, caption)} />
      <KpiCard icon={RotateCcw} tone="red" label="Возвраты клиентам" value={money(now.refunded)} trend={trend(now.refunded, before.refunded, caption, false)} />
      <KpiCard icon={ArrowUpFromLine} tone="violet" label="Выплачено мастерам" value={money(out)} trend={{ ...trend(out, outBefore, caption), good: true }} />
    </div>
  );
}
