// Изоляция компаний (ТЗ §2.5, §24): каждая функция видит только документы своей компании.
//
// ctx.db в query/mutation (convex/lib/functions.ts) — обёртка над базой Convex:
//  • компания берётся из вошедшего пользователя (users.tenantId; нет поля — компания по умолчанию);
//  • без входа (крон, вебхук, планировщик) её задаёт bindTenant(ctx, …) или первый прочитанный по id документ компании
//    (функция «по заказу X» работает в компании заказа);
//  • query: индекс с компанией первым полем (t_<имя>), если он есть в схеме, иначе — фильтр по tenantId;
//    без известной компании чтение списка — ошибка, а не данные всех компаний;
//  • get чужого документа — null, patch/replace/delete чужого — ошибка, insert проставляет tenantId сам.
// Таблицы входа (Convex Auth), реестр компаний и лимиты — общие. Явный доступ ко всем компаниям — unscopedDb(ctx)
// (миграция, платформа, вход по логину), только там, где это нужно по смыслу.
import { authTables, getAuthUserId } from "@convex-dev/auth/server";
import { getFunctionName, type Auth, type FunctionReference, type GenericDatabaseWriter } from "convex/server";
import type { DataModel } from "../_generated/dataModel";
import schema from "../schema";

/** Компания, которой принадлежат данные, заведённые до SaaS (и документы без tenantId до миграции). */
export const DEFAULT_TENANT = "t-komfort";

/** Общие таблицы: вход, реестр компаний, счётчики лимитов (ключ лимита сам включает компанию, где нужно). */
// authTables включает и users — но пользователи принадлежат компании (users.tenantId), их изолируем как всё остальное.
export const GLOBAL_TABLES: ReadonlySet<string> = new Set([...Object.keys(authTables).filter((t) => t !== "users"), "tenants", "rateLimits"]);

type Db = GenericDatabaseWriter<DataModel>;
type Doc = Record<string, unknown> & { _id: string };
/** Конструкторы запросов Convex — без типов модели: обёртка подставляет индекс и фильтр, вызывающий код типизирован как обычно. */
type IndexRange = { eq: (field: string, value: unknown) => IndexRange };
type SearchFilter = { eq: (field: string, value: unknown) => SearchFilter };
type Expr = unknown;
type FilterBuilder = { eq: (a: Expr, b: Expr) => Expr; or: (...e: Expr[]) => Expr; field: (name: string) => Expr };
type RawQuery = {
  withIndex: (name: string, range?: (q: IndexRange) => unknown) => RawQuery;
  withSearchIndex: (name: string, f: (q: SearchFilter) => unknown) => RawQuery;
  fullTableScan: () => RawQuery;
  order: (dir: "asc" | "desc") => RawQuery;
  filter: (p: (q: FilterBuilder) => Expr) => RawQuery;
  collect: () => Promise<Doc[]>;
  take: (n: number) => Promise<Doc[]>;
  first: () => Promise<Doc | null>;
  unique: () => Promise<Doc | null>;
  paginate: (opts: unknown) => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<Doc>;
};
type LooseDb = {
  get: (a: unknown, b?: unknown) => Promise<Doc | null>;
  query: (table: string) => RawQuery;
  insert: (table: string, value: Record<string, unknown>) => Promise<string>;
  patch: (id: string, value: Record<string, unknown>) => Promise<void>;
  replace: (id: string, value: Record<string, unknown>) => Promise<void>;
  delete: (id: string) => Promise<void>;
  normalizeId: (table: string, id: string) => string | null;
};

/** Индексы схемы: у каких есть пара «t_<имя>» с компанией первым полем, у каких таблиц есть by_tenant. */
const INDEXES: ReadonlyMap<string, ReadonlySet<string>> = (() => {
  const out = new Map<string, Set<string>>();
  for (const [table, def] of Object.entries(schema.tables)) {
    const list = (def as unknown as { " indexes": () => { indexDescriptor: string; fields: string[] }[] })[" indexes"]();
    out.set(table, new Set(list.map((i) => i.indexDescriptor)));
  }
  return out;
})();
/** Полнотекстовые индексы с фильтром tenantId (filterFields в схеме). */
const TENANT_SEARCH: ReadonlySet<string> = new Set(["clients.search_name"]);

const tenantIndexOf = (table: string, index: string): string | null => (INDEXES.get(table)?.has(`t_${index}`) ? `t_${index}` : null);
const hasByTenant = (table: string) => INDEXES.get(table)?.has("by_tenant") ?? false;

/** «?c=<компания>» для адресов входящих уведомлений; у компании по умолчанию — пусто (адреса, выданные до SaaS, не меняются). */
export const companyQuery = (tenantId: string): string => (tenantId === DEFAULT_TENANT ? "" : `?c=${encodeURIComponent(tenantId)}`);

/** Компания документа: без поля — данные до SaaS, компания по умолчанию. */
export const tenantOfDoc = (doc: object): string => {
  const t = (doc as { tenantId?: unknown }).tenantId;
  return typeof t === "string" ? t : DEFAULT_TENANT;
};

