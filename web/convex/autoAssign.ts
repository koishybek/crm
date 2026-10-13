// Автораспределение заказов (ТЗ п.23 «Автоматическое распределение», «AI-подбор исполнителя»).
// Заказ N минут лежит в ленте и его никто не взял — система назначает лучшего подходящего мастера по тем же
// правилам, что и подбор при ручном назначении: fitsOrder (смена, город, направление, навыки), затем свободные
// раньше занятых, меньше заказов в работе, выше рейтинг (rankExecutors). Не подтвердил за N минут или отказался —
// заказ снова в ленте, на следующем запуске его получает следующий. Предлагать больше некому — один раз сообщаем
// владельцам и руководителям направления: это эскалация заказа в ленте (lib/escalation.ts), и крон эскалаций
// (escalations.ts) тем же людям про тот же эпизод второй раз не пишет. Запускается из escalations.run — до эскалаций.
import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { executorUser, log, notify, nowIso } from "./lib/domain";
import { toExecutor } from "./lib/dto";
import { markLevel, orderLevelRecipients, reachedLevel } from "./lib/escalation";
import { releaseToFeed } from "./lib/feed";
import { notifyAssigned } from "./worker";
import { AUTO_ASSIGN, autoAssignWhy, type AutoAssignSettings } from "../src/data/autoAssign";
import { WORK_STATUSES } from "../src/data/catalog";
import { payout, rankExecutors, type Candidate, type FitOrder, type Load } from "../src/data/logic";
import type { Actor, Executor } from "../src/data/types";
import { shortName } from "../src/lib/format";

const KEY = { enabled: "autoAssign.enabled", minutes: "autoAssign.minutes" } as const;
const SYSTEM: Actor = { type: "system" };
const MINUTE_MS = 60_000;

const settingRow = (ctx: QueryCtx, key: string) =>
  ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();

async function putSetting(ctx: MutationCtx, key: string, value: string): Promise<void> {
  const row = await settingRow(ctx, key);
  if (row) await ctx.db.patch(row._id, { value });
  else await ctx.db.insert("settings", { key, value });
}

const validMinutes = (m: number): boolean => Number.isInteger(m) && m >= AUTO_ASSIGN.min && m <= AUTO_ASSIGN.max;

/** Настройки автораспределения; не заданы — выключено, 30 минут. */
export async function readAutoAssign(ctx: QueryCtx): Promise<AutoAssignSettings> {
  const [enabled, minutes] = await Promise.all([settingRow(ctx, KEY.enabled), settingRow(ctx, KEY.minutes)]);
  const m = Number(minutes?.value);
  return { enabled: enabled?.value === "true", minutes: validMinutes(m) ? m : AUTO_ASSIGN.defaultMinutes };
}

export const settings = query({
  args: {},
  handler: async (ctx): Promise<AutoAssignSettings> => {
    await requireRole(ctx, OWNER);
    return readAutoAssign(ctx);
  },
});

/** Включить или выключить автораспределение и задать время — только владелец. */
export const configure = mutation({
  args: { enabled: v.boolean(), minutes: v.number() },
  handler: async (ctx, { enabled, minutes }): Promise<AutoAssignSettings> => {
    const me = await requireRole(ctx, OWNER);
    if (!validMinutes(minutes)) throw new ConvexError(`Время — целое число минут от ${AUTO_ASSIGN.min} до ${AUTO_ASSIGN.max}`);
    const before = await readAutoAssign(ctx);
    if (before.enabled === enabled && before.minutes === minutes) return before;
    await putSetting(ctx, KEY.enabled, String(enabled));
    await putSetting(ctx, KEY.minutes, String(minutes));
    const summary = enabled ? `Автораспределение заказов включено: ${minutes} мин в ленте, ${minutes} мин на подтверждение` : "Автораспределение заказов выключено";
    await audit(ctx, me, "settings.autoAssign", summary, { meta: { before, after: { enabled, minutes } } });
    return { enabled, minutes };
  },
});

// ── Подбор ───────────────────────────────────────────────────────────────────

