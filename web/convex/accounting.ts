// Выгрузки для бухгалтерии (ТЗ п.19.8): реестр денег за период для 1С (CSV: оплаты клиентов, сторно, возвраты,
// выплаты мастерам — по датам самих денег) и выполненные заказы в CommerceML 2 (XML). Собираются страницами по индексам
// и отдаются через общий механизм выгрузок (exports.create → подписанная ссылка, журнал, файл живёт сутки).
// CSV — «;» и UTF-8 с BOM, как остальные выгрузки: 1С:Бухгалтерия 8 и Excel читают его без перекодировки.
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalQuery, type ActionCtx, type QueryCtx } from "./_generated/server";
import { loadCatalog } from "./catalog";
import { commerceMl, type CmlDocument } from "./lib/commerceml";
import type { Cell, ExportRange, ExportRow } from "./lib/exportRows";
import { nowIso } from "./lib/domain";
import { ORDER_STATUS, PAYMENT_METHODS } from "../src/data/catalog";
import { EXPORT_MAX_ROWS } from "../src/data/exports";
import { isFinished, paidAmount, refundedAmount } from "../src/data/logic";
import { toCsv } from "../src/lib/csv";

export const ACCOUNTING_HEADERS = ["Дата", "Время", "Вид операции", "Приход/расход", "Номер документа", "Основание", "Контрагент", "Сумма", "Валюта", "Способ оплаты", "Счёт учёта", "Комментарий", "Провёл"];

const PAGE = { money: 100, payouts: 300, orders: 100 } as const;
const ALMATY_MS = 5 * 3600_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** «14.10.2026» и «18:30» по Алматы — формат дат 1С. */
function dayTime(iso: string): [string, string] {
  const d = new Date(Date.parse(iso) + ALMATY_MS);
  return [`${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`, `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`];
}
const inRange = (iso: string | undefined, r: ExportRange) => !!iso && iso >= r.from && iso <= r.to;
/** Наличные — касса, остальное (Kaspi, карта, перевод) — банк. */
const ledger = (m: Doc<"orders">["payments"][number]["method"]) => (m === "cash" ? "Касса" : "Банк");

async function userNames(ctx: QueryCtx): Promise<(id: string | undefined) => string> {
  const users = new Map((await ctx.db.query("users").collect()).map((u) => [u._id as string, u.name ?? ""]));
  return (id) => (id ? (users.get(id) ?? "") : "Система");
}

function row(key: string, at: string, cells: Cell[]): ExportRow {
  return { key, sort: at, cells: [...dayTime(at), ...cells] };
}

export const _moneyPage = internalQuery({
  args: { from: v.string(), to: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, cursor }): Promise<{ rows: ExportRow[]; cursor: string; isDone: boolean }> => {
    const r = { from, to };
    const res = await ctx.db
      .query("orders")
      .withIndex("by_money", (q) => q.gte("moneyAt", from))
      .paginate({ cursor, numItems: PAGE.money });
    const name = await userNames(ctx);
    const rows: ExportRow[] = [];
    for (const o of res.page) {
      const basis = `Заказ №${o.number}`;
      for (const p of o.payments) {
        if (inRange(p.at, r)) rows.push(row(`${o._id}:${p.id}`, p.at, ["Поступление от покупателя", "Приход", p.id, basis, o.clientName, p.amount, "KZT", PAYMENT_METHODS[p.method], ledger(p.method), p.note ?? "", name(p.by)]));
        if (p.voidedAt && inRange(p.voidedAt, r))
          rows.push(row(`${o._id}:${p.id}:void`, p.voidedAt, ["Сторно поступления", "Приход", p.id, basis, o.clientName, -p.amount, "KZT", PAYMENT_METHODS[p.method], ledger(p.method), p.voidReason ?? "", name(p.voidedBy)]));
      }
      for (const x of o.refunds ?? []) {
        if (inRange(x.at, r)) rows.push(row(`${o._id}:${x.id}`, x.at, ["Возврат покупателю", "Расход", x.id, basis, o.clientName, x.amount, "KZT", PAYMENT_METHODS[x.method], ledger(x.method), x.reason, name(x.by)]));
      }
    }
    return { rows, cursor: res.continueCursor, isDone: res.isDone };
  },
});

