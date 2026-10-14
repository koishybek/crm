// Предрасчёт показателей «Аналитики» и «Главной» (ТЗ §26.6 «масштаб», §17, §23.4); правила — src/data/dailyStats.ts.
// Любая правка заказа (lib/domain.log) и заявки ставит её в очередь statsDirty. Раз в минуту (crons.ts) очередь
// разбирается: факты сущности по дням (statsFacts) → итоги дня → итоги месяца (dailyStats). Экраны читают готовые итоги
// за период — O(дней × разрезов), а не O(заказов). Полный пересчёт — сам при первом запуске и по кнопке владельца.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { autoLeadIds, spendRows } from "./analytics";
import { loadCatalog } from "./catalog";
import { can, OWNER, requirePerm, requireRole, scopeOf, TEAM } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { queueStats, recountLoad, syncLoad } from "./lib/stats";
import { readRange, rowsOf, totalsOf, type PeriodRow } from "./lib/statsRead";
import { source } from "./schema";
import { monthOf, spendWithin } from "../src/data/analytics";
import {
  DAY_RE,
  MAX_PERIOD_DAYS,
  dayEnd,
  dayStart,
  daysBetween,
  dimsKey,
  leadFacts,
  matchesFilter,
  mergeCells,
  monthBounds,
  monthOfDay,
  orderFacts,
  sameCell,
  shiftDay,
  shiftMonth,
  summarize,
  summaryWithoutMoney,
  todayDay,
  withoutMoney,
  type Cell,
  type Counts,
  type ExecutorMeta,
  type MonthPoint,
  type OrderContext,
  type OrderEvent,
  type SeriesPoint,
  type StatsFilter,
  type StatsFreshness,
  type StatsReport,
  type TotalKey,
} from "../src/data/dailyStats";
import { perTenant } from "./lib/tenant";

// ── Факты сущностей ──────────────────────────────────────────────────────────

type Catalog = Awaited<ReturnType<typeof loadCatalog>>;
/** Справочник читаем один раз за пачку и только если он понадобился. */
const lazyCatalog = (ctx: QueryCtx) => {
  let c: Catalog | null = null;
  return async () => (c ??= await loadCatalog(ctx));
};
type CatalogOf = ReturnType<typeof lazyCatalog>;

/** Ячейка в виде для базы: без пустых счётчиков. */
const counts = (c: Partial<Record<string, number>>): Record<string, number> => Object.fromEntries(Object.entries(c).filter((e): e is [string, number] => !!e[1]));
const stored = (c: Cell) => ({
  category: c.category,
  source: c.source,
  city: c.city,
  t: counts(c.t),
  ex: c.ex.map((e) => ({ id: e.id, c: counts(e.c) })),
  op: c.op.map((o) => ({ id: o.id, c: counts(o.c), waits: o.waits })),
});

/** История статусов заказа (кто из мастеров отказался) и был ли у клиента заказ раньше. */
async function orderContext(ctx: QueryCtx, o: Doc<"orders">): Promise<OrderContext> {
  const history = await ctx.db
    .query("history")
    .withIndex("by_order", (q) => q.eq("orderId", o._id))
    .collect();
  const executorOfUser = new Map<string, string | undefined>();
  const events: OrderEvent[] = [];
  for (const h of history) {
    if (!h.to) continue;
    let byExecutor: string | undefined;
    // Отказ — шаг обратно в ленту, который сделал сам мастер (worker.actFor «decline»).
    if (h.to === "awaiting_executor" && h.actor.type === "user") {
      if (!executorOfUser.has(h.actor.id)) {
        const id = ctx.db.normalizeId("users", h.actor.id);
        const u = id ? await ctx.db.get(id) : null;
        executorOfUser.set(h.actor.id, u?.role === "executor" ? u.executorId : undefined);
      }
      byExecutor = executorOfUser.get(h.actor.id);
    }
    events.push({ at: h.at, from: h.from, to: h.to, ...(byExecutor ? { byExecutor } : {}) });
  }
  const earlier = await ctx.db
    .query("orders")
    .withIndex("by_client", (q) => q.eq("clientId", o.clientId).lt("createdAt", o.createdAt))
    .first();
  return { events, repeat: !!earlier };
}

