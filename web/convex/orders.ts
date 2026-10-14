import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { assertScope, currentUser, inScope, requireRole, scopeOf, TEAM, type Me } from "./lib/access";
import { almatyStamp, audit, lowerFirst, quote } from "./lib/audit";
import { executorUser, log, notify, nowIso, setStatus, staffIds, uid, userActor, type StatusMove } from "./lib/domain";
import { toExecutor, toHistory, toMessage, toOrder, toOrderWithFiles } from "./lib/dto";
import { cleanFileName, fileSigner, takeUpload } from "./lib/files";
import { cleanCity, cleanMoney, cleanText } from "./lib/limits";
import { archiveArgs, archivePage } from "./lib/orderArchive";
import { activeExecutorIds, suitableUsers } from "./lib/matching";
import { hitLimit } from "./lib/rateLimit";
import { finishWork, laterMoment, moneyDate, noteText, notifyPayoutChange, positiveMoney, settle } from "./lib/money";
import { districtFor } from "./lib/districts";
import { baseTerms, rateTerms } from "./lib/rates";
import { refreshStats } from "./lib/stats";
import { ACTIVE_STATUSES, ORDER_STATUS, PAYMENT_METHODS, STAFF_TRANSITIONS, URGENCY, type Category } from "../src/data/catalog";
import { loadCatalog } from "./catalog";
import { announceOrder, notifyAssigned } from "./worker";
import { orderNotice } from "./clientNotify";
import { fitsOrder, isOpenForFeed, margin, paidAmount, payout } from "../src/data/logic";
import { closeProblems, INFO_WATCH_STATUSES, OWNER_MONEY_STATUSES, PAYMENT_BLOCKED } from "../src/data/money";
import { catalogSkills, normalizeSkills, skillsDiff, SKILLS_PER_CATEGORY, textKey } from "../src/data/skills";
import { money, shortName } from "../src/lib/format";
import { messageChannel, orderStatus, paymentMethod, urgency } from "./schema";

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
    // Глубина — от 1 до 120 дней: запрос «за всё время» упёрся бы в лимиты чтения (аудит M-2).
    const d = Math.min(Math.max(Math.round(typeof days === "number" && Number.isFinite(days) ? days : 45), 1), 120);
    const since = new Date(Date.now() - d * 86400_000).toISOString();
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

/**
 * Архив заказов (ТЗ п.27.8, E13): все заказы за всё время с фильтрами, страницами (usePaginatedQuery), новые сверху.
 * Руководитель — только свои направления; суммы заказов — только владельцу (lib/orderArchive.ts).
 */
export const list = query({
  args: { paginationOpts: paginationOptsValidator, ...archiveArgs },
  handler: async (ctx, { paginationOpts, ...filters }) => archivePage(ctx, await requireRole(ctx, TEAM), filters, paginationOpts),
});

