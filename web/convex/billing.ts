// Подписка компаний (ТЗ §24): оплату тарифа платформа принимает сама (Kaspi, перевод, наличные) и вносит здесь —
// «оплачено до» продлевается, оплату можно отменить в течение суток. Раз в день: напоминания владельцу и
// администраторам платформы за 7 и за 1 день до конца, после льготных дней — приостановка (данные остаются; оплата
// возобновляет работу сама). Правила сроков — src/data/billing.ts.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { currentUser, signedInUser } from "./lib/access";
import { audit } from "./lib/audit";
import { notify, nowIso } from "./lib/domain";
import { cleanText } from "./lib/limits";
import { platformAdminLogins, tenantRow, tenantView, type TenantRow } from "./lib/tenant";
import { forTenant, tenantOfDoc, unscopedDb } from "./lib/tenantDb";
import { platformRow, requirePlatform } from "./platform";
import { payMethod } from "./schema";
import { PLAN_INFO } from "../src/data/plans";
import { money } from "../src/lib/format";
import {
  dayText,
  daysText,
  DEFAULT_PLATFORM_SETTINGS,
  MAX_AMOUNT,
  MAX_MONTHS,
  MAX_NOTE,
  PAY_METHOD_LABEL,
  paymentPeriod,
  periodProblem,
  reminderDue,
  settingsProblem,
  subscriptionStatus,
  suspendDue,
  todayAlmaty,
  UNDO_WINDOW_MS,
  type BlockedInfo,
  type MySubscription,
  type PlatformSettings,
  type SubscriptionPaymentRow,
} from "../src/data/billing";

/** Сколько оплат показываем у компании и сколько выгружаем в CSV за раз. */
const HISTORY = 100;
const EXPORT_MAX = 5000;

// ── Настройки платформы ──────────────────────────────────────────────────────

async function readSettings(ctx: QueryCtx): Promise<PlatformSettings> {
  const row = await ctx.db.query("platformSettings").first();
  return row ? { graceDays: row.graceDays, howToPay: row.howToPay, prices: row.prices } : DEFAULT_PLATFORM_SETTINGS;
}

export const settings = query({
  args: {},
  handler: async (ctx): Promise<PlatformSettings> => {
    await requirePlatform(ctx);
    return readSettings(ctx);
  },
});

export const saveSettings = mutation({
  args: { graceDays: v.number(), howToPay: v.string(), prices: v.object({ free: v.number(), standard: v.number(), pro: v.number() }) },
  handler: async (ctx, a): Promise<void> => {
    const me = await requirePlatform(ctx);
    const next: PlatformSettings = { graceDays: a.graceDays, howToPay: a.howToPay.trim(), prices: { free: Math.round(a.prices.free), standard: Math.round(a.prices.standard), pro: Math.round(a.prices.pro) } };
    const problem = settingsProblem(next);
    if (problem) throw new ConvexError(problem);
    const row = await ctx.db.query("platformSettings").first();
    const doc = { ...next, updatedAt: nowIso(), updatedBy: me._id };
    if (row) await ctx.db.patch(row._id, doc);
    else await ctx.db.insert("platformSettings", doc);
    // Запись — в журнале компании администратора: настройки платформы не принадлежат ни одной компании клиента.
    await audit(ctx, me, "settings.platform", `Настройки платформы: льготных дней — ${next.graceDays}, цены тарифов в месяц — ${(["free", "standard", "pro"] as const).map((p) => `${PLAN_INFO[p].label} ${next.prices[p] ? money(next.prices[p]) : "не задана"}`).join(", ")}`, {
      meta: { graceDays: next.graceDays, prices: next.prices, howToPayChanged: next.howToPay !== (row?.howToPay ?? "") },
    });
  },
});

// ── Оплаты ───────────────────────────────────────────────────────────────────

/** Последняя действующая оплата компании (ctx — база этой компании). Её и только её можно отменить. */
async function lastActive(ctx: QueryCtx): Promise<Doc<"subscriptionPayments"> | null> {
  const recent = await ctx.db.query("subscriptionPayments").withIndex("by_paid").order("desc").take(20);
  return recent.find((p) => !p.undoneAt) ?? null;
}

const canUndo = (p: Doc<"subscriptionPayments">, last: Doc<"subscriptionPayments"> | null, now: number): boolean =>
  !p.undoneAt && last?._id === p._id && now - Date.parse(p.paidAt) < UNDO_WINDOW_MS;

