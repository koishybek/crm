// Долги клиентов (ТЗ п.5 «Dashboard: выручка, выплаты», п.13 «задолженность»): для плитки «Долги клиентов»
// и списка должников на «Главной» владельца. Деньги компании — только владельцу (аудит M-2).
import { query } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { debt } from "../src/data/logic";
import type { Debtor, Receivables } from "../src/data/receivables";
import type { OrderStatus } from "../src/data/types";

/**
 * Где ждут оплату: машина статусов переводит сданный заказ с долгом в «Ожидает оплаты», полностью оплаченный —
 * в «Оплачен» (lib/money.ts → settle), поэтому долги — только здесь, и читаем их по индексу, без всей истории.
 * Закрытый с долгом заказ владелец закрыл сам, с причиной (списание) — это уже не долг к сбору.
 */
const DEBT_STATUSES: readonly OrderStatus[] = ["done", "awaiting_payment"];
/** Заказов на статус за один ответ — с запасом: столько неоплаченных работ сразу — уже повод разбираться не на «Главной». */
const MAX_PER_STATUS = 1000;

export const list = query({
  args: {},
  handler: async (ctx): Promise<Receivables> => {
    await requireRole(ctx, OWNER);
    const debtors: Debtor[] = [];
    let truncated = false;
    for (const status of DEBT_STATUSES) {
      const rows = await ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", status))
        .take(MAX_PER_STATUS + 1);
      if (rows.length > MAX_PER_STATUS) truncated = true;
      for (const o of rows.slice(0, MAX_PER_STATUS)) {
        const owed = debt(o);
        if (owed > 0) debtors.push({ orderId: o._id, number: o.number, clientId: o.clientId, clientName: o.clientName, debt: owed, since: o.doneAt ?? o.createdAt });
      }
    }
    debtors.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : b.debt - a.debt));
    return { total: debtors.reduce((s, d) => s + d.debt, 0), count: debtors.length, debtors, truncated };
  },
});
