// Конструкторы функций Convex с изоляцией компаний: ctx.db — TenantDb (lib/tenantDb.ts).
// Модули импортируют query/mutation/action/… отсюда, а не из _generated/server (это проверяет tenancy.test.ts).
//
// Компания передаётся по цепочке вызовов сама: у каждой функции есть необязательный аргумент tenantId, и всё, что
// функция ставит в планировщик или вызывает из action (runQuery/runMutation/runAction), получает компанию вызывающего.
// Внутренние функции привязываются к нему; публичные его игнорируют — их компания только из вошедшего пользователя.
import type { Auth } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import {
  action as rawAction,
  internalAction as rawInternalAction,
  internalMutation as rawInternalMutation,
  internalQuery as rawInternalQuery,
  mutation as rawMutation,
  query as rawQuery,
} from "../_generated/server";
import schema from "../schema";
import { DEFAULT_TENANT, GLOBAL_TABLES, inject, scopedDb, TenantDb, wrapScheduler, type Scheduler } from "./tenantDb";

export * from "../_generated/server";

type Args = Record<string, unknown>;
type Handler = (ctx: Record<string, unknown> & { db: unknown; auth: Auth }, args: unknown) => unknown;
type Runner = (fn: unknown, args?: Args) => Promise<unknown>;

const SCOPED_TABLES = Object.keys(schema.tables).filter((t) => !GLOBAL_TABLES.has(t));
const tenantArg = v.optional(v.string());

/** Добавить в валидатор аргументов необязательный tenantId (если функция не объявила его сама). */
function withTenantArg(args: unknown): unknown {
  if (args === undefined || args === null) return args;
  const o = args as { kind?: unknown; fields?: Record<string, unknown>; isConvexValidator?: unknown };
  if (o.isConvexValidator) {
    if (o.kind !== "object" || !o.fields || "tenantId" in o.fields) return args;
    return v.object({ ...(o.fields as Record<string, ReturnType<typeof v.any>>), tenantId: tenantArg });
  }
  return "tenantId" in (args as Args) ? args : { ...(args as Args), tenantId: tenantArg };
}

/**
 * Внутренняя функция без вошедшего пользователя (крон, вебхук, планировщик) работает в компании из аргументов:
 * tenantId — явно, иначе компания первого документа, чей id передан (заказ, звонок, диалог…).
 */
async function bindFromArgs(db: TenantDb, args: unknown): Promise<void> {
  if (db.tenant !== null || typeof args !== "object" || args === null) return;
  const a = args as Args;
  if (typeof a.tenantId === "string") {
    db.tenant = a.tenantId;
    return;
  }
  for (const value of Object.values(a)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first !== "string") continue;
    for (const table of SCOPED_TABLES) {
      const id = db.normalizeId(table, first);
      if (!id) continue;
      await db.get(id); // привязывает компанию документа
      if (db.tenant !== null) return;
    }
  }
}

/**
 * Внутренняя функция, которой компанию не передали: пока на платформе одна компания, неоднозначности нет — работаем в ней
 * (так работали все вызовы до SaaS). С двумя и больше — компания должна прийти явно, иначе чтение списка — ошибка.
 */
async function soleTenant(db: TenantDb): Promise<string | null> {
  const rows = (await db.raw.query("tenants").take(2)) as { slug: string }[];
  if (rows.length === 0) return DEFAULT_TENANT;
  return rows.length === 1 ? rows[0].slug : null;
}

/** Конструктор с обработчиком, которому подменён ctx; аргументы получают tenantId. */
function rebuild<B>(builder: B, wrap: (h: Handler) => Handler): B {
  const build = builder as unknown as (def: unknown) => unknown;
  return ((def: unknown) => {
    if (typeof def === "function") return build(wrap(def as Handler));
    const d = def as { handler: Handler; args?: unknown };
    return build({ ...d, args: withTenantArg(d.args), handler: wrap(d.handler) });
  }) as unknown as B;
}

/** query/mutation: база своей компании; у мутации — планировщик, передающий компанию дальше. */
function dbFunction<B>(builder: B, internalFn: boolean): B {
  return rebuild(builder, (handler) => async (ctx, args) => {
    const db = await scopedDb(ctx);
    if (internalFn) {
      await bindFromArgs(db, args);
      if (db.tenant === null) db.tenant = await soleTenant(db);
    }
    const scheduler = ctx.scheduler as Scheduler | undefined;
    return handler({ ...ctx, db, ...(scheduler ? { scheduler: wrapScheduler(scheduler, () => db.tenant) } : {}) }, args);
  });
}

/**
 * action: базы нет — компания из аргумента tenantId (внутренняя функция) или, для публичной, из вошедшего пользователя
 * (его видят и вызовы runQuery/runMutation; для планировщика компанию спрашиваем один раз).
 */
function actionFunction<B>(builder: B, internalFn: boolean): B {
  return rebuild(builder, (handler) => async (ctx, args) => {
    const fromArgs = internalFn && typeof (args as Args | null)?.tenantId === "string" ? ((args as Args).tenantId as string) : null;
    let known: string | null | undefined = fromArgs ?? undefined;
    const runQuery = ctx.runQuery as Runner;
    const tenant = async (): Promise<string | null> => {
      if (known === undefined) known = (await runQuery(internal.tenants._mine, {})) as string | null;
      return known;
    };
    const run = (r: Runner): Runner => (fn, a) => r(fn, inject(fn, a, fromArgs));
    return handler(
      {
        ...ctx,
        runQuery: run(runQuery),
        runMutation: run(ctx.runMutation as Runner),
        runAction: run(ctx.runAction as Runner),
        scheduler: wrapScheduler(ctx.scheduler as Scheduler, tenant),
      },
      args,
    );
  });
}

export const query = dbFunction(rawQuery, false);
export const mutation = dbFunction(rawMutation, false);
export const internalQuery = dbFunction(rawInternalQuery, true);
export const internalMutation = dbFunction(rawInternalMutation, true);
export const action = actionFunction(rawAction, false);
export const internalAction = actionFunction(rawInternalAction, true);