const toRow = (p: Doc<"subscriptionPayments">, tenantName: string, last: Doc<"subscriptionPayments"> | null, now: number): SubscriptionPaymentRow => ({
  id: p._id,
  tenant: tenantOfDoc(p),
  tenantName,
  amount: p.amount,
  currency: p.currency,
  method: p.method,
  months: p.months ?? null,
  periodFrom: p.periodFrom,
  periodTo: p.periodTo,
  paidAt: p.paidAt,
  note: p.note ?? "",
  byName: p.byName,
  plan: p.plan,
  undoneAt: p.undoneAt ?? null,
  canUndo: canUndo(p, last, now),
});

/** История оплат одной компании (новые сверху). */
export const payments = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }): Promise<SubscriptionPaymentRow[]> => {
    await requirePlatform(ctx);
    const tctx = forTenant(ctx, slug);
    const name = (await tenantView(ctx, slug)).name;
    const list = await tctx.db.query("subscriptionPayments").withIndex("by_paid").order("desc").take(HISTORY);
    const last = list.find((p) => !p.undoneAt) ?? null;
    const now = Date.now();
    return list.map((p) => toRow(p, name, last, now));
  },
});

/** Все оплаты всех компаний — для выгрузки в CSV (новые сверху). */
export const exportPayments = query({
  args: {},
  handler: async (ctx): Promise<SubscriptionPaymentRow[]> => {
    await requirePlatform(ctx);
    const list = await unscopedDb(ctx).query("subscriptionPayments").withIndex("by_paid").order("desc").take(EXPORT_MAX);
    const names = new Map((await ctx.db.query("tenants").collect()).map((r) => [r.slug, r.name] as const));
    return list.map((p) => toRow(p, names.get(tenantOfDoc(p)) ?? tenantOfDoc(p), null, 0));
  },
});

/**
 * «Принять оплату»: сумма, способ и период — N месяцев или явная дата «оплачено до». Продлевает с max(оплачено до, сегодня).
 * Компания приостановлена за неоплату — работа возобновляется сразу; приостановленную администратором оплата не трогает.
 */
export const acceptPayment = mutation({
  args: { slug: v.string(), amount: v.number(), method: payMethod, months: v.optional(v.number()), until: v.optional(v.string()), note: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ id: Id<"subscriptionPayments">; paidUntil: string; reactivated: boolean }> => {
    const me = await requirePlatform(ctx);
    if (!Number.isFinite(a.amount) || a.amount < 0 || a.amount > MAX_AMOUNT) throw new ConvexError("Сумма — от 0 до 100 000 000 ₸");
    if ((a.months === undefined) === (a.until === undefined)) throw new ConvexError("Укажите число месяцев или дату «оплачено до»");
    if (a.months !== undefined && (!Number.isInteger(a.months) || a.months < 1 || a.months > MAX_MONTHS)) throw new ConvexError(`Месяцев — от 1 до ${MAX_MONTHS}`);
    const note = cleanText(a.note ?? "", MAX_NOTE, "Комментарий");
    const row = await platformRow(ctx, a.slug.trim());
    const today = todayAlmaty();
    const period = paymentPeriod(row.paidUntil, today, a.months !== undefined ? { months: a.months } : { until: a.until! });
    const problem = periodProblem(period, today);
    if (problem) throw new ConvexError(problem);
    const reactivated = row.status === "suspended" && row.suspendedFor === "unpaid";
    const tctx = forTenant(ctx, row.slug);
    const amount = Math.round(a.amount);
    const id = await tctx.db.insert("subscriptionPayments", {
      tenantId: row.slug,
      amount,
      currency: "KZT",
      method: a.method,
      ...(a.months !== undefined ? { months: a.months } : {}),
      periodFrom: period.from,
      periodTo: period.to,
      paidAt: nowIso(),
      ...(note ? { note } : {}),
      by: me._id,
      byName: me.name || me.email || "Администратор платформы",
      plan: row.plan,
      ...(row.paidUntil ? { prevPaidUntil: row.paidUntil } : {}),
      ...(reactivated ? { reactivated: true } : {}),
    });
    await ctx.db.patch(row._id, { paidUntil: period.to, ...(reactivated ? { status: "active" as const, suspendedFor: undefined } : {}) });
    const summary = `Платформа: принята оплата подписки ${money(amount)} (${PAY_METHOD_LABEL[a.method]}), оплачено до ${dayText(period.to)}${reactivated ? " — работа возобновлена" : ""}`;
    await audit(tctx, "Платформа", "settings.subscription", summary, { entityId: id, meta: { amount, method: a.method, months: a.months ?? null, periodFrom: period.from, periodTo: period.to, reactivated, by: me._id } });
    await notify(tctx, await ownersOf(tctx), `Оплата подписки получена: тариф «${PLAN_INFO[row.plan].label}» оплачен до ${dayText(period.to)}${reactivated ? ". Работа компании возобновлена" : ""}`, { link: "/settings", tone: "ok" });
    return { id, paidUntil: period.to, reactivated };
  },
});

