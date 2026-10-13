import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { assertScope, currentUser, inScope, requireRole, scopeOf, TEAM } from "./lib/access";
import { almatyStamp, audit, lowerFirst, quote } from "./lib/audit";
import { executorUser, log, notify, nowIso, setStatus, staffIds, uid, userActor } from "./lib/domain";
import { toExecutor, toHistory, toMessage, toOrder, toOrderWithFiles } from "./lib/dto";
import { cleanMoney, cleanText } from "./lib/limits";
import { suitableUsers } from "./lib/matching";
import { ACTIVE_STATUSES, ORDER_STATUS, PAYMENT_METHODS, STAFF_TRANSITIONS, URGENCY, type Category } from "../src/data/catalog";
import { loadCatalog } from "./catalog";
import { announceOrder, notifyAssigned } from "./worker";
import { fitsOrder, isOpenForFeed, margin, payout } from "../src/data/logic";
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
type Info = Pick<Doc<"orders">, InfoField>;

/**
 * «Было → стало» по полю заказа для истории и журнала. Срок — по Алматы, адрес — короткой цитатой,
 * описание — только отметкой: текст клиента в журнал не копируем.
 */
function infoChange(k: InfoField, before: Info, after: Info, label: (serviceId: string) => string): string {
  switch (k) {
    case "serviceId":
      return `услуга ${quote(label(before.serviceId))} → ${quote(label(after.serviceId))}`;
    case "city":
      return `город ${before.city} → ${after.city}`;
    case "address":
      return `адрес ${quote(before.address)} → ${quote(after.address)}`;
    case "deadline":
      return `срок ${almatyStamp(before.deadline)} → ${almatyStamp(after.deadline)}`;
    case "priority":
      return `приоритет ${URGENCY[before.priority].label} → ${URGENCY[after.priority].label}`;
    case "description":
      return INFO_FIELDS.description;
  }
}

