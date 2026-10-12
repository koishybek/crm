import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { assertScope, currentUser, inScope, requireRole, scopeOf, TEAM } from "./lib/access";
import { executorUser, log, notify, nowIso, setStatus, staffIds, uid, userActor } from "./lib/domain";
import { toExecutor, toHistory, toMessage, toOrder, toOrderWithFiles } from "./lib/dto";
import { ACTIVE_STATUSES, ORDER_STATUS, PAYMENT_METHODS, STAFF_TRANSITIONS } from "../src/data/catalog";
import { loadCatalog } from "./catalog";
import { cardOf } from "./worker";
import { cardHtml, workerButtons } from "./lib/tg";
import { env } from "./env";
import { payout } from "../src/data/logic";
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

export const updateInfo = mutation({
  args: { id: v.id("orders"), serviceId: v.string(), description: v.string(), city: v.string(), address: v.string(), deadline: v.string(), priority: urgency },
  handler: async (ctx, { id, ...a }) => {
    const me = await requireRole(ctx, TEAM);
    await staffOrder(ctx, id);
    if (Number.isNaN(Date.parse(a.deadline))) throw new ConvexError("Неверная дата");
    const svc = (await loadCatalog(ctx)).service(a.serviceId);
    assertScope(me, svc.category);
    await ctx.db.patch(id, { ...a, category: svc.category, description: a.description.trim(), address: a.address.trim(), deadline: new Date(a.deadline).toISOString(), soonNotified: false, overdueNotified: false });
    await log(ctx, id, "edited", "Изменены данные заказа", userActor(me._id));
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

export const changeStatus = mutation({
  args: { id: v.id("orders"), to: orderStatus, reason: v.optional(v.string()) },
  handler: async (ctx, { id, to, reason }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (!STAFF_TRANSITIONS[o.status].includes(to)) throw new ConvexError(`Из статуса «${ORDER_STATUS[o.status].label}» нельзя перейти в «${ORDER_STATUS[to].label}»`);
    const actor = userActor(me._id);
    const extra: Partial<Doc<"orders">> = {};
    if (to === "awaiting_executor") {
      if (o.clientPrice <= 0 || payout(o) <= 0) throw new ConvexError("Сначала укажите цену клиента и выплату исполнителю");
      if (o.executorId) {
        await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Заказ №${o.number} снят с вас и возвращён в ленту`, { link: "/w", tone: "warn" });
        extra.executorId = undefined;
        extra.assignedAt = undefined;
      }
    }
    if (to === "paid") {
      const paid = o.payments.reduce((s, p) => s + p.amount, 0);
      if (paid < o.clientPrice) {
        extra.payments = [...o.payments, { id: uid("p"), amount: o.clientPrice - paid, method: "kaspi", at: nowIso() }];
        await log(ctx, id, "payment", `Внесена оплата ${money(o.clientPrice - paid)}`, actor);
      }
    }
    if (to === "cancelled") extra.cancelReason = reason ?? "Без причины";
    if (to === "new" && o.status === "cancelled") extra.cancelReason = undefined;
    const text = to === "cancelled" ? `Заказ отменён: ${extra.cancelReason}` : to === "awaiting_executor" ? "Опубликован в ленту исполнителей" : undefined;
    await setStatus(ctx, o, to, actor, text, extra);

    if (to === "awaiting_executor") {
      const fits = (await ctx.db.query("executors").collect()).filter((e) => e.available && e.city === o.city && e.categories.includes(o.category));
      const users = await Promise.all(fits.map((e) => executorUser(ctx, e._id)));
      const fresh = (await ctx.db.get(o._id))!;
      await notify(ctx, users.map((u) => u?._id), `Новый заказ №${o.number}: ${(await loadCatalog(ctx)).label(o.serviceId)}, ${o.city}. Оплата исполнителю ${money(payout(o))}`, {
        link: "/w",
        html: cardHtml(await cardOf(ctx, fresh, false), `🆕 Новый заказ №${o.number}`),
        buttons: workerButtons("awaiting_executor", o._id),
      });
    } else if (o.executorId) {
      await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Заказ №${o.number}: ${ORDER_STATUS[to].label.toLowerCase()}`, { link: `/w/orders/${o._id}`, tone: to === "cancelled" ? "bad" : "info" });
    }
  },
});

export const assign = mutation({
  args: { id: v.id("orders"), executorId: v.id("executors") },
  handler: async (ctx, { id, executorId }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    const e = await ctx.db.get(executorId);
    if (!e) throw new ConvexError("Исполнитель не найден");
    if (!e.available) throw new ConvexError("Исполнитель на выходном");
    if (!["new", "awaiting_executor", "assigned", "accepted"].includes(o.status)) throw new ConvexError("Исполнителя можно менять только до начала работ");
    if (o.clientPrice <= 0 || payout(o) <= 0) throw new ConvexError("Сначала укажите цену клиента и выплату исполнителю");
    if (o.executorId && o.executorId !== executorId) {
      await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Заказ №${o.number} передан другому исполнителю`, { link: "/w", tone: "warn" });
    }
    await ctx.db.patch(id, { executorId, assignedAt: nowIso(), status: "assigned" });
    await log(ctx, id, "assigned", `Назначен исполнитель: ${shortName(e.name)}`, userActor(me._id));
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

