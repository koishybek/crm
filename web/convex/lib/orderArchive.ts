// Архив заказов (ТЗ п.27.8, E13): все заказы за всё время, а не только доска за 45 дней. Фильтры — статусы, период
// по дате создания или выполнения, исполнитель, источник, направление и поиск (номер заказа, имя или телефон клиента).
// Читаем по индексам и страницами (usePaginatedQuery) — архив растёт вместе с базой, а ответ остаётся маленьким.
import type { ExpressionOrValue, FilterBuilder, NamedTableInfo, PaginationOptions, PaginationResult } from "convex/server";
import { ConvexError, v, type Infer } from "convex/values";
import type { DataModel, Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { scopeOf, type Me } from "./access";
import { orderFor } from "./dto";
import { normalizeLogin } from "./login";
import { normalizePhone } from "./phone";
import { orderStatus, source } from "../schema";
import type { Order, OrderStatus } from "../../src/data/types";

/** Фильтры архива — аргументы orders.list. */
export const archiveArgs = {
  statuses: v.optional(v.array(orderStatus)),
  period: v.optional(v.object({ by: v.union(v.literal("created"), v.literal("done")), from: v.optional(v.string()), to: v.optional(v.string()) })),
  /** Исполнитель или "none" — заказы без исполнителя. */
  executorId: v.optional(v.union(v.id("executors"), v.literal("none"))),
  source: v.optional(source),
  category: v.optional(v.string()),
  /** Номер заказа («1024», «№1024»), телефон клиента (от 10 цифр) или часть имени клиента. */
  q: v.optional(v.string()),
};
const archiveFilters = v.object(archiveArgs);
export type ArchiveFilters = Infer<typeof archiveFilters>;

/** Самая большая страница архива. */
const PAGE_MAX = 100;
/**
 * Строк индекса на страницу — не больше: с редким фильтром (один мастер, один источник) страница выйдет короче,
 * а следующую браузер дочитает сам. Так один запрос не перебирает всю историю заказов.
 */
const SCAN_MAX = 1000;
/** Поиск по имени: столько клиентов и столько последних заказов каждого — результат одной страницей. */
const NAME_CLIENTS = 10;
const NAME_ORDERS_PER_CLIENT = 50;
const QUERY_MAX = 100;

type Period = { by: "created" | "done"; from?: string; to?: string };
type Text = { kind: "number"; number: number } | { kind: "phone"; phone: string } | { kind: "name"; text: string };

/** Что ищут в строке поиска: номер заказа, телефон или имя клиента. */
export function parseOrderQuery(raw: string | undefined): Text | null {
  const s = (raw ?? "").trim().slice(0, QUERY_MAX);
  if (!s) return null;
  const compact = s.replace(/^№\s*/, "");
  if (/^\d{1,9}$/.test(compact)) return { kind: "number", number: Number(compact) };
  const digits = s.replace(/\D/g, "");
  if (digits.length >= 8 && /^[\d\s+()-]+$/.test(s)) return { kind: "phone", phone: normalizePhone(s) ?? normalizeLogin(digits) };
  return { kind: "name", text: s };
}

/** Граница периода → ISO UTC (как createdAt и doneAt); мусор — понятная ошибка, а не пустой архив. */
function bound(value: string | undefined, label: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new ConvexError(`Неверная дата: ${label}`);
  return new Date(t).toISOString();
}

function cleanPeriod(p: ArchiveFilters["period"]): Period | undefined {
  if (!p) return undefined;
  const from = bound(p.from, "начало периода");
  const to = bound(p.to, "конец периода");
  if (from && to && from > to) throw new ConvexError("Начало периода позже конца");
  return { by: p.by, from, to };
}

/** Условия, которые не взял на себя индекс, — одни для страниц из базы и для поиска по номеру и имени. */
interface Conditions {
  /** Направления: фильтр «направление» или область руководителя; null — все. */
  categories: string[] | null;
  statuses?: OrderStatus[];
  executorId?: Id<"executors"> | "none";
  source?: Doc<"orders">["source"];
  /** Период, если его не покрывает диапазон индекса. */
  period?: Period;
}

const periodField = (p: Period) => (p.by === "done" ? "doneAt" : "createdAt");

/** Проверка заказа в памяти — для поиска по номеру и имени (там страница собирается не из одного диапазона индекса). */
function matches(o: Doc<"orders">, c: Conditions): boolean {
  if (c.categories && !c.categories.includes(o.category)) return false;
  if (c.statuses && !c.statuses.includes(o.status)) return false;
  if (c.executorId === "none" ? o.executorId !== undefined : c.executorId !== undefined && o.executorId !== c.executorId) return false;
  if (c.source && o.source !== c.source) return false;
  if (c.period) {
    const at = o[periodField(c.period)];
    if (!at || (c.period.from && at < c.period.from) || (c.period.to && at > c.period.to)) return false;
  }
  return true;
}

type OrdersFilter = FilterBuilder<NamedTableInfo<DataModel, "orders">>;

/** Те же условия выражением фильтра Convex — для постраничного чтения. Условий нет — true. */
function filterOf(q: OrdersFilter, c: Conditions): ExpressionOrValue<boolean> {
  const parts: ExpressionOrValue<boolean>[] = [];
  if (c.categories) parts.push(q.or(...c.categories.map((x) => q.eq(q.field("category"), x))));
  if (c.statuses) parts.push(q.or(...c.statuses.map((s) => q.eq(q.field("status"), s))));
  if (c.executorId === "none") parts.push(q.eq(q.field("executorId"), undefined));
  else if (c.executorId) parts.push(q.eq(q.field("executorId"), c.executorId));
  if (c.source) parts.push(q.eq(q.field("source"), c.source));
  if (c.period) {
    const field = periodField(c.period);
    parts.push(q.neq(q.field(field), undefined));
    if (c.period.from) parts.push(q.gte(q.field(field), c.period.from));
    if (c.period.to) parts.push(q.lte(q.field(field), c.period.to));
  }
  return parts.length ? q.and(...parts) : true;
}

const donePage = (page: Order[]): PaginationResult<Order> => ({ page, isDone: true, continueCursor: "" });

/**
 * Страница архива. Индекс выбирается по фильтрам: телефон — заказы клиента (by_client), период по выполнению — by_done,
 * иначе — by_created; новые сверху. Номер заказа и имя клиента — точечный поиск, результат одной страницей.
 * Руководитель — только свои направления; деньги заказов — только владельцу (аудит M-2).
 */
export async function archivePage(ctx: QueryCtx, me: Me, f: ArchiveFilters, opts: PaginationOptions): Promise<PaginationResult<Order>> {
  const scope = scopeOf(me);
  if (f.category && scope && !scope.includes(f.category)) return donePage([]);
  const categories = f.category ? [f.category] : scope;
  if (categories && !categories.length) return donePage([]);
  const statuses = f.statuses?.length ? [...new Set(f.statuses)] : undefined;
  const period = cleanPeriod(f.period);
  const base: Omit<Conditions, "period"> = { categories, statuses, executorId: f.executorId, source: f.source };
  const dto = orderFor(me);
  const text = parseOrderQuery(f.q);

  if (text?.kind === "number") {
    const rows = await ctx.db
      .query("orders")
      .withIndex("by_number", (q) => q.eq("number", text.number))
      .take(5);
    return donePage(rows.filter((o) => matches(o, { ...base, period })).map(dto));
  }
  if (text?.kind === "name") {
    const clients = await ctx.db
      .query("clients")
      .withSearchIndex("search_name", (q) => q.search("name", text.text))
      .take(NAME_CLIENTS);
    const rows: Doc<"orders">[] = [];
    for (const c of clients) {
      rows.push(
        ...(await ctx.db
          .query("orders")
          .withIndex("by_client", (q) => q.eq("clientId", c._id))
          .order("desc")
          .take(NAME_ORDERS_PER_CLIENT)),
      );
    }
    const found = rows.filter((o) => matches(o, { ...base, period })).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return donePage(found.slice(0, PAGE_MAX).map(dto));
  }

  const page = { ...opts, numItems: Math.max(1, Math.min(Math.floor(opts.numItems) || 1, PAGE_MAX)), maximumRowsRead: Math.min(opts.maximumRowsRead ?? SCAN_MAX, SCAN_MAX) };
  let res: PaginationResult<Doc<"orders">>;
  if (text?.kind === "phone") {
    const client = await ctx.db
      .query("clients")
      .withIndex("by_phone", (q) => q.eq("phone", text.phone))
      .first();
    if (!client) return donePage([]);
    // Заказы клиента: период по созданию — диапазоном индекса, по выполнению — фильтром.
    const byCreated = period?.by === "created" ? period : undefined;
    res = await ctx.db
      .query("orders")
      .withIndex("by_client", (q) => {
        const c = q.eq("clientId", client._id);
        const lower = byCreated?.from ? c.gte("createdAt", byCreated.from) : c;
        return byCreated?.to ? lower.lte("createdAt", byCreated.to) : lower;
      })
      .order("desc")
      .filter((q) => filterOf(q, { ...base, period: byCreated ? undefined : period }))
      .paginate(page);
  } else if (period?.by === "done") {
    res = await ctx.db
      .query("orders")
      .withIndex("by_done", (q) => {
        const lower = period.from ? q.gte("doneAt", period.from) : q.gt("doneAt", "");
        return period.to ? lower.lte("doneAt", period.to) : lower;
      })
      .order("desc")
      .filter((q) => filterOf(q, base))
      .paginate(page);
  } else {
    res = await ctx.db
      .query("orders")
      .withIndex("by_created", (q) => {
        const lower = period?.from ? q.gte("createdAt", period.from) : q;
        return period?.to ? lower.lte("createdAt", period.to) : lower;
      })
      .order("desc")
      .filter((q) => filterOf(q, base))
      .paginate(page);
  }
  return { ...res, page: res.page.map(dto) };
}
