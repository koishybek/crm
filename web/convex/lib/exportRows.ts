// Строки выгрузок CSV владельца (ТЗ п.26.9): заголовки и чтение страницами по индексам за период — без лимита
// браузера («только то, что загружено»). Ячейки — строки и числа (undefined в массивах Convex не передаёт);
// формулы в ячейках обезвреживает toCsv (src/lib/csv.ts) при сборке файла. Деньги — формулами src/data/logic.ts.
import type { PaginationResult } from "convex/server";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { loadCatalog } from "../catalog";
import { almatyStamp } from "./audit";
import { executorUser } from "./domain";
import { AUDIT_ENTITY, auditRoleLabel, auditSearchKey } from "../../src/data/audit";
import { LEAD_STATUS, ORDER_STATUS, PAYMENT_METHODS, SOURCES, URGENCY } from "../../src/data/catalog";
import type { ExportKind } from "../../src/data/exports";
import { debt, isFinished, margin, paidAmount, payout, refundedAmount } from "../../src/data/logic";
import type { AuditEntity } from "../../src/data/types";

export type Cell = string | number;
/** Строка файла: key — для повторов (заказ мог попасть на две страницы), sort — порядок в файле (по времени). */
export interface ExportRow {
  key: string;
  sort: string;
  cells: Cell[];
}
export interface ExportPage {
  rows: ExportRow[];
  cursor: string;
  isDone: boolean;
}
export interface ExportRange {
  from: string;
  to: string;
}
export interface AuditExportFilters {
  /** Сотрудник или "system" — система, AI и каналы (как фильтр «Журнала»). */
  actorId?: Id<"users"> | "system";
  entity?: AuditEntity;
  q?: string;
}

export const EXPORT_HEADERS: Record<ExportKind, string[]> = {
  leads: ["Заявка", "Создана", "Источник", "Клиент", "Телефон", "Услуга", "Направление", "Город", "Срочность", "Статус", "Оператор", "Причина отказа", "Заказ", "Описание"],
  orders: ["Заказ", "Создан", "Источник", "Клиент", "Телефон", "Услуга", "Направление", "Город", "Адрес", "Срок", "Статус", "Исполнитель", "Выполнен", "Цена клиента", "Выплата исполнителю", "Маржа", "Оплачено", "Возвращено", "Долг клиента", "Выплата мастеру проведена"],
  calls: ["Начало", "Звонок", "Статус", "Номер клиента", "Клиент", "Оператор", "Длительность, сек", "Заявка", "Запись", "Резюме AI"],
  executors: ["Исполнитель", "Телефон", "Город", "Направления", "Навыки", "Приём заказов", "Рейтинг", "Отзывов", "Сотрудничество", "С нами с", "Доступ", "Выполнено заказов за период", "Начислено за период", "Выплачено за период"],
  payments: ["Дата", "Операция", "Заказ", "Клиент", "Сумма", "Способ", "Комментарий", "Кто внёс", "Сторно", "Причина сторно"],
  payouts: ["Дата выплаты", "Исполнитель", "Сумма", "Способ", "Заказы", "Комментарий", "Провёл", "Проведена в системе"],
  audit: ["Дата и время", "Кто", "Роль", "Объект", "Описание", "Действие", "ID объекта"],
  // Бухгалтерские выгрузки собирает convex/accounting.ts (свои заголовки и XML).
  accounting: [],
  commerceml: [],
};

/**
 * Документов на страницу: страница — отдельный запрос, ответ — с запасом до лимитов. У звонков в документе
 * расшифровка (до 20 000 символов), у заказов — список файлов: их страницы меньше.
 */
const PAGE: Record<ExportKind, number> = { leads: 200, orders: 100, calls: 50, executors: 200, payments: 100, payouts: 300, audit: 500, accounting: 100, commerceml: 100 };

const CALL_STATUS: Record<Doc<"calls">["status"], string> = { ringing: "Звонит", answered: "Идёт разговор", missed: "Пропущенный", completed: "Завершён" };
const stamp = (iso: string | undefined): string => (iso ? almatyStamp(iso) : "");
/** Только дата — «15.03.2024». */
const day = (iso: string): string => almatyStamp(iso).slice(0, 10);
const inRange = (iso: string, r: ExportRange) => iso >= r.from && iso <= r.to;