/** Выплата для текста журнала: при проценте видно и сумму, и ставку. */
const payoutText = (f: Pick<Doc<"orders">, "clientPrice" | "payoutMode" | "payoutValue">) => (f.payoutMode === "percent" ? `${money(payout(f))} (${f.payoutValue}%)` : money(payout(f)));
/** «30 000 ₸ → 35 000 ₸», а если не менялось — просто «30 000 ₸». */
const moneyMove = (from: string, to: string) => (from === to ? from : `${from} → ${to}`);

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

    const info: Info = {
      serviceId: a.serviceId,
      description: cleanText(a.description, 4000, "Описание"),
      city: cleanText(a.city, 60, "Город"),
      address: cleanText(a.address, 300, "Адрес"),
      deadline: new Date(a.deadline).toISOString(),
      priority: a.priority,
    };
    const changed = (Object.keys(INFO_FIELDS) as InfoField[]).filter((k) => info[k] !== o[k]);
    // Напоминания о сроке взводим заново, только если срок сдвинули: правка навыков не должна их повторять.
    const rearm = changed.includes("deadline") ? { soonNotified: false, overdueNotified: false } : {};
    await ctx.db.patch(id, { ...info, category: svc.category, requiredSkills: skills.length ? skills : undefined, ...rearm });

    const actor = userActor(me._id);
    const details = changed.map((k) => infoChange(k, o, info, catalog.label));
    if (changed.length) await log(ctx, id, "edited", `Изменены данные заказа: ${details.join("; ")}`, actor);
    let notified = 0;
    if (before) {
      const fresh = (await ctx.db.get(id))!;
      const added = (await suitableUsers(ctx, fresh)).filter((u) => !before.has(u));
      await announceOrder(ctx, fresh, added);
      notified = added.length;
    }
    const skillsText = skills.length ? `Нужны навыки: ${skills.join(", ")}` : "Требования к навыкам сняты";
    if (skillsChanged) await log(ctx, id, "edited", skillsText, actor);
    // Одно сохранение карточки — одна запись в журнале, даже если поменялись и данные, и навыки.
    if (changed.length || skillsChanged) {
      const parts = [...details, ...(skillsChanged ? [lowerFirst(skillsText)] : [])];
      // Адрес и описание — персональные данные клиента: в деталях только отметка, сами значения — в карточке заказа.
      const changes = Object.fromEntries(changed.map((k) => [k, k === "description" || k === "address" ? "изменено" : { from: o[k], to: info[k] }]));
      await audit(ctx, me, changed.length ? "order.info" : "order.skills", `Заказ №${o.number}: ${parts.join("; ")}`, {
        entityId: id,
        meta: { changes, ...(skillsChanged ? { skills, added: diff.added, removed: diff.removed } : {}), notified },
      });
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
    // Деньги храним в целых тенге — проверяем ровно то, что сохраним.
    const next = {
      clientPrice: cleanMoney(f.clientPrice, "Цена клиента"),
      payoutMode: f.payoutMode,
      payoutValue: f.payoutMode === "fixed" ? cleanMoney(f.payoutValue, "Выплата исполнителю") : f.payoutValue,
    };
    if (payout(next) > next.clientPrice) throw new ConvexError("Выплата исполнителю больше цены клиента — маржа уйдёт в минус");
    const moneyChanged = next.clientPrice !== o.clientPrice || next.payoutMode !== o.payoutMode || next.payoutValue !== o.payoutValue;
    const paidChanged = f.payoutPaid !== o.payoutPaid;
    if (!moneyChanged && !paidChanged) return;
    await ctx.db.patch(id, { ...next, payoutPaid: f.payoutPaid });

    const actor = userActor(me._id);
    const before = `${money(o.clientPrice)} / ${money(payout(o))}`;
    const after = `${money(next.clientPrice)} / ${money(payout(next))}`;
    if (after !== before) await log(ctx, id, "finance", `Финансы: ${before} → ${after}`, actor);
    if (paidChanged) await log(ctx, id, "finance", f.payoutPaid ? `Исполнителю выплачено ${money(payout(next))}` : "Отметка о выплате снята", actor);
    // ТЗ п.13: в журнале — цена клиента, выплата и маржа «было → стало», чтобы любую правку денег можно было восстановить.
    const parts = moneyChanged
      ? [`цена клиента ${moneyMove(money(o.clientPrice), money(next.clientPrice))}`, `выплата ${moneyMove(payoutText(o), payoutText(next))}`, `маржа ${moneyMove(money(margin(o)), money(margin(next)))}`]
      : [];
    if (paidChanged) parts.push(f.payoutPaid ? `выплата исполнителю отмечена (${money(payout(next))})` : "отметка о выплате исполнителю снята");
    const snapshot = (x: typeof next & { payoutPaid: boolean }) => ({ ...x, payout: payout(x), margin: margin(x) });
    await audit(ctx, me, "order.finance", `Заказ №${o.number}: ${parts.join(", ")}`, {
      entityId: id,
      meta: { before: snapshot({ clientPrice: o.clientPrice, payoutMode: o.payoutMode, payoutValue: o.payoutValue, payoutPaid: o.payoutPaid }), after: snapshot({ ...next, payoutPaid: f.payoutPaid }) },
    });
  },
});

export const addPayment = mutation({
  args: { id: v.id("orders"), amount: v.number(), method: paymentMethod },
  handler: async (ctx, { id, amount, method }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (!(amount > 0)) throw new ConvexError("Сумма должна быть больше нуля");
    const value = cleanMoney(amount, "Оплата");
    if (value < 1) throw new ConvexError("Сумма должна быть больше нуля");
    const payment = { id: uid("p"), amount: value, method, at: nowIso() };
    const payments = [...o.payments, payment];
    await ctx.db.patch(id, { payments });
    await log(ctx, id, "payment", `Внесена оплата ${money(value)} (${PAYMENT_METHODS[method]})`, userActor(me._id));
    const paid = payments.reduce((s, p) => s + p.amount, 0);
    const toPaid = paid >= o.clientPrice && (o.status === "done" || o.status === "awaiting_payment");
    if (toPaid) await setStatus(ctx, o, "paid", userActor(me._id));
    await audit(ctx, me, "order.payment", `Заказ №${o.number}: оплата ${money(value)} (${PAYMENT_METHODS[method]}), оплачено ${money(paid)} из ${money(o.clientPrice)}${toPaid ? "; статус «Оплачен»" : ""}`, {
      entityId: id,
      meta: { paymentId: payment.id, amount: value, method, paid, clientPrice: o.clientPrice, ...(toPaid ? { status: { from: o.status, to: "paid" } } : {}) },
    });
    const owners = (await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect()).map((u) => u._id);
    await notify(ctx, owners, `Оплата по заказу №${o.number}: ${money(value)}`, { link: `/orders/${id}`, tone: "ok", except: me._id });
  },
});

