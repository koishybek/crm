import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { assertScope, currentUser, inScope, requireRole, scopeOf, TEAM } from "./lib/access";
import { audit } from "./lib/audit";
import { executorUser, log, notify, nowIso, setStatus, staffIds, uid, userActor } from "./lib/domain";
import { toExecutor, toHistory, toMessage, toOrder, toOrderWithFiles } from "./lib/dto";
import { suitableUsers } from "./lib/matching";
import { ACTIVE_STATUSES, ORDER_STATUS, PAYMENT_METHODS, STAFF_TRANSITIONS, type Category } from "../src/data/catalog";
import { loadCatalog } from "./catalog";
import { announceOrder, cardOf } from "./worker";
import { cardHtml, workerButtons } from "./lib/tg";
import { env } from "./env";
import { fitsOrder, isOpenForFeed, payout } from "../src/data/logic";
import { catalogSkills, normalizeSkills, skillsDiff, SKILLS_PER_CATEGORY, textKey } from "../src/data/skills";
import { money, shortName } from "../src/lib/format";
import { attachment, orderStatus, paymentMethod, urgency } from "./schema";

async function activeOrders(ctx: QueryCtx) {
  const out: Doc<"orders">[] = [];
  for (const s of ACTIVE_STATUSES) out.push(...(await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", s)).collect()));
  return out;
}

/** Доска заказов: все активные + завершённые и отменённые за последние `days` дней. */
export const board = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days }) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const since = new Date(Date.now() - (days ?? 45) * 86400_000).toISOString();
    const active = await activeOrders(ctx);
    const done = await ctx.db.query("orders").withIndex("by_done", (q) => q.gte("doneAt", since)).collect();
    const cancelled = (await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "cancelled")).order("desc").take(60)).filter((o) => o.createdAt >= since);
    const refunds = await ctx.db.query("orders").withIndex("by_status", (q) => q.eq("status", "refund")).take(30);
    const seen = new Set<string>();
    const all = [...active, ...done, ...cancelled, ...refunds].filter((o) => (seen.has(o._id) ? false : (seen.add(o._id), true)));
    return all.filter((o) => inScope(scope, o.category)).map(toOrder);
  },
});

/** Активные заказы (для подбора исполнителей, колокольчика и «Исполнителей»). */
export const active = query({
  args: {},
  handler: async (ctx) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    return (await activeOrders(ctx)).filter((o) => inScope(scope, o.category)).map(toOrder);
  },
});

export const detail = query({
  args: { id: v.id("orders") },
  handler: async (ctx, { id }) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const o = await ctx.db.get(id);
    if (!o || !inScope(scope, o.category)) return null;
    const [client, messages, history, executors, active] = await Promise.all([
      ctx.db.get(o.clientId),
      ctx.db.query("messages").withIndex("by_order", (q) => q.eq("orderId", id)).collect(),
      ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", id)).collect(),
      ctx.db.query("executors").collect(),
      activeOrders(ctx),
    ]);
    return {
      order: await toOrderWithFiles(ctx, o),
      client: client ? { id: client._id, name: client.name, phone: client.phone } : null,
      messages: await Promise.all(messages.map((m) => toMessage(ctx, m))),
      history: history.map(toHistory),
      executors: executors.filter((e) => !scope || e.categories.some((c) => scope.includes(c))).map(toExecutor),
      // Для подбора: кто чем занят (без цен — только статус и исполнитель).
      load: active.filter((x) => x.executorId).map((x) => ({ executorId: x.executorId!, status: x.status })),
    };
  },
});

async function staffOrder(ctx: QueryCtx, id: Id<"orders">) {
  const me = await requireRole(ctx, TEAM);
  const o = await ctx.db.get(id);
  if (!o) throw new ConvexError("Заказ не найден");
  assertScope(me, o.category);
  return o;
}

/** Поля карточки, которые правит updateInfo, — для текста истории и журнала. */
const INFO_FIELDS = { serviceId: "услуга", description: "описание", city: "город", address: "адрес", deadline: "срок", priority: "приоритет" } as const;
type InfoField = keyof typeof INFO_FIELDS;

/**
 * Требуемые навыки заказа (ТЗ п.11): только из справочника направления заказа и в его написании.
 * Навык, который уже стоял на заказе этого направления, остаётся, даже если владелец потом убрал его
 * из справочника, — иначе любая правка заказа упиралась бы в старые данные. При смене направления
 * переносятся только навыки, которые есть и в новом. input не передан (старые вызовы) — навыки не меняются.
 */
