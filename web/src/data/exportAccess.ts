// Выгрузки по правам (ТЗ п.5.12, п.26.2): в файл попадает только то, что сотрудник и так видит на экранах.
// Общие для сервера (convex/exports.ts проверяет и вырезает колонки) и кнопки «Выгрузка».
import type { ExportKind } from "./exports";
import { can, type Permission, type PermissionHolder } from "./permissions";

/** Что нужно, кроме права «Выгрузка в Excel», для каждой выгрузки; "owner" — только владельцу (журнал действий). */
const EXPORT_NEEDS: Record<ExportKind, Permission | "owner"> = {
  leads: "clients.view",
  orders: "clients.view",
  calls: "calls.view",
  executors: "data.export",
  payments: "money.view",
  payouts: "money.payouts",
  audit: "owner",
};

/** Колонки с деньгами: заголовок → право, без которого колонку не выгружаем (src: convex/lib/exportRows.ts EXPORT_HEADERS). */
const MONEY_COLUMNS: Partial<Record<ExportKind, Record<string, Permission>>> = {
  orders: {
    "Цена клиента": "money.view",
    "Выплата исполнителю": "money.payouts",
    Маржа: "money.payouts",
    Оплачено: "money.view",
    Возвращено: "money.view",
    "Долг клиента": "money.view",
    "Выплата мастеру проведена": "money.payouts",
  },
  executors: { "Начислено за период": "money.payouts", "Выплачено за период": "money.payouts" },
};

/** Можно ли пользователю эту выгрузку. */
export function exportAllowed(u: PermissionHolder | null | undefined, kind: ExportKind): boolean {
  if (!can(u, "data.export")) return false;
  const need = EXPORT_NEEDS[kind];
  return need === "owner" ? u?.role === "owner" : can(u, need);
}

/** Номера колонок, которые пользователь видит (по заголовкам выгрузки). */
export function exportColumns(u: PermissionHolder | null | undefined, kind: ExportKind, headers: readonly string[]): number[] {
  const rules = MONEY_COLUMNS[kind] ?? {};
  return headers.flatMap((h, i) => {
    const need = rules[h];
    return !need || can(u, need) ? [i] : [];
  });
}