/** Карточка заказа. t — метка обновления подписанных ссылок на файлы (src/data/files.ts). */
export const detail = query({
  args: { id: v.id("orders"), t: v.optional(v.number()) },
  handler: async (ctx, { id }) => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const o = await ctx.db.get(id);
    if (!o || !inScope(scope, o.category)) return null;
    const [client, messages, history, all, active, reachable] = await Promise.all([
      ctx.db.get(o.clientId),
      ctx.db.query("messages").withIndex("by_order", (q) => q.eq("orderId", id)).collect(),
      ctx.db.query("history").withIndex("by_order", (q) => q.eq("orderId", id)).collect(),
      ctx.db.query("executors").collect(),
      activeOrders(ctx),
      activeExecutorIds(ctx),
    ]);
    // Мастера с отключённым доступом в подбор не попадают; назначенный остаётся в списке — для подписи.
    const executors = all.filter((e) => reachable.has(e._id) || e._id === o.executorId);
    const signer = await fileSigner(ctx);
    // Отметка «видно мастеру» у вложений переписки — по файлам заказа: их переключает «Показать мастеру».
    const shown = new Set(o.files.filter((f) => f.forExecutor === true).map((f) => f.id));
    return {
      order: toOrderWithFiles(o, signer),
      client: client ? { id: client._id, name: client.name, phone: client.phone } : null,
      messages: messages.map((m) => toMessage(m, signer, shown)),
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
const INFO_FIELDS = { serviceId: "услуга", description: "описание", city: "город", district: "район", address: "адрес", deadline: "срок", priority: "приоритет" } as const;
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
    case "district":
      return `район ${before.district ?? "—"} → ${after.district ?? "—"}`;
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
    /** Район города (ТЗ п.12.3); пустая строка — без района. Не передан — прежний, если город тот же. */
    district: v.optional(v.string()),
  },
  handler: async (ctx, { id, requiredSkills, district, ...a }) => {
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

    const city = cleanCity(a.city);
    const info: Info = {
      serviceId: a.serviceId,
      description: cleanText(a.description, 4000, "Описание"),
      city,
      // Сменили город — прежний район к нему не относится; тот же район того же города не перепроверяем
      // (владелец мог убрать его из справочника — заказ от этого не ломается).
      district: city === o.city && (district === undefined || district === (o.district ?? "")) ? o.district : await districtFor(ctx, city, district),
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
    // Исполнитель уже принял заказ — о новом сроке, адресе или описании он узнаёт сразу и с разницей (E7).
    const exUser = changed.length && o.executorId && INFO_WATCH_STATUSES.includes(o.status) ? await executorUser(ctx, o.executorId) : null;
    const executorNotified = !!exUser && exUser.active !== false;
    if (executorNotified) {
      const what = changed.map((k) => (k === "description" ? "описание изменено — откройте заказ" : infoChange(k, o, info, catalog.label)));
      await notify(ctx, [exUser._id], `Заказ №${o.number} изменён: ${what.join("; ")}`, { link: `/w/orders/${id}`, tone: "warn" });
    }
    if (changed.length) await log(ctx, id, "edited", `Изменены данные заказа: ${details.join("; ")}${executorNotified ? " — исполнитель уведомлён" : ""}`, actor);
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
      await audit(ctx, me, changed.length ? "order.info" : "order.skills", `Заказ №${o.number}: ${parts.join("; ")}${executorNotified ? "; исполнитель уведомлён" : ""}`, {
        entityId: id,
        meta: { changes, ...(skillsChanged ? { skills, added: diff.added, removed: diff.removed } : {}), notified, ...(executorNotified ? { executorNotified: true } : {}) },
      });
    }
    return { notified };
  },
});

/** Деньги оплаченного, закрытого и возвращённого заказа — только владельцу (аудит L-4). */
function assertMoneyEditable(me: Me, o: Doc<"orders">, what: string) {
  if (OWNER_MONEY_STATUSES.includes(o.status) && me.role !== "owner") throw new ConvexError(`${what} оплаченного, закрытого или возвращённого заказа меняет только владелец`);
}

/** «Переход «Выполнен» → «Ожидает оплаты»» — для текста журнала. */
const moveText = (m: StatusMove) => `«${ORDER_STATUS[m.from].label}» → «${ORDER_STATUS[m.to].label}»`;

/**
 * Финансы меняет только сотрудник (ТЗ: AI и исполнитель не трогают деньги). Исполнитель, за которым заказ, сразу узнаёт
 * о новой выплате (E7); после сдачи работы новая цена пересчитывает «Оплачен» ↔ «Ожидает оплаты» (E4).
 */