interface Pool {
  executors: Executor[];
  docs: Map<string, Doc<"executors">>;
  /** Мастера с действующей учёткой исполнителя: без неё назначение некому подтвердить. */
  reachable: Set<string>;
  /** Кто чем занят — для загрузки и «свободен / на заказе»; дополняется назначениями этого запуска. */
  load: Load[];
}

async function loadPool(ctx: QueryCtx): Promise<Pool> {
  const docs = await ctx.db.query("executors").collect();
  const reachable = new Set<string>();
  for (const e of docs) {
    const u = await executorUser(ctx, e._id);
    if (u && u.role === "executor" && u.active !== false) reachable.add(e._id);
  }
  const load: Load[] = [];
  for (const status of WORK_STATUSES) {
    for (const o of await ctx.db
      .query("orders")
      .withIndex("by_status", (q) => q.eq("status", status))
      .collect()) {
      if (o.executorId) load.push({ executorId: o.executorId, status: o.status });
    }
  }
  return { executors: docs.map(toExecutor), docs: new Map(docs.map((e) => [e._id, e])), reachable, load };
}

/** Лучший кандидат: подходит заказу, на связи и ещё не получал этот заказ от системы. Порядок — rankExecutors. */
export function bestCandidate(o: FitOrder, pool: Pick<Pool, "executors" | "reachable" | "load">, offered: readonly string[]): Candidate | null {
  const skip = new Set(offered);
  const fresh = pool.executors.filter((e) => pool.reachable.has(e.id) && !skip.has(e.id));
  return rankExecutors(o, fresh, pool.load).find((c) => c.fits) ?? null;
}

// ── Шаги ─────────────────────────────────────────────────────────────────────

const ordersIn = (ctx: QueryCtx, status: Doc<"orders">["status"]) =>
  ctx.db
    .query("orders")
    .withIndex("by_status", (q) => q.eq("status", status))
    .collect();

/** Назначила система, и назначение в силе: сотрудник не переназначил (assignedAt тот же), мастер не отказался. */
export const autoPending = (o: Doc<"orders">): boolean => o.status === "assigned" && !!o.autoAssignedAt && o.autoAssignedAt === o.assignedAt;

/** С какого момента заказ в ленте: последняя смена статуса (публикация или отказ мастера). Это и начало эпизода эскалации. */
export async function inFeedSince(ctx: QueryCtx, o: Doc<"orders">): Promise<number> {
  const last = await ctx.db
    .query("history")
    .withIndex("by_order", (q) => q.eq("orderId", o._id))
    .order("desc")
    .filter((q) => q.eq(q.field("kind"), "status"))
    .first();
  return Date.parse(last?.at ?? o.createdAt);
}

/** Назначить кандидата — то же сообщение мастеру с кнопками «Подтвердить / Отказаться», что и при ручном назначении. */
async function offer(ctx: MutationCtx, o: Doc<"orders">, e: Doc<"executors">, pick: Candidate, minutes: number): Promise<void> {
  const at = nowIso();
  const offered = [...(o.autoOffered ?? []), e._id];
  await ctx.db.patch(o._id, { executorId: e._id, assignedAt: at, status: "assigned", autoAssignedAt: at, autoOffered: offered, autoExhaustedAt: undefined });
  const why = autoAssignWhy(pick);
  await log(ctx, o._id, "assigned", `AI-подбор: назначен ${shortName(e.name)} — ${why}. Ждём подтверждения ${minutes} мин`, SYSTEM, { from: o.status, to: "assigned" });
  await audit(ctx, "Система", "order.autoAssigned", `Заказ №${o.number}: AI-подбор назначил ${shortName(e.name)} (${why})`, {
    entityId: o._id,
    meta: { executorId: e._id, attempt: offered.length, state: pick.state, load: pick.load, rating: e.rating, minutes },
  });
  await notifyAssigned(ctx, (await ctx.db.get(o._id))!, { note: `Подтвердите в течение ${minutes} мин — иначе заказ передадим другому мастеру` });
}