/** Заменить факты сущности; изменившиеся дни — в очередь на пересчёт итогов. */
async function writeFacts(ctx: MutationCtx, entity: Doc<"statsFacts">["entity"], ref: string, facts: Map<string, Cell>): Promise<void> {
  const old = await ctx.db
    .query("statsFacts")
    .withIndex("by_entity", (q) => q.eq("entity", entity).eq("ref", ref))
    .collect();
  const touched = new Set<string>();
  for (const doc of old) {
    const next = facts.get(doc.day);
    if (!next) {
      await ctx.db.delete(doc._id);
      touched.add(doc.day);
    } else if (!sameCell(doc, next)) {
      await ctx.db.patch(doc._id, stored(next));
      touched.add(doc.day);
    }
  }
  const had = new Set(old.map((d) => d.day));
  for (const [day, cell] of facts) {
    if (had.has(day)) continue;
    await ctx.db.insert("statsFacts", { entity, ref, day, ...stored(cell) });
    touched.add(day);
  }
  for (const day of touched) await queueStats(ctx, "day", day);
}

async function refreshLeadDoc(ctx: MutationCtx, l: Doc<"leads">, catalog: CatalogOf, auto: boolean): Promise<void> {
  const order = l.orderId ? await ctx.db.get(l.orderId) : null;
  const category = (await catalog()).services.find((s) => s.id === l.serviceId)?.category ?? "";
  await writeFacts(ctx, "lead", l._id, leadFacts(l, { category, order, auto }));
}

async function refreshLead(ctx: MutationCtx, ref: string, catalog: CatalogOf): Promise<void> {
  const id = ctx.db.normalizeId("leads", ref);
  const l = id ? await ctx.db.get(id) : null;
  if (!l) return writeFacts(ctx, "lead", ref, new Map());
  await refreshLeadDoc(ctx, l, catalog, (await autoLeadIds(ctx, [l])).length > 0);
}

/** Факты заказа — и его заявки: воронка и операторы зависят от того, что стало с заказом. */
async function refreshOrder(ctx: MutationCtx, ref: string, catalog: CatalogOf): Promise<void> {
  const id = ctx.db.normalizeId("orders", ref);
  const o = id ? await ctx.db.get(id) : null;
  if (!o) return writeFacts(ctx, "order", ref, new Map());
  await writeFacts(ctx, "order", ref, orderFacts(o, await orderContext(ctx, o)));
  if (o.leadId) await refreshLead(ctx, o.leadId, catalog);
}

// ── Итоги дня и месяца ───────────────────────────────────────────────────────

/** Итоги периода (день или месяц) заменить на новые: неизменившиеся строки не трогаем. */
async function replaceRows(ctx: MutationCtx, grain: Doc<"dailyStats">["grain"], period: string, cells: readonly Cell[]): Promise<void> {
  const old = new Map((await rowsOf(ctx, grain, period, period)).map((r) => [dimsKey(r), r]));
  for (const c of cells) {
    const k = dimsKey(c);
    const cur = old.get(k);
    old.delete(k);
    if (!cur) await ctx.db.insert("dailyStats", { grain, period, ...stored(c) });
    else if (!sameCell(cur, c)) await ctx.db.patch(cur._id, stored(c));
  }
  for (const r of old.values()) await ctx.db.delete(r._id);
}

async function rebuildDay(ctx: MutationCtx, day: string): Promise<void> {
  const facts = await ctx.db
    .query("statsFacts")
    .withIndex("by_day", (q) => q.eq("day", day))
    .collect();
  await replaceRows(ctx, "day", day, mergeCells(facts));
  await queueStats(ctx, "month", monthOfDay(day));
}

async function rebuildMonth(ctx: MutationCtx, month: string): Promise<void> {
  const { first, last } = monthBounds(month);
  await replaceRows(ctx, "month", month, mergeCells(await rowsOf(ctx, "day", first, last)));
}

/** Сколько за один проход: заказов и заявок, дней, месяцев — чтобы мутация уложилась в лимиты Convex. */
const BATCH = { order: 40, lead: 40, day: 8, month: 2 } as const;