export const updateFinance = mutation({
  args: {
    id: v.id("orders"),
    clientPrice: v.number(),
    payoutMode: v.union(v.literal("fixed"), v.literal("percent")),
    payoutValue: v.number(),
    /** Выплату исполнителю проводят реестром (payouts.create). Поле оставлено для старых клиентов: менять им нельзя. */
    payoutPaid: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, payoutPaid, ...f }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    assertMoneyEditable(me, o, "Финансы");
    if (payoutPaid !== undefined && payoutPaid !== o.payoutPaid) throw new ConvexError("Выплату исполнителю проводят в разделе «Выплаты мастерам» — так она попадает в реестр выплат");
    if (f.clientPrice < 0 || f.payoutValue < 0 || !Number.isFinite(f.clientPrice) || !Number.isFinite(f.payoutValue)) throw new ConvexError("Суммы не могут быть отрицательными");
    if (f.payoutMode === "percent" && f.payoutValue > 100) throw new ConvexError("Процент не больше 100");
    // Деньги храним в целых тенге — проверяем ровно то, что сохраним.
    const next = {
      clientPrice: cleanMoney(f.clientPrice, "Цена клиента"),
      payoutMode: f.payoutMode,
      payoutValue: f.payoutMode === "fixed" ? cleanMoney(f.payoutValue, "Выплата исполнителю") : f.payoutValue,
    };
    if (payout(next) > next.clientPrice) throw new ConvexError("Выплата исполнителю больше цены клиента — маржа уйдёт в минус");
    // Выплату по реестру уже провели — её сумма зафиксирована; отменить выплату можно в «Выплатах мастерам» в течение суток.
    if (o.payoutPaid && payout(next) !== payout(o)) throw new ConvexError(`Исполнителю уже выплачено ${money(payout(o))} — эта сумма зафиксирована. Меняя цену, оставьте выплату прежней (фиксированной суммой)`);
    if (next.clientPrice === o.clientPrice && next.payoutMode === o.payoutMode && next.payoutValue === o.payoutValue) return;
    // Выплату поменяли руками — это ручная правка заказа (ТЗ п.13): ставки мастеров к нему больше не применяются.
    const manual = next.payoutMode !== o.payoutMode || next.payoutValue !== o.payoutValue;
    await ctx.db.patch(id, { ...next, ...(manual ? { payoutManual: true, payoutBase: undefined } : {}) });

    const actor = userActor(me._id);
    const fresh = (await ctx.db.get(id))!;
    const executorNotified = await notifyPayoutChange(ctx, fresh, payout(o), payout(next));
    const before = `${money(o.clientPrice)} / ${money(payout(o))}`;
    const after = `${money(next.clientPrice)} / ${money(payout(next))}`;
    if (after !== before) await log(ctx, id, "finance", `Финансы: ${before} → ${after}${executorNotified ? " — исполнитель уведомлён" : ""}`, actor);
    const settled = await settle(ctx, fresh);
    // ТЗ п.13: в журнале — цена клиента, выплата и маржа «было → стало», чтобы любую правку денег можно было восстановить.
    const parts = [`цена клиента ${moneyMove(money(o.clientPrice), money(next.clientPrice))}`, `выплата ${moneyMove(payoutText(o), payoutText(next))}`, `маржа ${moneyMove(money(margin(o)), money(margin(next)))}`];
    if (executorNotified) parts.push("исполнитель уведомлён");
    if (settled) parts.push(`статус ${moveText(settled)}`);
    const snapshot = (x: typeof next) => ({ ...x, payout: payout(x), margin: margin(x) });
    await audit(ctx, me, "order.finance", `Заказ №${o.number}: ${parts.join(", ")}`, {
      entityId: id,
      meta: {
        before: snapshot({ clientPrice: o.clientPrice, payoutMode: o.payoutMode, payoutValue: o.payoutValue }),
        after: snapshot(next),
        ...(o.acceptedPayout !== undefined ? { acceptedPayout: o.acceptedPayout } : {}),
        ...(executorNotified ? { executorNotified: true } : {}),
        ...(settled ? { status: settled } : {}),
      },
    });
  },
});

/**
 * Оплата клиента (ТЗ п.13): сумма, способ, дата (по умолчанию — сейчас; задним числом — можно), комментарий, кто внёс.
 * Не принимаем в новом заказе, в ленте, в отменённом и в возврате (E3); переплата — только с явным подтверждением;
 * оплаченный и закрытый заказ — только владелец (L-4). Оплатили всё после сдачи работы — заказ сам «Оплачен».
 */