function resolveSkills(categories: readonly Category[], o: Doc<"orders">, category: string, input: readonly string[] | undefined): string[] {
  const options = catalogSkills(categories, [category]);
  const kept = o.category === category ? (o.requiredSkills ?? []) : [];
  const pick = (s: string): string | undefined => options.find((x) => textKey(x) === textKey(s)) ?? kept.find((x) => textKey(x) === textKey(s));
  if (input === undefined) return (o.requiredSkills ?? []).map(pick).filter((s): s is string => s !== undefined);
  const r = normalizeSkills(input, SKILLS_PER_CATEGORY);
  if (!r.ok) throw new ConvexError(r.error);
  const label = categories.find((c) => c.id === category)?.label ?? category;
  return r.skills.map((s) => {
    const found = pick(s);
    if (!found) throw new ConvexError(`Навыка «${s}» нет в справочнике направления «${label}»`);
    return found;
  });
}

export const updateInfo = mutation({
  args: {
    id: v.id("orders"),
    serviceId: v.string(),
    description: v.string(),
    city: v.string(),
    address: v.string(),
    deadline: v.string(),
    priority: urgency,
    /** Навыки, без которых заказ мастеру не показываем. Не передан — не меняются. */
    requiredSkills: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { id, requiredSkills, ...a }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (Number.isNaN(Date.parse(a.deadline))) throw new ConvexError("Неверная дата");
    const catalog = await loadCatalog(ctx);
    const svc = catalog.service(a.serviceId);
    assertScope(me, svc.category);
    const skills = resolveSkills(catalog.categories, o, svc.category, requiredSkills);
    const diff = skillsDiff(o.requiredSkills ?? [], skills);
    const skillsChanged = diff.added.length > 0 || diff.removed.length > 0;
    // Кому заказ из ленты подходил до правки — чтобы после неё позвать только новых подходящих.
    const before = isOpenForFeed(o) ? new Set(await suitableUsers(ctx, o)) : null;

    const info = { ...a, description: a.description.trim(), address: a.address.trim(), deadline: new Date(a.deadline).toISOString() };
    const changed = (Object.keys(INFO_FIELDS) as InfoField[]).filter((k) => info[k] !== o[k]);
    // Напоминания о сроке взводим заново, только если срок сдвинули: правка навыков не должна их повторять.
    const rearm = changed.includes("deadline") ? { soonNotified: false, overdueNotified: false } : {};
    await ctx.db.patch(id, { ...info, category: svc.category, requiredSkills: skills.length ? skills : undefined, ...rearm });

    const actor = userActor(me._id);
    if (changed.length) {
      const what = changed.map((k) => INFO_FIELDS[k]).join(", ");
      await log(ctx, id, "edited", `Изменены данные заказа: ${what}`, actor);
      await audit(ctx, me, "order.info", `Заказ №${o.number}: изменены ${what}`, { entityId: id, meta: { fields: changed } });
    }
    let notified = 0;
    if (before) {
      const fresh = (await ctx.db.get(id))!;
      const added = (await suitableUsers(ctx, fresh)).filter((u) => !before.has(u));
      await announceOrder(ctx, fresh, added);
      notified = added.length;
    }
    if (skillsChanged) {
      const text = skills.length ? `Нужны навыки: ${skills.join(", ")}` : "Требования к навыкам сняты";
      await log(ctx, id, "edited", text, actor);
      await audit(ctx, me, "order.skills", `Заказ №${o.number}: ${text.charAt(0).toLowerCase()}${text.slice(1)}`, { entityId: id, meta: { skills, ...diff, notified } });
    }
    return { notified };
  },
});

/** Финансы меняет только сотрудник (ТЗ: AI и исполнитель не трогают деньги). */
export const updateFinance = mutation({
  args: { id: v.id("orders"), clientPrice: v.number(), payoutMode: v.union(v.literal("fixed"), v.literal("percent")), payoutValue: v.number(), payoutPaid: v.boolean() },
  handler: async (ctx, { id, ...f }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (f.clientPrice < 0 || f.payoutValue < 0 || !Number.isFinite(f.clientPrice) || !Number.isFinite(f.payoutValue)) throw new ConvexError("Суммы не могут быть отрицательными");
    if (f.payoutMode === "percent" && f.payoutValue > 100) throw new ConvexError("Процент не больше 100");
    if (payout(f) > f.clientPrice) throw new ConvexError("Выплата исполнителю больше цены клиента — маржа уйдёт в минус");
    const before = `${money(o.clientPrice)} / ${money(payout(o))}`;
    const after = `${money(f.clientPrice)} / ${money(payout(f))}`;
    await ctx.db.patch(id, { clientPrice: Math.round(f.clientPrice), payoutMode: f.payoutMode, payoutValue: f.payoutValue, payoutPaid: f.payoutPaid });
    if (after !== before) await log(ctx, id, "finance", `Финансы: ${before} → ${after}`, userActor(me._id));
    if (f.payoutPaid !== o.payoutPaid) await log(ctx, id, "finance", f.payoutPaid ? `Исполнителю выплачено ${money(payout(f))}` : "Отметка о выплате снята", userActor(me._id));
  },
});

