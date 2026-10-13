// Движение денег за период (ТЗ п.17): «Получено от клиентов» — оплаты минус возвраты по их датам, «Выплачено мастерам» —
// по датам выплат из реестра. Выручка выше считается по выполненным заказам; здесь — когда деньги реально пришли и ушли.
import { ArrowDownToLine, ArrowUpFromLine, RotateCcw } from "lucide-react";
import { paidOutWithin, receivedWithin, type PaidOutRow } from "../data/analytics";
import { trend, type Range } from "../data/metrics";
import type { Order } from "../data/types";
import { money } from "../lib/format";
import { KpiCard } from "./ui";

export function CashFlowRow({ orders, payouts, cur, prev, caption }: { orders: readonly Order[]; payouts: readonly PaidOutRow[]; cur: Range; prev: Range; caption: string }) {
  const now = receivedWithin(orders, cur);
  const before = receivedWithin(orders, prev);
  const out = paidOutWithin(payouts, cur);
  const outBefore = paidOutWithin(payouts, prev);
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
      <KpiCard icon={ArrowDownToLine} tone="green" label="Получено от клиентов" value={money(now.net)} trend={trend(now.net, before.net, caption)} />
      <KpiCard icon={RotateCcw} tone="red" label="Возвраты клиентам" value={money(now.refunded)} trend={trend(now.refunded, before.refunded, caption, false)} />
      <KpiCard icon={ArrowUpFromLine} tone="violet" label="Выплачено мастерам" value={money(out)} trend={{ ...trend(out, outBefore, caption), good: true }} />
    </div>
  );
}