/** Справочники для подписей — читаются, только если нужны этой выгрузке. */
function lookups(ctx: QueryCtx) {
  let users: Promise<Map<string, string>> | null = null;
  let executors: Promise<Map<string, string>> | null = null;
  let catalog: ReturnType<typeof loadCatalog> | null = null;
  return {
    async user(id: string | undefined): Promise<string> {
      users ??= ctx.db
        .query("users")
        .collect()
        .then((rows) => new Map(rows.map((u) => [u._id as string, u.name ?? ""])));
      return id ? ((await users).get(id) ?? "") : "";
    },
    async executor(id: string | undefined): Promise<string> {
      executors ??= ctx.db
        .query("executors")
        .collect()
        .then((rows) => new Map(rows.map((e) => [e._id as string, e.name])));
      return id ? ((await executors).get(id) ?? "Исполнитель удалён") : "";
    },
    async catalog() {
      catalog ??= loadCatalog(ctx);
      const c = await catalog;
      return {
        service: (id: string) => c.label(id),
        categoryOfService: (id: string) => c.categories.find((x) => x.id === c.services.find((s) => s.id === id)?.category)?.label ?? "",
        category: (key: string) => c.categories.find((x) => x.id === key)?.label ?? key,
      };
    },
  };
}

type Look = ReturnType<typeof lookups>;
const pageOut = <T>(res: PaginationResult<T>, rows: ExportRow[]): ExportPage => ({ rows, cursor: res.continueCursor, isDone: res.isDone });

async function leadsPage(ctx: QueryCtx, look: Look, r: ExportRange, cursor: string | null): Promise<ExportPage> {
  const res = await ctx.db
    .query("leads")
    .withIndex("by_created", (q) => q.gte("createdAt", r.from).lte("createdAt", r.to))
    .paginate({ cursor, numItems: PAGE.leads });
  const cat = await look.catalog();
  const rows: ExportRow[] = [];
  for (const l of res.page) {
    const order = l.orderId ? await ctx.db.get(l.orderId) : null;
    rows.push({
      key: l._id,
      sort: l.createdAt,
      cells: [
        l.number,
        stamp(l.createdAt),
        SOURCES[l.source].label,
        l.clientName,
        l.clientPhone,
        cat.service(l.serviceId),
        cat.categoryOfService(l.serviceId),
        l.city,
        URGENCY[l.urgency].label,
        LEAD_STATUS[l.status].label,
        await look.user(l.operatorId),
        l.rejectReason ?? "",
        order ? order.number : "",
        l.description,
      ],
    });
  }
  return pageOut(res, rows);
}

async function ordersPage(ctx: QueryCtx, look: Look, r: ExportRange, cursor: string | null): Promise<ExportPage> {
  const res = await ctx.db
    .query("orders")
    .withIndex("by_created", (q) => q.gte("createdAt", r.from).lte("createdAt", r.to))
    .paginate({ cursor, numItems: PAGE.orders });
  const cat = await look.catalog();
  const rows: ExportRow[] = [];
  for (const o of res.page) {
    rows.push({
      key: o._id,
      sort: o.createdAt,
      cells: [
        o.number,
        stamp(o.createdAt),
        SOURCES[o.source].label,
        o.clientName,
        o.clientPhone,
        cat.service(o.serviceId),
        cat.category(o.category),
        o.city,
        o.address,
        stamp(o.deadline),
        ORDER_STATUS[o.status].label,
        await look.executor(o.executorId),
        isFinished(o) ? stamp(o.doneAt) : "",
        o.clientPrice,
        payout(o),
        margin(o),
        paidAmount(o),
        refundedAmount(o),
        debt(o),
        o.payoutPaidAt ? stamp(o.payoutPaidAt) : o.payoutPaid ? "да" : "",
      ],
    });
  }
  return pageOut(res, rows);
}