/** Фильтр «документ этой компании» — для индексов без компании первым полем. */
const ownFilter = (tenant: string) => (q: FilterBuilder) =>
  tenant === DEFAULT_TENANT ? q.or(q.eq(q.field("tenantId"), tenant), q.eq(q.field("tenantId"), undefined)) : q.eq(q.field("tenantId"), tenant);

export class TenantDb {
  /** Компания этого вызова; null — ещё не известна. */
  tenant: string | null;
  readonly raw: Db;
  private readonly loose: LooseDb;

  constructor(raw: Db, tenant: string | null) {
    this.raw = raw;
    this.loose = raw as unknown as LooseDb;
    this.tenant = tenant;
  }

  get system() {
    return this.raw.system;
  }
  get vars() {
    return this.raw.vars;
  }

  normalizeId(table: string, id: string) {
    return this.loose.normalizeId(table, id);
  }

  /** Таблица id среди общих — по имени таблицы, если его передали, иначе по формату id. */
  private isGlobal(table: string | null, id: string): boolean {
    if (table) return GLOBAL_TABLES.has(table);
    for (const t of GLOBAL_TABLES) if (this.loose.normalizeId(t, id) !== null) return true;
    return false;
  }

  private require(what: string): string {
    if (this.tenant === null) throw new Error(`Компания не определена: ${what}`);
    return this.tenant;
  }

  async get(a: unknown, b?: unknown): Promise<Doc | null> {
    const table = b === undefined ? null : String(a);
    const id = String(b === undefined ? a : b);
    const doc = b === undefined ? await this.loose.get(a) : await this.loose.get(a, b);
    if (!doc || this.isGlobal(table, id)) return doc;
    const owner = tenantOfDoc(doc);
    // Без входа функция работает в компании первого прочитанного документа (заказ из аргумента планировщика и т.п.).
    if (this.tenant === null) this.tenant = owner;
    return owner === this.tenant ? doc : null;
  }

  query(table: string): unknown {
    const raw = this.loose.query(table);
    if (GLOBAL_TABLES.has(table)) return raw;
    const tenant = this.require(`чтение ${table}`);
    const filter = ownFilter(tenant);
    const base = (): RawQuery => (hasByTenant(table) ? raw.withIndex("by_tenant", (q) => q.eq("tenantId", tenant)) : raw.filter(filter));
    return {
      withIndex: (name: string, range?: (q: IndexRange) => unknown) => {
        const scoped = tenantIndexOf(table, name);
        if (scoped) return raw.withIndex(scoped, (q) => (range ? range(q.eq("tenantId", tenant)) : q.eq("tenantId", tenant)));
        return raw.withIndex(name, range).filter(filter);
      },
      withSearchIndex: (name: string, f: (q: SearchFilter) => unknown) =>
        TENANT_SEARCH.has(`${table}.${name}`)
          ? raw.withSearchIndex(name, (q) => (f(q) as SearchFilter).eq("tenantId", tenant))
          : raw.withSearchIndex(name, f).filter(filter),
      fullTableScan: () => base(),
      order: (dir: "asc" | "desc") => base().order(dir),
      filter: (p: (q: FilterBuilder) => Expr) => base().filter(p),
      collect: () => base().collect(),
      take: (n: number) => base().take(n),
      first: () => base().first(),
      unique: () => base().unique(),
      paginate: (opts: unknown) => base().paginate(opts),
      [Symbol.asyncIterator]: () => base()[Symbol.asyncIterator](),
    };
  }

  async insert(table: string, value: Record<string, unknown>): Promise<string> {
    if (GLOBAL_TABLES.has(table)) return this.loose.insert(table, value);
    const tenant = this.require(`запись в ${table}`);
    if (value.tenantId !== undefined && value.tenantId !== tenant) throw new Error("Документ другой компании");
    return this.loose.insert(table, { ...value, tenantId: tenant });
  }

  /** Документ своей компании для изменения — иначе ошибка (чужой id не меняем и не удаляем). */
  private async own(a: unknown, b: unknown): Promise<{ id: string; table: string | null }> {
    const table = b === undefined ? null : String(a);
    const id = String(b === undefined ? a : b);
    if (this.isGlobal(table, id)) return { id, table };
    const doc = await this.get(a, b);
    if (!doc) throw new Error("Документ не найден");
    return { id, table };
  }

  private checkValue(value: Record<string, unknown>) {
    if (value.tenantId !== undefined && value.tenantId !== this.tenant) throw new Error("Нельзя перенести документ в другую компанию");
  }

  async patch(a: unknown, b: unknown, c?: unknown): Promise<void> {
    const [ref, value] = c === undefined ? [[a, undefined] as const, b] : [[a, b] as const, c];
    const { id } = await this.own(ref[0], ref[1]);
    this.checkValue(value as Record<string, unknown>);
    await this.loose.patch(id, value as Record<string, unknown>);
  }