export const addPayment = mutation({
  args: { id: v.id("orders"), amount: v.number(), method: paymentMethod },
  handler: async (ctx, { id, amount, method }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (!(amount > 0)) throw new ConvexError("Сумма должна быть больше нуля");
    const payments = [...o.payments, { id: uid("p"), amount: Math.round(amount), method, at: nowIso() }];
    await ctx.db.patch(id, { payments });
    await log(ctx, id, "payment", `Внесена оплата ${money(amount)} (${PAYMENT_METHODS[method]})`, userActor(me._id));
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    if (paid >= o.clientPrice && (o.status === "done" || o.status === "awaiting_payment")) await setStatus(ctx, o, "paid", userActor(me._id));
    const owners = (await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect()).map((u) => u._id);
    await notify(ctx, owners, `Оплата по заказу №${o.number}: ${money(amount)}`, { link: `/orders/${id}`, tone: "ok", except: me._id });
  },
});

/** Публикация возвращает, скольким мастерам ушло уведомление: ноль — повод назначить вручную. */
export const changeStatus = mutation({
  args: { id: v.id("orders"), to: orderStatus, reason: v.optional(v.string()) },
  handler: async (ctx, { id, to, reason }): Promise<{ notified: number } | null> => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (!STAFF_TRANSITIONS[o.status].includes(to)) throw new ConvexError(`Из статуса «${ORDER_STATUS[o.status].label}» нельзя перейти в «${ORDER_STATUS[to].label}»`);
    const actor = userActor(me._id);
    const extra: Partial<Doc<"orders">> = {};
    // Публикация: заказ видят и получают уведомление только подходящие мастера (ТЗ п.11, п.18).
    let recipients: Id<"users">[] = [];
    if (to === "awaiting_executor") {
      if (o.clientPrice <= 0 || payout(o) <= 0) throw new ConvexError("Сначала укажите цену клиента и выплату исполнителю");
      const previous = o.executorId ? (await executorUser(ctx, o.executorId))?._id : undefined;
      if (o.executorId) {
        await notify(ctx, [previous], `Заказ №${o.number} снят с вас и возвращён в ленту`, { link: "/w", tone: "warn" });
        extra.executorId = undefined;
        extra.assignedAt = undefined;
      }
      // Снятому мастеру уже сообщили — «Новый заказ» ему не шлём.
      recipients = (await suitableUsers(ctx, o)).filter((u) => u !== previous);
    }
    if (to === "paid") {
      const paid = o.payments.reduce((s, p) => s + p.amount, 0);
      if (paid < o.clientPrice) {
        extra.payments = [...o.payments, { id: uid("p"), amount: o.clientPrice - paid, method: "kaspi", at: nowIso() }];
        await log(ctx, id, "payment", `Внесена оплата ${money(o.clientPrice - paid)}`, actor);
      }
    }
    if (to === "cancelled") extra.cancelReason = reason?.trim().slice(0, 300) || "Без причины";
    if (to === "new" && o.status === "cancelled") extra.cancelReason = undefined;
    const published = recipients.length ? `Опубликован в ленту исполнителей — уведомлено: ${recipients.length}` : "Опубликован в ленту исполнителей — подходящих сейчас нет";
    const text = to === "cancelled" ? `Заказ отменён: ${extra.cancelReason}` : to === "awaiting_executor" ? published : undefined;
    await setStatus(ctx, o, to, actor, text, extra);
    await audit(
      ctx,
      me,
      to === "awaiting_executor" ? "order.published" : "order.status",
      to === "awaiting_executor" ? `Заказ №${o.number}: ${published.charAt(0).toLowerCase()}${published.slice(1)}` : `Заказ №${o.number}: «${ORDER_STATUS[o.status].label}» → «${ORDER_STATUS[to].label}»${to === "cancelled" ? ` (${extra.cancelReason})` : ""}`,
      { entityId: id, meta: { from: o.status, to, ...(to === "awaiting_executor" ? { notified: recipients.length } : {}) } },
    );

    if (to === "awaiting_executor") {
      await announceOrder(ctx, (await ctx.db.get(o._id))!, recipients);
      return { notified: recipients.length };
    }
    if (o.executorId) {
      await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Заказ №${o.number}: ${ORDER_STATUS[to].label.toLowerCase()}`, { link: `/w/orders/${o._id}`, tone: to === "cancelled" ? "bad" : "info" });
    }
    return null;
  },
});

/**
 * Ручное назначение (ТЗ п.12). Можно и мимо подбора — человек решает, — но причина попадает в историю.
 * Мастера на выходном назначает только владелец: остальным система этого не даёт.
 */
export const assign = mutation({
  args: { id: v.id("orders"), executorId: v.id("executors") },
  handler: async (ctx, { id, executorId }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    const e = await ctx.db.get(executorId);
    if (!e) throw new ConvexError("Исполнитель не найден");
    const scope = scopeOf(me);
    if (scope && !e.categories.some((c) => scope.includes(c))) throw new ConvexError("Это исполнитель другого направления");
    if (!e.available && me.role !== "owner") throw new ConvexError("Исполнитель на выходном — назначить его может только владелец");
    if (!["new", "awaiting_executor", "assigned", "accepted"].includes(o.status)) throw new ConvexError("Исполнителя можно менять только до начала работ");
    if (o.executorId === executorId) throw new ConvexError("Этот исполнитель уже назначен");
    if (o.clientPrice <= 0 || payout(o) <= 0) throw new ConvexError("Сначала укажите цену клиента и выплату исполнителю");
    if (o.executorId) {
      await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Заказ №${o.number} передан другому исполнителю`, { link: "/w", tone: "warn" });
    }
    const fit = fitsOrder(e, o);
    const outside = fit.fits ? "" : ` (вне подбора: ${fit.reasons.join("; ")})`;
    await ctx.db.patch(id, { executorId, assignedAt: nowIso(), status: "assigned" });
    await log(ctx, id, "assigned", `Назначен исполнитель: ${shortName(e.name)}${outside}`, userActor(me._id));
    await audit(ctx, me, "order.assigned", `Заказ №${o.number}: назначен ${shortName(e.name)}${outside}`, { entityId: id, meta: { executorId, fits: fit.fits, reasons: fit.reasons } });
    const assigned = (await ctx.db.get(id))!;
    await notify(ctx, [(await executorUser(ctx, executorId))?._id], `Вам назначен заказ №${o.number}: ${(await loadCatalog(ctx)).label(o.serviceId)}. Подтвердите в кабинете`, {
      link: `/w/orders/${id}`,
      tone: "warn",
      html: cardHtml(await cardOf(ctx, assigned, false), `📌 Вам назначен заказ №${o.number}`),
      buttons: workerButtons("assigned", id, env("APP_URL")),
    });
  },
});