/** Один проход по очереди: сущности → их дни → месяцы. true — в очереди ещё что-то осталось. */
async function flushBatch(ctx: MutationCtx): Promise<boolean> {
  const catalog = lazyCatalog(ctx);
  let more = false;
  for (const kind of ["order", "lead", "day", "month"] as const) {
    const items = await ctx.db
      .query("statsDirty")
      .withIndex("by_ref", (q) => q.eq("kind", kind))
      .take(BATCH[kind]);
    if (items.length === BATCH[kind]) more = true;
    for (const it of items) {
      await ctx.db.delete(it._id);
      // Одна испорченная запись не должна навсегда остановить очередь: её пропускаем (поправит полный пересчёт).
      try {
        if (kind === "order") await refreshOrder(ctx, it.ref, catalog);
        else if (kind === "lead") await refreshLead(ctx, it.ref, catalog);
        else if (kind === "day") await rebuildDay(ctx, it.ref);
        else await rebuildMonth(ctx, it.ref);
      } catch (e) {
        console.error(`stats: не удалось пересчитать ${kind} ${it.ref}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return more;
}

// ── Очередь и полный пересчёт ────────────────────────────────────────────────

const stateOf = (ctx: QueryCtx) => ctx.db.query("statsState").first();
/** Шаг пересчёта не приходил дольше — цепочка оборвалась (ошибка, перезапуск), крон начинает заново. */
const STALE_REBUILD_MS = 10 * 60_000;

async function startRebuild(ctx: MutationCtx, by?: Id<"users">): Promise<void> {
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const rebuild = { run, phase: "wipe" as const, cursor: null, at: nowIso(), ...(by ? { by } : {}) };
  const s = await stateOf(ctx);
  if (s) await ctx.db.patch(s._id, { rebuild });
  else await ctx.db.insert("statsState", { rebuild });
  await ctx.scheduler.runAfter(0, internal.stats.rebuildStep, { run });
}

type Rebuild = NonNullable<Doc<"statsState">["rebuild"]>;
type Step = Pick<Rebuild, "phase" | "cursor"> | "done";

const WIPE = 400;
const LEADS_PAGE = 100;
const ORDERS_PAGE = 50;
const STALE_PAGE = 500;

/**
 * Один шаг полного пересчёта: очистка фактов → факты всех заявок → факты всех заказов (и загрузка мастеров) → в очередь
 * все дни и месяцы, где уже есть итоги (пропавшие факты их обнулят) → итоги дней и месяцев. Сами итоги до последнего
 * этапа не трогаем: экраны всё это время показывают прежние цифры, а не пустоту.
 */
async function rebuildPart(ctx: MutationCtx, r: Rebuild): Promise<Step> {
  if (r.phase === "wipe") {
    for (const table of ["statsFacts", "statsDirty"] as const) {
      const rows = await ctx.db.query(table).take(WIPE);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) return { phase: "wipe", cursor: null };
    }
    return { phase: "leads", cursor: null };
  }
  if (r.phase === "leads") {
    const page = await ctx.db.query("leads").paginate({ cursor: r.cursor, numItems: LEADS_PAGE });
    const auto = new Set(await autoLeadIds(ctx, page.page));
    const catalog = lazyCatalog(ctx);
    for (const l of page.page) await refreshLeadDoc(ctx, l, catalog, auto.has(l._id));
    return page.isDone ? { phase: "orders", cursor: null } : { phase: "leads", cursor: page.continueCursor };
  }
  if (r.phase === "orders") {
    const page = await ctx.db.query("orders").paginate({ cursor: r.cursor, numItems: ORDERS_PAGE });
    for (const o of page.page) {
      await writeFacts(ctx, "order", o._id, orderFacts(o, await orderContext(ctx, o)));
      await syncLoad(ctx, o);
    }
    if (!page.isDone) return { phase: "orders", cursor: page.continueCursor };
    for (const e of await ctx.db.query("executors").collect()) await recountLoad(ctx, e._id);
    return { phase: "stale", cursor: null };
  }
  if (r.phase === "stale") {
    const page = await ctx.db.query("dailyStats").paginate({ cursor: r.cursor, numItems: STALE_PAGE });
    for (const p of new Set(page.page.map((row) => `${row.grain}|${row.period}`))) {
      const [grain, period] = p.split("|") as [Doc<"dailyStats">["grain"], string];
      await queueStats(ctx, grain, period);
    }
    return page.isDone ? { phase: "days", cursor: null } : { phase: "stale", cursor: page.continueCursor };
  }
  return (await flushBatch(ctx)) ? { phase: "days", cursor: null } : "done";
}

export const rebuildStep = internalMutation({
  args: { run: v.string() },
  handler: async (ctx, { run }): Promise<void> => {
    const s = await stateOf(ctx);
    const r = s?.rebuild;
    // Пересчёт перезапустили или он уже закончился — старая цепочка молча останавливается.
    if (!s || !r || r.run !== run) return;
    const next = await rebuildPart(ctx, r);
    if (next === "done") {
      await ctx.db.patch(s._id, { builtAt: nowIso(), rebuild: undefined });
      return;
    }
    await ctx.db.patch(s._id, { rebuild: { ...r, ...next, at: nowIso() } });
    await ctx.scheduler.runAfter(0, internal.stats.rebuildStep, { run });
  },
});

/** Разобрать очередь (пачками, пока не опустеет). Во время полного пересчёта очередь разбирает он сам. */
export const flush = internalMutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    if ((await stateOf(ctx))?.rebuild) return;
    if (await flushBatch(ctx)) await ctx.scheduler.runAfter(0, internal.stats.flush, {});
  },
});

/** Крон раз в минуту: первый запуск — полный пересчёт; оборвавшийся пересчёт — заново; иначе — очередь. */
export const tick = internalMutation({
  args: {},
  handler: async (cronCtx): Promise<void> => perTenant(cronCtx, internal.stats.tick, undefined, async (ctx) => {
    const s = await stateOf(ctx);
    if (s?.rebuild) {
      if (Date.now() - Date.parse(s.rebuild.at) > STALE_REBUILD_MS) await startRebuild(ctx, s.rebuild.by);
      return;
    }
    if (!s?.builtAt) return startRebuild(ctx);
    if (await flushBatch(ctx)) await ctx.scheduler.runAfter(0, internal.stats.flush, {});
  }),
});

/** Ночная сверка счётчиков заказов в работе у мастеров — на случай правки заказа мимо log() (загрузка демо-данных и т.п.). */
export const reconcileLoads = internalMutation({
  args: {},
  handler: async (cronCtx): Promise<void> => perTenant(cronCtx, internal.stats.reconcileLoads, undefined, async (ctx) => {
    for (const e of await ctx.db.query("executors").collect()) await recountLoad(ctx, e._id);
  }),
});

/** Владелец: пересчитать все показатели заново (после восстановления копии, переноса услуг между направлениями). */
export const rebuild = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const s = await stateOf(ctx);
    if (s?.rebuild && Date.now() - Date.parse(s.rebuild.at) < STALE_REBUILD_MS) throw new ConvexError("Пересчёт уже идёт — показатели обновятся через несколько минут");
    await startRebuild(ctx, me._id);
    await audit(ctx, me, "system.statsRebuild", "Запущен полный пересчёт показателей аналитики");
  },
});

/** Свежесть показателей — для строки «Обновлено…» и кнопки пересчёта у владельца. */
export const state = query({
  args: {},
  handler: async (ctx): Promise<StatsFreshness> => {
    await requireRole(ctx, OWNER);
    const s = await stateOf(ctx);
    const pending = (await ctx.db.query("statsDirty").take(1000)).length;
    return { builtAt: s?.builtAt ?? null, rebuilding: !!s?.rebuild, pending };
  },
});

// ── Чтение итогов ────────────────────────────────────────────────────────────

const filterArgs = { category: v.optional(v.string()), source: v.optional(source), city: v.optional(v.string()) };
type FilterArgs = { category?: string; source?: Doc<"orders">["source"]; city?: string };

/** Период: дни YYYY-MM-DD по Алматы, обе границы включительно, не длиннее года. */
function periodOf(from: string, to: string): { from: string; to: string; days: number } {
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || shiftDay(from, 0) !== from || shiftDay(to, 0) !== to) throw new ConvexError("Неверная дата");
  if (from > to) throw new ConvexError("Начало периода позже его конца");
  const days = daysBetween(from, to);
  if (days > MAX_PERIOD_DAYS) throw new ConvexError(`Период — не длиннее ${MAX_PERIOD_DAYS} дней`);
  return { from, to, days };
}

const cleanFilter = (a: FilterArgs) => ({
  category: a.category?.trim().slice(0, 60) || undefined,
  source: a.source,
  city: a.city?.trim().slice(0, 60) || undefined,
});

/**
 * Кто что видит (ТЗ п.5.12): суммы компании — с правом «Выплаты мастерам и маржа» (руководителю — никогда, как в
 * canSeeCompanyMoney), руководитель — только свои направления. «Аналитика» дополнительно требует права analytics.view.
 */
async function viewer(ctx: QueryCtx, a: FilterArgs, analytics = false): Promise<{ money: boolean; filter: StatsFilter; scope: string[] | null }> {
  const me = analytics ? await requirePerm(ctx, "analytics.view") : await requireRole(ctx, TEAM);
  const scope = scopeOf(me);
  return { money: can(me, "money.payouts") && me.role !== "manager", scope, filter: { ...cleanFilter(a), scope } };
}

/** Ряд «Динамики» без пропусков: каждый день (или месяц) периода, пустые — нулями. */
function seriesOf(grain: "day" | "month", rows: readonly PeriodRow[], from: string, to: string, money: boolean): SeriesPoint[] {
  const by = new Map<string, Cell[]>();
  for (const r of rows) by.set(r.period, [...(by.get(r.period) ?? []), r.cell]);
  const periods: string[] = [];
  if (grain === "day") for (let d = from; d <= to; d = shiftDay(d, 1)) periods.push(d);
  else for (let m = monthOfDay(from); m <= monthOfDay(to); m = shiftMonth(m, 1)) periods.push(m);
  return periods.map((period) => {
    const t = summarize(by.get(period) ?? []).t;
    return { period, t: money ? t : withoutMoney(t) };
  });
}

/**
 * Мастера области: руководителю — его направлений, с фильтром по направлению — этого направления; плюс те, у кого
 * за период есть цифры в этой области (назначили мимо подбора — он всё равно в таблице под своим именем).
 */
async function executorsOf(ctx: QueryCtx, scope: string[] | null, category: string | undefined, withStats: ReadonlySet<string>): Promise<ExecutorMeta[]> {
  return (await ctx.db.query("executors").collect())
    .filter((e) => withStats.has(e._id) || ((!scope || e.categories.some((c) => scope.includes(c))) && (!category || e.categories.includes(category))))
    .map((e) => ({ id: e._id, name: e.name, rating: e.rating, reviews: e.reviews }));
}

/**
 * «Аналитика» за период (свой период или пресет) с фильтрами по городу, направлению и источнику: итог, разбивки,
 * мастера и операторы, прошлый период той же длины, ряд по дням или месяцам. Руководителю — только его направления
 * и без денег; оператору — без денег.
 */
export const report = query({
  args: { from: v.string(), to: v.string(), ...filterArgs },
  handler: async (ctx, a): Promise<StatsReport> => {
    const { money, filter, scope } = await viewer(ctx, a, true);
    const p = periodOf(a.from, a.to);
    const prevFrom = shiftDay(p.from, -p.days);
    const prevTo = shiftDay(p.from, -1);
    const cur = await readRange(ctx, p.from, p.to, filter);
    const prev = await totalsOf(ctx, prevFrom, prevTo, filter);
    const summary = summarize(
      cur.rows.map((r) => r.cell),
      { operators: money },
    );
    // Расходы на рекламу делятся только по источникам: с фильтром по направлению или городу их не к чему отнести.
    let spend: StatsReport["spend"] = {};
    if (money && !filter.category && !filter.city) {
      const all = spendWithin(await spendRows(ctx, monthOf(dayStart(p.from)), monthOf(dayStart(p.to))), { from: dayStart(p.from), to: dayEnd(p.to) });
      spend = filter.source ? { [filter.source]: all[filter.source] ?? 0 } : all;
    }
    return {
      money,
      ...p,
      prevFrom,
      prevTo,
      grain: cur.grain,
      cur: money ? summary : summaryWithoutMoney(summary),
      prev: money ? prev : withoutMoney(prev),
      series: seriesOf(cur.grain, cur.rows, p.from, p.to, money),
      executors: await executorsOf(ctx, scope, filter.category, new Set(summary.executors.map((e) => e.id))),
      spend,
    };
  },
});

/** Итоги за период одной строкой — воронка «Главной» за свой период. */
export const totals = query({
  args: { from: v.string(), to: v.string(), ...filterArgs },
  handler: async (ctx, a): Promise<Counts<TotalKey>> => {
    const { money, filter } = await viewer(ctx, a);
    const p = periodOf(a.from, a.to);
    const t = await totalsOf(ctx, p.from, p.to, filter);
    return money ? t : withoutMoney(t);
  },
});

/** Сравнение по месяцам: последние 12 месяцев, текущий — по сегодняшний день. */
export const months = query({
  args: filterArgs,
  handler: async (ctx, a): Promise<MonthPoint[]> => {
    const { money, filter } = await viewer(ctx, a, true);
    const last = monthOfDay(todayDay());
    const first = shiftMonth(last, -11);
    const rows = (await rowsOf(ctx, "month", first, last)).filter((r) => matchesFilter(r, filter));
    const out: MonthPoint[] = [];
    for (let m = first; m <= last; m = shiftMonth(m, 1)) {
      const t = summarize(rows.filter((r) => r.period === m)).t;
      out.push({ month: m, t: money ? t : withoutMoney(t) });
    }
    return out;
  },
});