/** Публикация возвращает, скольким мастерам ушло уведомление: ноль — повод назначить вручную. */
export const changeStatus = mutation({
  args: { id: v.id("orders"), to: orderStatus, reason: v.optional(v.string()) },
  handler: async (ctx, { id, to, reason }): Promise<{ notified: number } | null> => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (!STAFF_TRANSITIONS[o.status].includes(to)) throw new ConvexError(`Из статуса «${ORDER_STATUS[o.status].label}» нельзя перейти в «${ORDER_STATUS[to].label}»`);
    const why = reason?.trim().slice(0, 300) || undefined;
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
    // Остаток, который «Оплачен» отмечает сам, — виден в истории и в журнале отдельной суммой.
    let autoPaid = 0;
    if (to === "paid") {
      const paid = o.payments.reduce((s, p) => s + p.amount, 0);
      if (paid < o.clientPrice) {
        autoPaid = o.clientPrice - paid;
        extra.payments = [...o.payments, { id: uid("p"), amount: autoPaid, method: "kaspi", at: nowIso() }];
        await log(ctx, id, "payment", `Внесена оплата ${money(autoPaid)}`, actor);
      }
    }
    if (to === "cancelled") extra.cancelReason = why ?? "Без причины";
    if (to === "new" && o.status === "cancelled") extra.cancelReason = undefined;
    const reasonOf = to === "cancelled" ? extra.cancelReason : to === "refund" ? why : undefined;
    const published = recipients.length ? `Опубликован в ленту исполнителей — уведомлено: ${recipients.length}` : "Опубликован в ленту исполнителей — подходящих сейчас нет";
    const text = to === "cancelled" ? `Заказ отменён: ${extra.cancelReason}` : to === "awaiting_executor" ? published : to === "refund" && why ? `Оформлен возврат: ${why}` : undefined;
    await setStatus(ctx, o, to, actor, text, extra);
    await audit(
      ctx,
      me,
      to === "awaiting_executor" ? "order.published" : "order.status",
      to === "awaiting_executor"
        ? `Заказ №${o.number}: ${lowerFirst(published)}`
        : `Заказ №${o.number}: «${ORDER_STATUS[o.status].label}» → «${ORDER_STATUS[to].label}»${reasonOf ? ` (${reasonOf})` : ""}${autoPaid ? `; остаток ${money(autoPaid)} отмечен оплаченным` : ""}`,
      {
        entityId: id,
        meta: { from: o.status, to, ...(to === "awaiting_executor" ? { notified: recipients.length } : {}), ...(reasonOf ? { reason: reasonOf } : {}), ...(autoPaid ? { autoPayment: autoPaid } : {}) },
      },
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
    const previous = o.executorId ? await ctx.db.get(o.executorId) : null;
    if (o.executorId) {
      await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Заказ №${o.number} передан другому исполнителю`, { link: "/w", tone: "warn" });
    }
    const fit = fitsOrder(e, o);
    const outside = fit.fits ? "" : ` (вне подбора: ${fit.reasons.join("; ")})`;
    await ctx.db.patch(id, { executorId, assignedAt: nowIso(), status: "assigned" });
    await log(ctx, id, "assigned", `Назначен исполнитель: ${shortName(e.name)}${outside}`, userActor(me._id));
    await audit(ctx, me, "order.assigned", `Заказ №${o.number}: назначен ${shortName(e.name)}${previous ? ` вместо ${shortName(previous.name)}` : ""}${outside}`, {
      entityId: id,
      meta: { executorId, previousExecutorId: o.executorId, fits: fit.fits, reasons: fit.reasons },
    });
    await notifyAssigned(ctx, (await ctx.db.get(id))!);
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