export const addPayment = mutation({
  args: { id: v.id("orders"), amount: v.number(), method: paymentMethod, paidAt: v.optional(v.string()), note: v.optional(v.string()), confirmOverpay: v.optional(v.boolean()) },
  handler: async (ctx, { id, amount, method, paidAt, note, confirmOverpay }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    const blocked = PAYMENT_BLOCKED[o.status];
    if (blocked) throw new ConvexError(blocked);
    assertMoneyEditable(me, o, "Оплаты");
    const value = positiveMoney(amount, "Оплата");
    const at = moneyDate(paidAt, "Дата оплаты", o.createdAt);
    const comment = noteText(note, "Комментарий к оплате");
    const paid = paidAmount(o) + value;
    const over = paid - o.clientPrice;
    if (over > 0 && !confirmOverpay) throw new ConvexError(`Оплата больше цены заказа на ${money(over)} — подтвердите переплату`);
    const payment = { id: uid("p"), amount: value, method, at, by: me._id, ...(comment ? { note: comment } : {}) };
    await ctx.db.patch(id, { payments: [...o.payments, payment], moneyAt: laterMoment(o.moneyAt, at) });
    const backdated = Math.abs(Date.now() - Date.parse(at)) > 10 * 60_000;
    const details = [PAYMENT_METHODS[method], ...(backdated ? [`дата оплаты ${almatyStamp(at)}`] : []), ...(over > 0 ? [`переплата ${money(over)}`] : [])];
    await log(ctx, id, "payment", `Внесена оплата ${money(value)} (${details.join(", ")})`, userActor(me._id));
    const settled = await settle(ctx, (await ctx.db.get(id))!);
    await audit(ctx, me, "order.payment", `Заказ №${o.number}: оплата ${money(value)} (${details.join(", ")}), оплачено ${money(paid)} из ${money(o.clientPrice)}${settled ? `; статус ${moveText(settled)}` : ""}`, {
      entityId: id,
      meta: { paymentId: payment.id, amount: value, method, at, paid, clientPrice: o.clientPrice, ...(over > 0 ? { overpay: over } : {}), ...(settled ? { status: settled } : {}) },
    });
    const owners = (await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect()).map((u) => u._id);
    await notify(ctx, owners, `Оплата по заказу №${o.number}: ${money(value)}`, { link: `/orders/${id}`, tone: "ok", except: me._id, email: { kind: "payment" } });
  },
});

/**
 * Смена статуса сотрудником. Публикация возвращает, скольким мастерам ушло уведомление: ноль — повод назначить вручную.
 * Правила денег (ТЗ п.10, E2): «Выполнен» сам уходит в «Ожидает оплаты» или «Оплачен»; «Оплачен» — только когда оплачено
 * всё (фиктивной оплаты нет); «Закрыт» с долгом или без выплаты исполнителю — только владелец и с причиной;
 * «Возврат» — записью с суммой (finance.addRefund).
 */