export const _payoutsPage = internalQuery({
  args: { from: v.string(), to: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, cursor }): Promise<{ rows: ExportRow[]; cursor: string; isDone: boolean }> => {
    const res = await ctx.db
      .query("payouts")
      .withIndex("by_at", (q) => q.gte("at", from).lte("at", to))
      .paginate({ cursor, numItems: PAGE.payouts });
    const name = await userNames(ctx);
    const rows: ExportRow[] = [];
    for (const p of res.page) {
      const ex = await ctx.db.get(p.executorId);
      const orders = p.orderNumbers.map((n) => `№${n}`).join(", ");
      rows.push(row(p._id, p.at, ["Выплата исполнителю", "Расход", p._id, `Заказы ${orders}`, ex?.name ?? "Исполнитель удалён", p.amount, "KZT", PAYMENT_METHODS[p.method], ledger(p.method), p.note ?? "", name(p.by)]));
    }
    return { rows, cursor: res.continueCursor, isDone: res.isDone };
  },
});

export const _ordersPage = internalQuery({
  args: { from: v.string(), to: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { from, to, cursor }): Promise<{ docs: CmlDocument[]; cursor: string; isDone: boolean }> => {
    const res = await ctx.db
      .query("orders")
      .withIndex("by_done", (q) => q.gte("doneAt", from).lte("doneAt", to))
      .paginate({ cursor, numItems: PAGE.orders });
    const cat = await loadCatalog(ctx);
    const docs: CmlDocument[] = [];
    for (const o of res.page) {
      if (!isFinished(o) || !o.doneAt || o.clientPrice <= 0) continue;
      const client = await ctx.db.get(o.clientId);
      docs.push({
        id: o._id,
        number: o.number,
        doneAt: o.doneAt,
        status: ORDER_STATUS[o.status].label,
        client: { id: o.clientId, name: client?.name ?? o.clientName, phone: client?.anonymizedAt ? undefined : o.clientPhone, address: o.address ? `${o.city}, ${o.address}` : undefined },
        service: { id: o.serviceId, name: cat.label(o.serviceId) },
        price: o.clientPrice,
        paid: paidAmount(o),
        refunded: refundedAmount(o),
      });
    }
    return { docs, cursor: res.continueCursor, isDone: res.isDone };
  },
});

type Paged<T> = { cursor: string; isDone: boolean } & T;

/** Файл выгрузки для бухгалтерии: строки по времени, не больше EXPORT_MAX_ROWS. */
export async function buildAccountingFile(ctx: ActionCtx, kind: "accounting" | "commerceml", range: ExportRange): Promise<{ blob: Blob; rows: number; truncated: boolean }> {
  if (kind === "commerceml") {
    const docs: CmlDocument[] = [];
    let cursor: string | null = null;
    let truncated = false;
    for (;;) {
      const page: Paged<{ docs: CmlDocument[] }> = await ctx.runQuery(internal.accounting._ordersPage, { ...range, cursor });
      docs.push(...page.docs);
      if (docs.length > EXPORT_MAX_ROWS) {
        truncated = true;
        break;
      }
      if (page.isDone) break;
      cursor = page.cursor;
    }
    const sorted = docs.sort((a, b) => (a.doneAt < b.doneAt ? -1 : a.doneAt > b.doneAt ? 1 : 0)).slice(0, EXPORT_MAX_ROWS);
    return { blob: new Blob([commerceMl(sorted, nowIso())], { type: "application/xml;charset=utf-8" }), rows: sorted.length, truncated };
  }
  const seen = new Set<string>();
  const rows: ExportRow[] = [];
  for (const source of ["money", "payouts"] as const) {
    let cursor: string | null = null;
    for (;;) {
      const page: Paged<{ rows: ExportRow[] }> = await ctx.runQuery(source === "money" ? internal.accounting._moneyPage : internal.accounting._payoutsPage, { ...range, cursor });
      for (const r of page.rows) if (!seen.has(r.key)) (seen.add(r.key), rows.push(r));
      if (page.isDone || rows.length > EXPORT_MAX_ROWS) break;
      cursor = page.cursor;
    }
  }
  const sorted = rows.sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0));
  const truncated = sorted.length > EXPORT_MAX_ROWS;
  const cells = sorted.slice(0, EXPORT_MAX_ROWS).map((r) => r.cells);
  return { blob: new Blob([toCsv([ACCOUNTING_HEADERS, ...cells])], { type: "text/csv;charset=utf-8" }), rows: cells.length, truncated };
}
