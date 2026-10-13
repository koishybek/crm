// Сроки реакции и эскалации (ТЗ п.15 «эскалация руководителю», п.18 «критические события»; gaps #10, E8).
// Крон раз в 5 минут (run): сначала автораспределение и возвращение мастеров на смену, затем эскалации —
// каждый шаг своей транзакцией, сбой одного не останавливает остальные:
//  • заказ в ленте без исполнителя — руководителю направления, позже — владельцу;
//  • мастер назначен, но не подтвердил — руководителю; без автораспределения заказ возвращается в ленту;
//  • заказ просрочен больше суток — владельцу (первый уровень — уведомление о просрочке, reminders.ts);
//  • заявка из канала без первого действия оператора (рабочее время по Алматы) — операторам;
//  • пропущенный звонок без перезвона (рабочее время) — операторам.
// Каждый уровень — один раз за эпизод (lib/escalation.ts); автор записей журнала — «Система».
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { internalAction, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { almatyStamp, audit, maskPhone } from "./lib/audit";
import { log, notify } from "./lib/domain";
import { activeIds, markLevel, operatorsOrOwners, orderLevelRecipients, reachedLevel } from "./lib/escalation";
import { releaseToFeed } from "./lib/feed";
import { markOk } from "./lib/health";
import { autoPending, inFeedSince, readAutoAssign } from "./autoAssign";
import { loadCatalog } from "./catalog";
import type { AutoAssignSettings } from "../src/data/autoAssign";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import { parseSla, SLA_KEYS, SLA_LABEL, slaProblem, workingMs, type SlaKey, type SlaSettings } from "../src/data/escalations";
import { LEAD_ORIGIN } from "../src/data/leadRules";
import type { Actor } from "../src/data/types";
import { durationLabel } from "../src/data/workerTime";
import { phone as fmtPhone, shortName } from "../src/lib/format";

const KEY = "escalations";
const SYSTEM: Actor = { type: "system" };
const MIN = 60_000;
const DAY = 86400_000;
/**
 * Эпизод эскалируется в течение двух суток после порога. Давние истории (заказ неделю в ленте, заявка месячной
 * давности) — уже известны; после запуска системы они не должны засыпать людей уведомлениями.
 */
const WINDOW_MS = 2 * DAY;
/** Отметки старше — удаляются: эпизоды за окном не эскалируются, повтора не будет. */
const KEEP_MARKS_MS = 30 * DAY;

// ── Настройки ────────────────────────────────────────────────────────────────

const settingRow = (ctx: QueryCtx) =>
  ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", KEY))
    .unique();

/** Пороги эскалаций; не заданы или испорчены — по умолчанию (src/data/escalations.ts). */
export async function readSla(ctx: QueryCtx): Promise<SlaSettings> {
  return parseSla((await settingRow(ctx))?.value);
}

export const settings = query({
  args: {},
  handler: async (ctx): Promise<SlaSettings> => {
    await requireRole(ctx, OWNER);
    return readSla(ctx);
  },
});

const HOUR_KEYS: readonly SlaKey[] = ["dayStart", "dayEnd"];
const valueText = (k: SlaKey, x: number) => (HOUR_KEYS.includes(k) ? `${x}:00` : durationLabel(x * MIN));

/** Пороги меняет только владелец; изменение — в журнале «было → стало». */
export const configure = mutation({
  args: {
    feedMin: v.number(),
    feedOwnerMin: v.number(),
    unconfirmedMin: v.number(),
    overdueOwnerMin: v.number(),
    leadMin: v.number(),
    callbackMin: v.number(),
    dayStart: v.number(),
    dayEnd: v.number(),
  },
  handler: async (ctx, next): Promise<SlaSettings> => {
    const me = await requireRole(ctx, OWNER);
    const problem = slaProblem(next);
    if (problem) throw new ConvexError(problem);
    const before = await readSla(ctx);
    const changed = SLA_KEYS.filter((k) => before[k] !== next[k]);
    if (!changed.length) return before;
    const row = await settingRow(ctx);
    if (row) await ctx.db.patch(row._id, { value: JSON.stringify(next) });
    else await ctx.db.insert("settings", { key: KEY, value: JSON.stringify(next) });
    const parts = changed.map((k) => `${SLA_LABEL[k].toLowerCase()}: ${valueText(k, before[k])} → ${valueText(k, next[k])}`);
    await audit(ctx, me, "settings.escalations", `Сроки реакции: ${parts.join("; ")}`, { meta: { before, after: next } });
    return next;
  },
});

// ── Проходы ──────────────────────────────────────────────────────────────────

interface Pass {
  now: number;
  sla: SlaSettings;
  auto: AutoAssignSettings;
  label: (serviceId: string) => string;
}

const ordersIn = (ctx: QueryCtx, status: Doc<"orders">["status"]) =>
  ctx.db
    .query("orders")
    .withIndex("by_status", (q) => q.eq("status", status))
    .collect();

/** Заказ в ленте без исполнителя: уровень 1 — руководителю направления, 2 — владельцу. */
async function feedPass(ctx: MutationCtx, p: Pass): Promise<number> {
  let n = 0;
  for (const o of await ordersIn(ctx, "awaiting_executor")) {
    if (o.executorId) continue;
    // Автораспределение ведёт заказ по кандидатам — людей позовёт оно само, когда предлагать станет некому.
    if (p.auto.enabled && o.autoOffered?.length && !o.autoExhaustedAt) continue;
    const sinceMs = await inFeedSince(ctx, o);
    const waited = p.now - sinceMs;
    if (waited > p.sla.feedOwnerMin * MIN + WINDOW_MS) continue;
    const due = waited >= p.sla.feedOwnerMin * MIN ? 2 : waited >= p.sla.feedMin * MIN ? 1 : 0;
    if (!due) continue;
    const since = new Date(sinceMs).toISOString();
    const reached = await reachedLevel(ctx, "feed", o._id, since);
    if (due <= reached) continue;
    const to = await orderLevelRecipients(ctx, o.category, reached + 1, due);
    await markLevel(ctx, "feed", o._id, since, due);
    const wait = durationLabel(waited);
    await notify(ctx, to.ids, `Заказ №${o.number} (${p.label(o.serviceId)}): ${wait} в ленте, никто не взял — назначьте исполнителя`, { link: `/orders/${o._id}`, tone: due === 2 ? "bad" : "warn" });
    await log(ctx, o._id, "comment", `Эскалация: ${wait} в ленте без исполнителя — сообщили ${to.who}`, SYSTEM);
    await audit(ctx, "Система", "order.escalated", `Заказ №${o.number}: ${wait} в ленте без исполнителя — сообщили ${to.who}`, {
      entityId: o._id,
      meta: { kind: "feed", level: due, notified: to.ids.length },
    });
    n++;
  }
  return n;
}

/**
 * Назначен, но мастер не подтвердил: руководителю направления. Без автораспределения возвращать заказ в ленту больше
 * некому — это делает эскалация, и подходящие мастера узнают, что заказ снова свободен (E8). Назначение системой при
 * включённом автораспределении не трогаем: оно само вернёт заказ в ленту и предложит следующему.
 */
async function unconfirmedPass(ctx: MutationCtx, p: Pass): Promise<{ escalated: number; returned: number }> {
  const res = { escalated: 0, returned: 0 };
  for (const o of await ordersIn(ctx, "assigned")) {
    if (!o.executorId || !o.assignedAt) continue;
    if (p.auto.enabled && autoPending(o)) continue;
    const waited = p.now - Date.parse(o.assignedAt);
    if (!(waited >= p.sla.unconfirmedMin * MIN) || waited > p.sla.unconfirmedMin * MIN + WINDOW_MS) continue;
    if ((await reachedLevel(ctx, "unconfirmed", o._id, o.assignedAt)) >= 1) continue;
    await markLevel(ctx, "unconfirmed", o._id, o.assignedAt, 1);
    const e = await ctx.db.get(o.executorId);
    const who = e ? shortName(e.name) : "Исполнитель";
    const wait = durationLabel(waited);
    const to = await orderLevelRecipients(ctx, o.category, 1, 1);
    const back = !p.auto.enabled;
    const outcome = back ? "заказ вернулся в ленту" : "свяжитесь с ним или назначьте другого";
    if (back) {
      await releaseToFeed(ctx, o, {
        history: `${who} не подтвердил назначение за ${wait} — заказ вернулся в ленту`,
        executor: `Заказ №${o.number} снят с вас: вы не подтвердили его за ${wait}`,
      });
      res.returned++;
    } else {
      await log(ctx, o._id, "comment", `Эскалация: ${who} не подтвердил назначение за ${wait} — сообщили ${to.who}`, SYSTEM);
    }
    await notify(ctx, to.ids, `Заказ №${o.number}: ${who} не подтвердил назначение за ${wait} — ${outcome}`, { link: `/orders/${o._id}`, tone: "warn" });
    await audit(ctx, "Система", "order.escalated", `Заказ №${o.number}: ${who} не подтвердил назначение за ${wait} — ${outcome}; сообщили ${to.who}`, {
      entityId: o._id,
      meta: { kind: "unconfirmed", level: 1, executorId: o.executorId, returned: back, notified: to.ids.length },
    });
    res.escalated++;
  }
  return res;
}

/** Просрочка дольше порога — второй уровень, владельцу (первый — уведомление о просрочке в момент срока). */
async function overduePass(ctx: MutationCtx, p: Pass): Promise<number> {
  const cutoff = p.now - p.sla.overdueOwnerMin * MIN;
  const from = new Date(cutoff - WINDOW_MS).toISOString();
  const until = new Date(cutoff).toISOString();
  let owners: Awaited<ReturnType<typeof activeIds>> | null = null;
  let n = 0;
  for (const status of ACTIVE_STATUSES) {
    const late = await ctx.db
      .query("orders")
      .withIndex("by_status", (q) => q.eq("status", status).gte("deadline", from).lt("deadline", until))
      .collect();
    for (const o of late) {
      if ((await reachedLevel(ctx, "overdue", o._id, o.deadline)) >= 2) continue;
      await markLevel(ctx, "overdue", o._id, o.deadline, 2);
      owners ??= await activeIds(ctx, "owner");
      const lateBy = durationLabel(p.now - Date.parse(o.deadline));
      await notify(ctx, owners, `Заказ №${o.number} (${p.label(o.serviceId)}) просрочен на ${lateBy}: срок был ${almatyStamp(o.deadline)}`, { link: `/orders/${o._id}`, tone: "bad" });
      await log(ctx, o._id, "comment", `Эскалация: просрочка ${lateBy} — сообщили владельцу`, SYSTEM);
      await audit(ctx, "Система", "order.escalated", `Заказ №${o.number}: просрочен на ${lateBy} (срок ${almatyStamp(o.deadline)}) — сообщили владельцу`, {
        entityId: o._id,
        meta: { kind: "overdue", level: 2, deadline: o.deadline, status: o.status, notified: owners.length },
      });
      n++;
    }
  }
  return n;
}

/**
 * Заявка из канала (бот, сайт, API, WhatsApp, OLX, AI) без первого действия оператора — операторам. Время считается
 * рабочее: заявка, пришедшая ночью, ждёт с начала рабочего дня. Заявки, заведённые до учёта первого действия, не трогаем.
 */
async function leadPass(ctx: MutationCtx, p: Pass): Promise<number> {
  const from = new Date(p.now - WINDOW_MS).toISOString();
  const fresh = await ctx.db
    .query("leads")
    .withIndex("by_status", (q) => q.eq("status", "new").gte("createdAt", from))
    .collect();
  let to: Awaited<ReturnType<typeof operatorsOrOwners>> | null = null;
  let n = 0;
  for (const l of fresh) {
    if (!l.origin || l.firstActionAt) continue;
    const waited = workingMs(Date.parse(l.createdAt), p.now, p.sla.dayStart, p.sla.dayEnd);
    if (waited < p.sla.leadMin * MIN) continue;
    if ((await reachedLevel(ctx, "lead", l._id, l.createdAt)) >= 1) continue;
    await markLevel(ctx, "lead", l._id, l.createdAt, 1);
    to ??= await operatorsOrOwners(ctx);
    const wait = durationLabel(waited);
    await notify(ctx, to.ids, `Заявка №${l.number} (${LEAD_ORIGIN[l.origin].label}, ${p.label(l.serviceId)}): ${wait} без ответа — возьмите в работу`, { link: `/leads?open=${l._id}`, tone: "warn" });
    await audit(ctx, "Система", "lead.escalated", `Заявка №${l.number}: ${wait} без ответа оператора — сообщили ${to.who}`, {
      entityId: l._id,
      meta: { kind: "lead", level: 1, origin: l.origin, notified: to.ids.length },
    });
    n++;
  }
  return n;
}

/** Перезвонили после пропущенного: исходящий на этот номер или принятый входящий с него позже. */
async function calledBack(ctx: QueryCtx, phone: string, after: string): Promise<boolean> {
  const out = await ctx.db
    .query("calls")
    .withIndex("by_to", (q) => q.eq("to", phone))
    .collect();
  if (out.some((x) => x.direction === "out" && x.startedAt > after)) return true;
  const inbound = await ctx.db
    .query("calls")
    .withIndex("by_from", (q) => q.eq("from", phone))
    .collect();
  return inbound.some((x) => x.direction === "in" && x.startedAt > after && (x.status === "answered" || x.status === "completed"));
}

/** Пропущенный входящий без перезвона — операторам; по номеру — только последний пропущенный, рабочее время. */
async function callbackPass(ctx: MutationCtx, p: Pass): Promise<number> {
  const from = new Date(p.now - WINDOW_MS).toISOString();
  const missed = await ctx.db
    .query("calls")
    .withIndex("by_status", (q) => q.eq("status", "missed").gte("startedAt", from))
    .order("desc")
    .collect();
  const seen = new Set<string>();
  let to: Awaited<ReturnType<typeof operatorsOrOwners>> | null = null;
  let n = 0;
  for (const c of missed) {
    if (c.direction !== "in" || !c.from || seen.has(c.from)) continue;
    seen.add(c.from);
    const waited = workingMs(Date.parse(c.startedAt), p.now, p.sla.dayStart, p.sla.dayEnd);
    if (waited < p.sla.callbackMin * MIN) continue;
    if ((await reachedLevel(ctx, "callback", c._id, c.startedAt)) >= 1) continue;
    if (await calledBack(ctx, c.from, c.startedAt)) continue;
    await markLevel(ctx, "callback", c._id, c.startedAt, 1);
    to ??= await operatorsOrOwners(ctx);
    const wait = durationLabel(waited);
    await notify(ctx, to.ids, `Пропущенный звонок: ${c.clientName ?? fmtPhone(c.from)} — ${wait} без перезвона. Перезвоните`, { link: `/calls?open=${c._id}`, tone: "warn" });
    // В журнал — номер только последними цифрами: журнал не должен становиться копией базы клиентов.
    await audit(ctx, "Система", "call.escalated", `Пропущенный звонок с номера ${maskPhone(c.from)}: ${wait} без перезвона — сообщили ${to.who}`, {
      entityId: c._id,
      meta: { kind: "callback", level: 1, notified: to.ids.length },
    });
    n++;
  }
  return n;
}

export interface PassResult {
  feed: number;
  unconfirmed: number;
  returned: number;
  overdue: number;
  leads: number;
  callbacks: number;
}

/** Все эскалации за один проход. Тесты зовут его напрямую; крон — через run. */
export const _pass = internalMutation({
  args: {},
  handler: async (ctx): Promise<PassResult> => {
    const now = Date.now();
    const p: Pass = { now, sla: await readSla(ctx), auto: await readAutoAssign(ctx), label: (await loadCatalog(ctx)).label };
    const feed = await feedPass(ctx, p);
    const unconfirmed = await unconfirmedPass(ctx, p);
    const overdue = await overduePass(ctx, p);
    const leads = await leadPass(ctx, p);
    const callbacks = await callbackPass(ctx, p);
    const old = await ctx.db
      .query("escalations")
      .withIndex("by_at", (q) => q.lt("at", new Date(now - KEEP_MARKS_MS).toISOString()))
      .take(200);
    for (const m of old) await ctx.db.delete(m._id);
    const res: PassResult = { feed, unconfirmed: unconfirmed.escalated, returned: unconfirmed.returned, overdue, leads, callbacks };
    const total = feed + unconfirmed.escalated + overdue + leads + callbacks;
    await markOk(ctx, "escalations", total ? `Эскалаций за проход: ${total}` : "Проверено, эскалаций нет");
    return res;
  },
});

const errorText = (e: unknown): string => (e instanceof ConvexError ? String(e.data) : "внутренняя ошибка");

/**
 * Крон раз в 5 минут. Автораспределение — первым: заказ, который оно сейчас предложит мастеру, эскалировать уже не
 * нужно, а «предлагать некому» оно отметит как эскалацию само. Шаги — разными транзакциями: сбой одного не мешает другим.
 */
export const run = internalAction({
  args: {},
  handler: async (ctx): Promise<{ failed: string[] }> => {
    const failed: string[] = [];
    const steps = [
      ["Автораспределение", () => ctx.runMutation(internal.autoAssign.run, {})],
      ["Возвращение мастеров на смену", () => ctx.runMutation(internal.executors._restoreShifts, {})],
      ["Эскалации", () => ctx.runMutation(internal.escalations._pass, {})],
    ] as const;
    for (const [name, step] of steps) {
      try {
        await step();
      } catch (e) {
        console.error(`escalations.run: шаг «${name}» не выполнен: ${e instanceof Error ? e.name : "ошибка"}`);
        failed.push(name);
        await ctx.runMutation(internal.health._mark, { key: "escalations", ok: false, note: `${name}: ${errorText(e)}` });
      }
    }
    return { failed };
  },
});