export const changeStatus = mutation({
  args: { id: v.id("orders"), to: orderStatus, reason: v.optional(v.string()) },
  handler: async (ctx, { id, to, reason }): Promise<{ notified: number } | null> => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (to === "refund") throw new ConvexError("Возврат оформляется с суммой и причиной — «Оформить возврат» в финансах заказа");
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
        Object.assign(extra, { executorId: undefined, assignedAt: undefined, acceptedPayout: undefined, ...baseTerms(o) });
      }
      // Снятому мастеру уже сообщили — «Новый заказ» ему не шлём.
      recipients = (await suitableUsers(ctx, o)).filter((u) => u !== previous);
    }
    if (to === "paid" && paidAmount(o) < o.clientPrice) throw new ConvexError(`Сначала внесите оплату: не хватает ${money(o.clientPrice - paidAmount(o))}`);
    if (to === "awaiting_payment" && paidAmount(o) >= o.clientPrice) throw new ConvexError("Заказ оплачен полностью — переведите его в «Оплачен»");
    // Закрыть с долгом клиента или без выплаты исполнителю — решение владельца, и причина остаётся в истории.
    const problems = to === "closed" ? closeProblems(o) : [];
    if (problems.length && me.role !== "owner") throw new ConvexError(`Закрыть нельзя: ${problems.join(", ")}. С долгом или без выплаты исполнителю заказ закрывает только владелец`);
    if (problems.length && !why) throw new ConvexError(`Укажите причину закрытия: ${problems.join(", ")}`);
    // Сотрудник отмечает «Принят исполнителем» за мастера — выплата фиксируется так же, как при его подтверждении.
    if (to === "accepted") extra.acceptedPayout = payout(o);
    if (to === "cancelled") extra.cancelReason = why ?? "Без причины";
    // Отменённый заказ открыли заново — он снова ничей: у прежнего мастера он не висит в «Завершённых» (E5).
    if (to === "new" && o.status === "cancelled") {
      Object.assign(extra, { cancelReason: undefined, executorId: undefined, assignedAt: undefined, acceptedPayout: undefined, autoOffered: undefined, autoAssignedAt: undefined, autoExhaustedAt: undefined, ...baseTerms(o) });
    }
    const reasonOf = to === "cancelled" ? extra.cancelReason : problems.length ? why : undefined;
    const published = recipients.length ? `Опубликован в ленту исполнителей — уведомлено: ${recipients.length}` : "Опубликован в ленту исполнителей — подходящих сейчас нет";
    const text =
      to === "cancelled" ? `Заказ отменён: ${extra.cancelReason}` : to === "awaiting_executor" ? published : problems.length ? `Заказ закрыт: ${why} (${problems.join(", ")})` : undefined;
    // Сдача работы: «Выполнен», сообщение клиенту и сразу статус по деньгам.
    let settled: StatusMove | null = null;
    if (to === "done") settled = (await finishWork(ctx, o, actor)).settled;
    else await setStatus(ctx, o, to, actor, text, extra);
    // Отмена заказа мастера — в его историю за 90 дней (сдача работы пересчитывает её в finishWork).
    if (to === "cancelled") await refreshStats(ctx, o.executorId);
    await audit(
      ctx,
      me,
      to === "awaiting_executor" ? "order.published" : "order.status",
      to === "awaiting_executor"
        ? `Заказ №${o.number}: ${lowerFirst(published)}`
        : `Заказ №${o.number}: «${ORDER_STATUS[o.status].label}» → «${ORDER_STATUS[to].label}»${settled ? ` → «${ORDER_STATUS[settled.to].label}»` : ""}${reasonOf ? ` (${reasonOf})` : ""}${problems.length ? `; закрыт владельцем: ${problems.join(", ")}` : ""}`,
      {
        entityId: id,
        meta: {
          from: o.status,
          to,
          ...(settled ? { then: settled.to } : {}),
          ...(to === "awaiting_executor" ? { notified: recipients.length } : {}),
          ...(reasonOf ? { reason: reasonOf } : {}),
          ...(problems.length ? { forced: problems } : {}),
        },
      },
    );
    await orderNotice(ctx, id);

    if (to === "awaiting_executor") {
      await announceOrder(ctx, (await ctx.db.get(o._id))!, recipients);
      return { notified: recipients.length };
    }
    // Исполнитель, которого с заказа сняли (заказ открыли заново), про новый статус уже не узнаёт.
    const executorId = "executorId" in extra ? extra.executorId : o.executorId;
    if (executorId) {
      await notify(ctx, [(await executorUser(ctx, executorId))?._id], `Заказ №${o.number}: ${ORDER_STATUS[to].label.toLowerCase()}`, { link: `/w/orders/${o._id}`, tone: to === "cancelled" ? "bad" : "info" });
    }
    return null;
  },
});

/**
 * Ручное назначение (ТЗ п.12). Можно и мимо подбора — человек решает, — но причина попадает в историю.
 * Мастера на выходном назначает только владелец: остальным система этого не даёт.
 * expectedStatus / expectedExecutorId — каким заказ был на экране сотрудника (null — без исполнителя). Если за это время
 * его взял мастер или сменился статус — отказ: устаревший экран не перебивает того, кто только что взял заказ (E6).
 */