/**
 * Отмена оплаты (ошиблись суммой или компанией): только последней действующей и не позже суток. «Оплачено до»
 * возвращается прежним; если оплата возобновила работу, а без неё срок с льготными днями уже прошёл, — снова пауза.
 */
export const undoPayment = mutation({
  args: { slug: v.string(), id: v.id("subscriptionPayments") },
  handler: async (ctx, { slug, id }): Promise<void> => {
    const me = await requirePlatform(ctx);
    const row = await tenantRow(ctx, slug);
    if (!row) throw new ConvexError("Компания не найдена");
    const tctx = forTenant(ctx, row.slug);
    const p = await tctx.db.get(id);
    if (!p) throw new ConvexError("Оплата не найдена");
    if (p.undoneAt) throw new ConvexError("Оплата уже отменена");
    if (Date.now() - Date.parse(p.paidAt) >= UNDO_WINDOW_MS) throw new ConvexError("Отменить можно только в течение суток после оплаты");
    if ((await lastActive(tctx))?._id !== p._id) throw new ConvexError("Сначала отмените более позднюю оплату этой компании");
    const settings = await readSettings(ctx);
    const resuspend = p.reactivated === true && row.status === "active" && suspendDue(p.prevPaidUntil, todayAlmaty(), settings.graceDays);
    await tctx.db.patch(p._id, { undoneAt: nowIso(), undoneBy: me._id });
    await ctx.db.patch(row._id, { paidUntil: p.prevPaidUntil, ...(resuspend ? { status: "suspended" as const, suspendedFor: "unpaid" as const } : {}) });
    await audit(
      tctx,
      "Платформа",
      "settings.subscription",
      `Платформа: оплата подписки ${money(p.amount)} от ${dayText(p.paidAt.slice(0, 10))} отменена — ${p.prevPaidUntil ? `оплачено до ${dayText(p.prevPaidUntil)}` : "срок как до оплаты"}${resuspend ? ", работа снова приостановлена" : ""}`,
      { entityId: p._id, meta: { amount: p.amount, prevPaidUntil: p.prevPaidUntil ?? null, resuspend, by: me._id } },
    );
  },
});

// ── Владельцу и экрану «Доступ отключён» ─────────────────────────────────────

/** Подписка своей компании — владельцу: карточка «Компания» и плашка на «Главной». Остальным — null. */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<MySubscription | null> => {
    const me = await currentUser(ctx);
    if (!me || me.role !== "owner") return null;
    const view = await tenantView(ctx, me.tenantId);
    const paidUntil = (await tenantRow(ctx, me.tenantId))?.paidUntil ?? null;
    return { plan: view.plan, paidUntil, status: subscriptionStatus(paidUntil, todayAlmaty()), howToPay: (await readSettings(ctx)).howToPay };
  },
});

/** Почему работа компании вошедшего приостановлена и как оплатить; null — компания работает или человек не вошёл. */
export const blocked = query({
  args: {},
  handler: async (ctx): Promise<BlockedInfo | null> => {
    const me = await signedInUser(ctx);
    if (!me) return null;
    const row = await tenantRow(ctx, me.tenantId);
    if (!row || row.status === "active") return null;
    return { company: row.name, unpaid: row.suspendedFor === "unpaid", paidUntil: row.paidUntil ?? null, howToPay: (await readSettings(ctx)).howToPay };
  },
});

// ── Ежедневная проверка сроков ───────────────────────────────────────────────

/** Действующие владельцы компании (ctx — база этой компании). */
async function ownersOf(ctx: QueryCtx): Promise<Id<"users">[]> {
  const owners = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", "owner"))
    .take(20);
  return owners.filter((u) => u.active !== false).map((u) => u._id);
}

