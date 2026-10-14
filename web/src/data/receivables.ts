// Долги клиентов для «Главной» владельца (ТЗ п.5 «Dashboard», п.13 «задолженность»): сервер (convex/receivables.ts)
// отдаёт должников, сумму долга считает debt() из ./logic — те же правила, что в карточке заказа и клиента.

/** Сданный заказ, который клиент оплатил не полностью. */
export interface Debtor {
  orderId: string;
  number: number;
  clientId: string;
  clientName: string;
  /** Сколько клиент ещё должен по заказу, ₸. */
  debt: number;
  /** С какого момента ждём оплату: работа сдана (doneAt), у старых заказов без отметки — дата создания. */
  since: string;
}

export interface Receivables {
  total: number;
  count: number;
  /** Самые давние долги — первыми. */
  debtors: Debtor[];
  /** Должников больше, чем сервер отдаёт за раз: сумма и список — по первым. */
  truncated: boolean;
}

const DAY_MS = 86400_000;

/** Сколько полных суток долг ждёт оплаты. */
export const debtDays = (since: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(since)) / DAY_MS));