export const assign = mutation({
  args: {
    id: v.id("orders"),
    executorId: v.id("executors"),
    expectedStatus: v.optional(orderStatus),
    expectedExecutorId: v.optional(v.union(v.id("executors"), v.null())),
  },
  handler: async (ctx, { id, executorId, expectedStatus, expectedExecutorId }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, id);
    if (expectedExecutorId !== undefined && (o.executorId ?? null) !== expectedExecutorId) {
      const holder = o.executorId ? await ctx.db.get(o.executorId) : null;
      throw new ConvexError(holder ? `Заказ уже у исполнителя ${shortName(holder.name)} — обновите карточку, прежде чем менять` : "Исполнителя с заказа уже сняли — обновите карточку");
    }
    if (expectedStatus !== undefined && o.status !== expectedStatus) throw new ConvexError(`Заказ уже в статусе «${ORDER_STATUS[o.status].label}» — обновите карточку`);
    const e = await ctx.db.get(executorId);
    if (!e) throw new ConvexError("Исполнитель не найден");
    // Уволенному (доступ отключён) заказ не назначаем даже владельцем: он его не увидит, а клиент будет ждать (аудит M-5).
    const eu = await executorUser(ctx, executorId);
    if (!eu || eu.active === false) throw new ConvexError("У исполнителя отключён доступ — назначить его нельзя");
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
    // Выплата — по ставке нового исполнителя (ТЗ п.14.5); он ещё не подтвердил — прежний снимок к нему не относится.
    const terms = rateTerms(o, e, "staff");
    await ctx.db.patch(id, { executorId, assignedAt: nowIso(), status: "assigned", acceptedPayout: undefined, ...terms });
    await log(ctx, id, "assigned", `Назначен исполнитель: ${shortName(e.name)}${outside}`, userActor(me._id), { from: o.status, to: "assigned" });
    await audit(ctx, me, "order.assigned", `Заказ №${o.number}: назначен ${shortName(e.name)}${previous ? ` вместо ${shortName(previous.name)}` : ""}${outside}`, {
      entityId: id,
      meta: { executorId, previousExecutorId: o.executorId, fits: fit.fits, reasons: fit.reasons, payout: payout({ ...o, ...terms }) },
    });
    await notifyAssigned(ctx, (await ctx.db.get(id))!);
  },
});

/** Ссылок на загрузку одному пользователю в час (аудит M-10): хранилище не резиновое. */
const UPLOADS_PER_HOUR = 100;

/** Ссылка для загрузки файла в хранилище Convex. Следующий шаг — files.confirmUpload: тип, размер и владелец. */
export const uploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    if (!(await hitLimit(ctx, `upload:${me._id}`, UPLOADS_PER_HOUR, 3600_000))) throw new ConvexError("Слишком много загрузок подряд — попробуйте через час");
    return ctx.storage.generateUploadUrl();
  },
});

/** Файлов у заказа — не больше (аудит M-10): документ заказа не должен расти до лимита базы. */
export const MAX_ORDER_FILES = 100;
const COMMENT_LOG: Record<Doc<"messages">["channel"], string> = { internal: "Внутренний комментарий", client: "Добавлен комментарий", executor: "Сообщение в переписке с мастером" };

/**
 * Сообщение в заказе. Сотрудник — в заказ своего направления и в любой канал; исполнитель — только в свой заказ и только
 * в переписку «С мастером» (аудит M-6, L-6). Файлы — только свои подтверждённые загрузки (files.confirmUpload), тип и
 * размер сервер берёт из хранилища, а не от клиента.
 */