async function callsPage(ctx: QueryCtx, look: Look, r: ExportRange, cursor: string | null): Promise<ExportPage> {
  const res = await ctx.db
    .query("calls")
    .withIndex("by_started", (q) => q.gte("startedAt", r.from).lte("startedAt", r.to))
    .paginate({ cursor, numItems: PAGE.calls });
  const rows: ExportRow[] = [];
  for (const c of res.page) {
    const lead = c.leadId ? await ctx.db.get(c.leadId) : null;
    rows.push({
      key: c._id,
      sort: c.startedAt,
      cells: [
        stamp(c.startedAt),
        c.direction === "in" ? "Входящий" : "Исходящий",
        CALL_STATUS[c.status],
        c.direction === "in" ? c.from : c.to,
        c.clientName ?? "",
        await look.user(c.operatorId),
        c.duration ?? "",
        lead ? lead.number : "",
        c.recordingId || c.recordingUrl ? "есть" : "",
        c.ai?.summary ?? "",
      ],
    });
  }
  return pageOut(res, rows);
}

/** Исполнители — все, без периода; заказы и выплаты за период добавляет действие (exports.create) по executorStatsPage. */
async function executorsPage(ctx: QueryCtx, look: Look, cursor: string | null): Promise<ExportPage> {
  const res = await ctx.db.query("executors").paginate({ cursor, numItems: PAGE.executors });
  const cat = await look.catalog();
  const rows: ExportRow[] = [];
  for (const e of res.page) {
    const user = await executorUser(ctx, e._id);
    rows.push({
      key: e._id,
      sort: e.name.toLocaleLowerCase("ru"),
      cells: [
        e.name,
        e.phone,
        e.city,
        e.categories.map(cat.category).join(", "),
        e.skills.join(", "),
        e.available ? "на смене" : "выходной",
        e.rating,
        e.reviews,
        e.cooperation === "staff" ? "В штате" : "Фриланс",
        day(e.joinedAt),
        !user ? "нет входа" : user.active === false ? "отключён" : "есть",
      ],
    });
  }
  return pageOut(res, rows);
}

/**
 * Оплаты и возвраты, сделанные в периоде, — по датам самих денег. Заказы находим по индексу by_money (дата последнего
 * движения денег не раньше начала периода), строки — только оплаты и возвраты, попавшие в период.
 */
async function paymentsPage(ctx: QueryCtx, look: Look, r: ExportRange, cursor: string | null): Promise<ExportPage> {
  const res = await ctx.db
    .query("orders")
    .withIndex("by_money", (q) => q.gte("moneyAt", r.from))
    .paginate({ cursor, numItems: PAGE.payments });
  const rows: ExportRow[] = [];
  for (const o of res.page) {
    for (const p of o.payments) {
      if (!inRange(p.at, r)) continue;
      rows.push({
        key: `${o._id}:${p.id}`,
        sort: p.at,
        cells: [stamp(p.at), "Оплата", o.number, o.clientName, p.amount, PAYMENT_METHODS[p.method], p.note ?? "", await look.user(p.by), stamp(p.voidedAt), p.voidReason ?? ""],
      });
    }
    for (const x of o.refunds ?? []) {
      if (!inRange(x.at, r)) continue;
      rows.push({ key: `${o._id}:${x.id}`, sort: x.at, cells: [stamp(x.at), "Возврат", o.number, o.clientName, -x.amount, PAYMENT_METHODS[x.method], x.reason, await look.user(x.by), "", ""] });
    }
  }
  return pageOut(res, rows);
}

async function payoutsPage(ctx: QueryCtx, look: Look, r: ExportRange, cursor: string | null): Promise<ExportPage> {
  const res = await ctx.db
    .query("payouts")
    .withIndex("by_at", (q) => q.gte("at", r.from).lte("at", r.to))
    .paginate({ cursor, numItems: PAGE.payouts });
  const rows: ExportRow[] = [];
  for (const p of res.page) {
    rows.push({
      key: p._id,
      sort: p.at,
      cells: [stamp(p.at), await look.executor(p.executorId), p.amount, PAYMENT_METHODS[p.method], p.orderNumbers.map((n) => `№${n}`).join(", "), p.note ?? "", await look.user(p.by), stamp(p.createdAt)],
    });
  }
  return pageOut(res, rows);
}