/** Администраторы платформы — пользователи с логинами из PLATFORM_ADMINS (у каждого своя компания). */
async function platformAdmins(ctx: QueryCtx): Promise<Doc<"users">[]> {
  const out: Doc<"users">[] = [];
  for (const login of platformAdminLogins()) {
    const u = await unscopedDb(ctx)
      .query("users")
      .withIndex("email", (q) => q.eq("email", login))
      .first();
    if (u && u.active !== false) out.push(u);
  }
  return out;
}

async function notifyAdmins(ctx: MutationCtx, admins: Doc<"users">[], text: string): Promise<void> {
  for (const a of admins) await notify(forTenant(ctx, tenantOfDoc(a)), [a._id], text, { link: "/platform", tone: "warn" });
}

const contact = (howToPay: string): string => (howToPay ? `Как оплатить: ${howToPay}` : "Напишите администратору платформы");

/** Напоминание за 7 / 1 день: владельцам компании и администраторам платформы. */
async function remind(ctx: MutationCtx, row: TenantRow & { paidUntil: string }, left: number, s: PlatformSettings, admins: Doc<"users">[]): Promise<void> {
  const tctx = forTenant(ctx, row.slug);
  const when = left === 0 ? "сегодня последний день" : `осталось ${daysText(left)}`;
  await notify(tctx, await ownersOf(tctx), `Подписка «${PLAN_INFO[row.plan].label}» оплачена до ${dayText(row.paidUntil)} — ${when}. Продлите — напишите нам. ${contact(s.howToPay)}`, {
    link: "/settings",
    tone: "warn",
    email: { kind: "subscription" },
  });
  await notifyAdmins(ctx, admins, `Компания «${row.name}»: подписка до ${dayText(row.paidUntil)} — ${when}`);
}

/** Срок и льготные дни прошли — приостановить (данные остаются, оплата возобновит работу). */
async function suspend(ctx: MutationCtx, row: TenantRow & { paidUntil: string }, s: PlatformSettings, admins: Doc<"users">[]): Promise<void> {
  const tctx = forTenant(ctx, row.slug);
  await ctx.db.patch(row._id, { status: "suspended", suspendedFor: "unpaid" });
  await audit(tctx, "Система", "settings.subscription", `Работа компании приостановлена: подписка оплачена до ${dayText(row.paidUntil)}, льготных дней — ${s.graceDays}. Данные сохранены`, {
    entityId: row.slug,
    meta: { paidUntil: row.paidUntil, graceDays: s.graceDays },
  });
  // В колокольчик владелец уже не войдёт — главное здесь Telegram и письмо.
  await notify(tctx, await ownersOf(tctx), `Работа компании «${row.name}» приостановлена: подписка не оплачена (была до ${dayText(row.paidUntil)}). Данные сохранены — после оплаты всё заработает. ${contact(s.howToPay)}`, {
    tone: "bad",
    email: { kind: "subscription" },
  });
  await notifyAdmins(ctx, admins, `Компания «${row.name}» приостановлена за неоплату: подписка была до ${dayText(row.paidUntil)}`);
}

/**
 * Раз в день (crons.ts): напоминания и приостановка. Компании без «оплачено до» (демо, до SaaS) — бессрочно.
 * Компанию, в которой работает администратор платформы, крон не приостанавливает: он потерял бы доступ к «Платформе».
 */
export const run = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ reminded: number; suspended: number }> => {
    const today = todayAlmaty();
    const s = await readSettings(ctx);
    const admins = await platformAdmins(ctx);
    const adminTenants = new Set(admins.map(tenantOfDoc));
    let reminded = 0;
    let suspended = 0;
    for (const row of await ctx.db.query("tenants").collect()) {
      const paidUntil = row.paidUntil;
      if (!paidUntil || row.status !== "active") continue;
      const paid = { ...row, paidUntil };
      if (suspendDue(paidUntil, today, s.graceDays)) {
        if (adminTenants.has(row.slug)) continue;
        await suspend(ctx, paid, s, admins);
        suspended++;
        continue;
      }
      const sent = row.subscriptionReminders?.paidUntil === paidUntil ? row.subscriptionReminders.sent : [];
      const due = reminderDue(paidUntil, today, sent);
      if (!due) continue;
      await remind(ctx, paid, subscriptionStatus(paidUntil, today).daysLeft ?? 0, s, admins);
      await ctx.db.patch(row._id, { subscriptionReminders: { paidUntil, sent: [...sent, due] } });
      reminded++;
    }
    return { reminded, suspended };
  },
});