export const addMessage = mutation({
  args: { orderId: v.id("orders"), text: v.string(), channel: messageChannel, files: v.array(v.object({ storageId: v.id("_storage"), name: v.string() })) },
  handler: async (ctx, { orderId, text, channel, files }) => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    const o = await ctx.db.get(orderId);
    if (!o) throw new ConvexError("Заказ не найден");
    const executor = me.role === "executor";
    // Без executorId сравнение undefined !== undefined пропустило бы в любой свободный заказ (аудит L-6).
    if (executor && (!me.executorId || o.executorId !== me.executorId)) throw new ConvexError("Это не ваш заказ");
    if (executor && channel !== "executor") throw new ConvexError("Мастер пишет только в переписку с офисом");
    if (me.role === "manager") assertScope(me, o.category);
    const body = text.trim().slice(0, 4000);
    if (!body && !files.length) throw new ConvexError("Пустое сообщение");
    if (files.length > 10) throw new ConvexError("Не больше 10 файлов за раз");
    if (o.files.length + files.length > MAX_ORDER_FILES) throw new ConvexError(`В заказе уже ${o.files.length} файлов — больше ${MAX_ORDER_FILES} прикрепить нельзя`);
    const attached: Doc<"orders">["files"] = [];
    for (const f of files) {
      const kind = await takeUpload(ctx, me._id, f.storageId);
      // Переписка с мастером (и его фотоотчёт) видна ему сразу; остальные файлы — по «Показать мастеру».
      attached.push({ id: uid("f"), name: cleanFileName(f.name) || "файл", kind: kind === "image" ? "image" : "file", storageId: f.storageId, ...(channel === "executor" ? { forExecutor: true } : {}) });
    }
    const actor = userActor(me._id);
    await ctx.db.insert("messages", { orderId, author: actor, channel, text: body, files: attached, at: nowIso() });
    if (attached.length) {
      await ctx.db.patch(orderId, { files: [...o.files, ...attached] });
      await log(ctx, orderId, "file", `Добавлено файлов: ${attached.length}`, actor);
    }
    if (body) await log(ctx, orderId, "comment", COMMENT_LOG[channel], actor);
    await notify(ctx, await staffIds(ctx, o.category), executor ? `Мастер написал по заказу №${o.number}` : `Новое сообщение в заказе №${o.number}`, { link: `/orders/${orderId}`, except: me._id });
    // Мастер узнаёт только о переписке с ним: внутренние заметки и переписка по клиенту ему не видны.
    if (channel === "executor" && !executor && o.executorId) {
      await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Офис написал по заказу №${o.number}${body ? `: «${body.slice(0, 120)}»` : ""}`, { link: `/w/orders/${orderId}`, except: me._id });
    }
  },
});

/**
 * «Показать мастеру» у файла заказа (ТЗ п.16, аудит M-6): мастер видит только отмеченные файлы и переписку с ним.
 * Вложения переписки с мастером он и так видит в ней — скрыть их нельзя.
 */
export const setFileForExecutor = mutation({
  args: { orderId: v.id("orders"), fileId: v.string(), forExecutor: v.boolean() },
  handler: async (ctx, { orderId, fileId, forExecutor }) => {
    const me = await requireRole(ctx, TEAM);
    const o = await staffOrder(ctx, orderId);
    const file = o.files.find((f) => f.id === fileId);
    if (!file) throw new ConvexError("Файл не найден");
    if ((file.forExecutor === true) === forExecutor) return;
    if (!forExecutor) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_order", (q) => q.eq("orderId", orderId))
        .collect();
      if (messages.some((m) => m.channel === "executor" && m.files.some((f) => f.id === fileId))) throw new ConvexError("Файл из переписки с мастером — он его уже видит");
    }
    await ctx.db.patch(orderId, { files: o.files.map((f) => (f.id === fileId ? { ...f, forExecutor } : f)) });
    const text = forExecutor ? `Файл «${file.name}» показан исполнителю` : `Файл «${file.name}» скрыт от исполнителя`;
    await log(ctx, orderId, "file", text, userActor(me._id));
    await audit(ctx, me, "order.fileAccess", `Заказ №${o.number}: ${lowerFirst(text)}`, { entityId: orderId, meta: { fileId, forExecutor } });
  },
});