/** Журнал — с теми же фильтрами, что на экране «Журнал действий»: кто действовал, тип объекта, текст описания. */
async function auditPage(ctx: QueryCtx, r: ExportRange, cursor: string | null, f: AuditExportFilters): Promise<ExportPage> {
  const actor = f.actorId === "system" ? undefined : f.actorId;
  const rows =
    f.actorId === undefined
      ? ctx.db.query("audit").withIndex("by_at", (q) => q.gte("at", r.from).lte("at", r.to))
      : ctx.db.query("audit").withIndex("by_actor", (q) => q.eq("actorId", actor).gte("at", r.from).lte("at", r.to));
  const scoped = f.entity ? rows.filter((q) => q.eq(q.field("entity"), f.entity)) : rows;
  const res = await scoped.paginate({ cursor, numItems: PAGE.audit });
  const needle = auditSearchKey(f.q ?? "");
  const page = needle ? res.page.filter((x) => auditSearchKey(x.summary).includes(needle)) : res.page;
  return pageOut(
    res,
    page.map((x) => ({ key: x._id, sort: x.at, cells: [stamp(x.at), x.actorName, auditRoleLabel(x), AUDIT_ENTITY[x.entity].one, x.summary, x.action, x.entityId ?? ""] })),
  );
}

/** Одна страница выгрузки. */
export async function exportPage(ctx: QueryCtx, kind: ExportKind, r: ExportRange, cursor: string | null, audit: AuditExportFilters = {}): Promise<ExportPage> {
  const look = lookups(ctx);
  switch (kind) {
    case "leads":
      return leadsPage(ctx, look, r, cursor);
    case "orders":
      return ordersPage(ctx, look, r, cursor);
    case "calls":
      return callsPage(ctx, look, r, cursor);
    case "executors":
      return executorsPage(ctx, look, cursor);
    case "payments":
      return paymentsPage(ctx, look, r, cursor);
    case "payouts":
      return payoutsPage(ctx, look, r, cursor);
    case "audit":
      return auditPage(ctx, r, cursor, audit);
    case "accounting":
    case "commerceml":
      throw new Error("Бухгалтерские выгрузки собирает convex/accounting.ts");
  }
}

/** Работа исполнителя за период: сданные заказы и начисленная выплата (по дате выполнения), выплачено (по датам выплат). */
export interface ExecutorStat {
  executorId: string;
  done: number;
  accrued: number;
  paid: number;
}
export type StatsSource = "orders" | "payouts";

export async function executorStatsPage(ctx: QueryCtx, source: StatsSource, r: ExportRange, cursor: string | null): Promise<{ stats: ExecutorStat[]; cursor: string; isDone: boolean }> {
  const acc = new Map<string, ExecutorStat>();
  const of = (id: string) => {
    let s = acc.get(id);
    if (!s) acc.set(id, (s = { executorId: id, done: 0, accrued: 0, paid: 0 }));
    return s;
  };
  if (source === "orders") {
    const res = await ctx.db
      .query("orders")
      .withIndex("by_done", (q) => q.gte("doneAt", r.from).lte("doneAt", r.to))
      .paginate({ cursor, numItems: PAGE.orders });
    for (const o of res.page) {
      if (!o.executorId || !isFinished(o)) continue;
      const s = of(o.executorId);
      s.done += 1;
      s.accrued += payout(o);
    }
    return { stats: [...acc.values()], cursor: res.continueCursor, isDone: res.isDone };
  }
  const res = await ctx.db
    .query("payouts")
    .withIndex("by_at", (q) => q.gte("at", r.from).lte("at", r.to))
    .paginate({ cursor, numItems: PAGE.payouts });
  for (const p of res.page) of(p.executorId).paid += p.amount;
  return { stats: [...acc.values()], cursor: res.continueCursor, isDone: res.isDone };
}