/** Мастер не подтвердил вовремя — заказ снова в ленте, остальные подходящие узнают, что он свободен. */
async function returnToFeed(ctx: MutationCtx, o: Doc<"orders">, minutes: number): Promise<void> {
  const e = o.executorId ? await ctx.db.get(o.executorId) : null;
  const who = e ? shortName(e.name) : "Исполнитель";
  await audit(ctx, "Система", "order.autoTimeout", `Заказ №${o.number}: ${who} не подтвердил за ${minutes} мин — заказ вернулся в ленту`, {
    entityId: o._id,
    meta: { executorId: o.executorId, minutes },
  });
  await releaseToFeed(ctx, o, {
    history: `AI-подбор: ${who} не подтвердил заказ за ${minutes} мин — заказ вернулся в ленту`,
    executor: `Заказ №${o.number} снят с вас: не подтвердили за ${minutes} мин`,
  });
}

/**
 * Предлагать больше некому — сообщаем один раз (до следующего предложения). Это эскалация заказа в ленте сразу
 * до второго уровня: руководителям направления и владельцам, кроме тех, кого крон эскалаций в этом эпизоде уже позвал.
 */
async function exhausted(ctx: MutationCtx, o: Doc<"orders">): Promise<void> {
  await ctx.db.patch(o._id, { autoExhaustedAt: nowIso() });
  const tried = o.autoOffered?.length ?? 0;
  const why = tried ? `заказ не принял никто из подходящих мастеров (предлагали: ${tried})` : "подходящих мастеров на смене нет";
  await log(ctx, o._id, "assigned", `AI-подбор: ${why} — нужно назначить исполнителя вручную`, SYSTEM);
  await audit(ctx, "Система", "order.autoExhausted", `Заказ №${o.number}: AI-подбор — ${why}`, { entityId: o._id, meta: { offered: tried } });
  const since = new Date(await inFeedSince(ctx, o)).toISOString();
  const reached = await reachedLevel(ctx, "feed", o._id, since);
  await markLevel(ctx, "feed", o._id, since, 2);
  if (reached >= 2) return;
  const to = await orderLevelRecipients(ctx, o.category, reached + 1, 2);
  await notify(ctx, to.ids, `Заказ №${o.number}: ${why} — назначьте исполнителя вручную`, { link: `/orders/${o._id}`, tone: "warn" });
}

/** Cron раз в 5 минут. Выключено — ничего не делает, в том числе не снимает уже назначенных. */
export const run = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ assigned: number; returned: number; exhausted: number }> => {
    const out = { assigned: 0, returned: 0, exhausted: 0 };
    const cfg = await readAutoAssign(ctx);
    if (!cfg.enabled) return out;
    const now = Date.now();
    const waitMs = cfg.minutes * MINUTE_MS;

    const returned = new Set<string>();
    for (const o of await ordersIn(ctx, "assigned")) {
      if (!autoPending(o) || now - Date.parse(o.autoAssignedAt!) < waitMs) continue;
      await returnToFeed(ctx, o, cfg.minutes);
      returned.add(o._id);
      out.returned++;
    }

    let pool: Pool | null = null;
    for (const o of await ordersIn(ctx, "awaiting_executor")) {
      // Только что вернулся в ленту — следующему кандидату предложим на следующем запуске.
      if (o.executorId || returned.has(o._id) || o.clientPrice <= 0 || payout(o) <= 0) continue;
      // Распределение ещё не начиналось: сначала заказ N минут ждёт в ленте — вдруг его возьмут сами.
      if (!o.autoOffered?.length && now - (await inFeedSince(ctx, o)) < waitMs) continue;
      pool ??= await loadPool(ctx);
      const pick = bestCandidate(o, pool, o.autoOffered ?? []);
      const e = pick ? pool.docs.get(pick.e.id) : undefined;
      if (pick && e) {
        await offer(ctx, o, e, pick, cfg.minutes);
        pool.load.push({ executorId: e._id, status: "assigned" });
        out.assigned++;
      } else if (!o.autoExhaustedAt) {
        await exhausted(ctx, o);
        out.exhausted++;
      }
    }
    return out;
  },
});