/** Ссылка для загрузки файла в хранилище Convex. */
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    if (!(await currentUser(ctx))) throw new ConvexError("Нужно войти");
    return ctx.storage.generateUploadUrl();
  },
});

/** Сообщение в заказе: сотрудник — в любой заказ, исполнитель — только в свой. */
export const addMessage = mutation({
  args: { orderId: v.id("orders"), text: v.string(), channel: v.union(v.literal("internal"), v.literal("client")), files: v.array(attachment) },
  handler: async (ctx, { orderId, text, channel, files }) => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    const o = await ctx.db.get(orderId);
    if (!o) throw new ConvexError("Заказ не найден");
    if (me.role === "executor" && o.executorId !== me.executorId) throw new ConvexError("Это не ваш заказ");
    if (me.role === "manager") assertScope(me, o.category);
    if (!text.trim() && !files.length) throw new ConvexError("Пустое сообщение");
    if (files.length > 10) throw new ConvexError("Не больше 10 файлов за раз");
    const at = nowIso();
    await ctx.db.insert("messages", { orderId, author: userActor(me._id), channel, text: text.trim().slice(0, 4000), files, at });
    const actor = userActor(me._id);
    if (files.length) {
      await ctx.db.patch(orderId, { files: [...o.files, ...files] });
      await log(ctx, orderId, "file", `Добавлено файлов: ${files.length}`, actor);
    }
    if (text.trim()) await log(ctx, orderId, "comment", channel === "internal" ? "Внутренний комментарий" : "Добавлен комментарий", actor);
    const exUser = o.executorId ? (await executorUser(ctx, o.executorId))?._id : undefined;
    await notify(ctx, await staffIds(ctx, o.category), `Новое сообщение в заказе №${o.number}`, { link: `/orders/${orderId}`, except: me._id });
    if (exUser) await notify(ctx, [exUser], `Новое сообщение в заказе №${o.number}`, { link: `/w/orders/${orderId}`, except: me._id });
  },
});