  async replace(a: unknown, b: unknown, c?: unknown): Promise<void> {
    const [ref, value] = c === undefined ? [[a, undefined] as const, b] : [[a, b] as const, c];
    const { id, table } = await this.own(ref[0], ref[1]);
    const v = value as Record<string, unknown>;
    this.checkValue(v);
    const global = this.isGlobal(table, id);
    await this.loose.replace(id, global ? v : { ...v, tenantId: this.tenant });
  }

  async delete(a: unknown, b?: unknown): Promise<void> {
    const { id } = await this.own(a, b);
    await this.loose.delete(id);
  }
}

type WithDb = { db: unknown; auth?: Auth };

/** Обёртка базы для вызова функции: компания вошедшего пользователя, если он есть. */
export async function scopedDb(ctx: { db: unknown; auth: Auth }): Promise<TenantDb> {
  const raw = ctx.db as Db;
  let tenant: string | null = null;
  const userId = await getAuthUserId(ctx);
  if (userId) {
    const user = await raw.get(userId);
    if (user) tenant = tenantOfDoc(user);
  }
  return new TenantDb(raw, tenant);
}

const asTenantDb = (ctx: WithDb): TenantDb | null => (ctx.db instanceof TenantDb ? ctx.db : null);

/** База без изоляции: миграция, платформа, вход по логину. В обычных функциях не использовать. */
export function unscopedDb<C extends WithDb>(ctx: C): C["db"] {
  const t = asTenantDb(ctx);
  return (t ? t.raw : ctx.db) as C["db"];
}

/** Компания вызова, если уже известна. */
export function boundTenant(ctx: WithDb): string | null {
  return asTenantDb(ctx)?.tenant ?? null;
}

/** Компания вызова — для записи в документы и ключи; не известна — ошибка. База без обёртки (тесты, Convex Auth) — компания по умолчанию. */
export function tenantOf(ctx: WithDb): string {
  if (!asTenantDb(ctx)) return DEFAULT_TENANT;
  const t = boundTenant(ctx);
  if (!t) throw new Error("Компания не определена");
  return t;
}

/**
 * Задать компанию вызова явно (вебхук, крон, публичная ссылка). Уже задана другая — ошибка:
 * одна функция не работает сразу с двумя компаниями (для обхода компаний — forTenant).
 */
export function bindTenant(ctx: WithDb, tenantId: string): void {
  const t = asTenantDb(ctx);
  if (!t) return;
  if (t.tenant !== null && t.tenant !== tenantId) throw new Error("Функция уже работает с другой компанией");
  t.tenant = tenantId;
}

type Args = Record<string, unknown>;
export type Scheduler = { runAfter: (ms: number, fn: unknown, args?: Args) => Promise<unknown>; runAt: (at: number | Date, fn: unknown, args?: Args) => Promise<unknown>; cancel: (id: unknown) => Promise<void> };

/** Функции Convex Auth (auth.ts) собраны библиотекой без tenantId — им компания не передаётся. */
const ownFunction = (fn: unknown): boolean => {
  try {
    return !getFunctionName(fn as FunctionReference<"query">).startsWith("auth:");
  } catch {
    return false;
  }
};

/** Компания вызывающего — в аргументы вызова, если её там ещё нет. */
export const inject = (fn: unknown, args: Args | undefined, tenant: string | null): Args => {
  const a = args ?? {};
  return tenant && a.tenantId === undefined && ownFunction(fn) ? { ...a, tenantId: tenant } : a;
};

export function wrapScheduler(raw: Scheduler, tenant: () => Promise<string | null> | string | null): Scheduler {
  return {
    runAfter: async (ms, fn, args) => raw.runAfter(ms, fn, inject(fn, args, await tenant())),
    runAt: async (at, fn, args) => raw.runAt(at, fn, inject(fn, args, await tenant())),
    cancel: (id) => raw.cancel(id),
  };
}

/** Тот же ctx, но с базой (и планировщиком) другой компании — для кронов, которые обходят компании по очереди. */
export function forTenant<C extends WithDb>(ctx: C, tenantId: string): C {
  const raw = unscopedDb(ctx) as Db;
  const scheduler = (ctx as { scheduler?: Scheduler }).scheduler;
  return { ...ctx, db: new TenantDb(raw, tenantId) as unknown as C["db"], ...(scheduler ? { scheduler: wrapScheduler(scheduler, () => tenantId) } : {}) };
}

type Runner = (fn: unknown, args?: Args) => Promise<unknown>;
type ActionLike = { runQuery: unknown; runMutation: unknown; runAction: unknown; scheduler: unknown };

/** action от имени компании: её вызовы runQuery/runMutation/runAction и планировщик получают tenantId. */
export function actionFor<C extends ActionLike>(ctx: C, tenantId: string): C {
  const run = (r: unknown): Runner => (fn, a) => (r as Runner)(fn, inject(fn, a, tenantId));
  return {
    ...ctx,
    runQuery: run(ctx.runQuery),
    runMutation: run(ctx.runMutation),
    runAction: run(ctx.runAction),
    scheduler: wrapScheduler(ctx.scheduler as Scheduler, () => tenantId),
  } as C;
}
