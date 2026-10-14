import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { EXECUTOR, requireRole } from "./lib/access";
import { audit, lowerFirst } from "./lib/audit";
import { executorUser, log, notify, nowIso, setStatus, staffIds, userActor, type StatusMove } from "./lib/domain";
import { describeForExecutor, executorThread, toExecutor, toMessage, toWorkerOrder } from "./lib/dto";
import { fileSigner } from "./lib/files";
import { loadOf, openOrdersFor, suitableUsers } from "./lib/matching";
import { finishWork } from "./lib/money";
import { baseTerms, rateTerms } from "./lib/rates";
import { recordRefusal } from "./lib/stats90";
import { cardHtml, esc, workerButtons, type CardData } from "./lib/tg";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { applyShift, shiftArgs } from "./executors";
import { orderNotice } from "./clientNotify";
import { contactsOpen, fitsOrder, maxActiveOf, payout, payoutFor } from "../src/data/logic";
import { ACTIVE_STATUSES, ORDER_STATUS } from "../src/data/catalog";
import { districtLabel } from "../src/data/cities";
import { money, plural, shortName } from "../src/lib/format";

async function myExecutor(ctx: Parameters<typeof requireRole>[0]) {
  const me = await requireRole(ctx, EXECUTOR);
  const ex = me.executorId ? await ctx.db.get(me.executorId) : null;
  if (!ex) throw new ConvexError("Профиль исполнителя не найден");
  return { me, ex };
}

/**
 * Лента: свободные заказы, которые мне подходят (ТЗ п.11) — специализация, навыки, город.
 * На выходном и на лимите заказов лента видна, но взять заказ нельзя: load — сколько заказов в работе и лимит.
 */
export const feed = query({
  args: {},
  handler: async (ctx) => {
    const { ex } = await myExecutor(ctx);
    return {
      executor: toExecutor(ex),
      // В ленте — сумма по ставке этого мастера (ТЗ п.14.5): за неё он и возьмёт заказ.
      feed: (await openOrdersFor(ctx, ex)).map((o) => toWorkerOrder(o, { contacts: false, payout: payoutFor(ex.rates, o) })),
      load: { active: await loadOf(ctx, ex._id), max: maxActiveOf(ex) },
    };
  },
});

/** Мои заказы (активные и история) — для «Мои заказы» и «Дохода». */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const { ex } = await myExecutor(ctx);
    const rows = await ctx.db.query("orders").withIndex("by_executor", (q) => q.eq("executorId", ex._id)).collect();
    return {
      executor: toExecutor(ex),
      orders: rows.map((o) => toWorkerOrder(o, { contacts: contactsOpen(o) })),
    };
  },
});

/** Свой заказ: только переписка «С мастером» и файлы, видимые мастеру. t — метка обновления ссылок на файлы (src/data/files.ts). */
export const order = query({
  args: { id: v.id("orders"), t: v.optional(v.number()) },
  handler: async (ctx, { id }) => {
    const { me, ex } = await myExecutor(ctx);
    const o = await ctx.db.get(id);
    if (!o || o.executorId !== ex._id) return null;
    const signer = await fileSigner(ctx);
    const messages = await executorThread(ctx, id, me._id);
    return {
      order: toWorkerOrder(o, { contacts: contactsOpen(o), signer }),
      messages: messages.map((m) => toMessage(m, signer)),
      me: me._id,
    };
  },
});

/**
 * Данные карточки для Telegram. Контакты — только пока заказ у мастера в работе (contactsOpen).
 * sum — сколько получит этот мастер, если заказ ещё не его (лента, «Новый заказ»); иначе — выплата заказа.
 */
export async function cardOf(ctx: QueryCtx, o: Doc<"orders">, contacts: boolean, sum?: number): Promise<CardData> {
  const cat = await loadCatalog(ctx);
  return {
    id: o._id,
    number: o.number,
    service: cat.label(o.serviceId),
    city: o.city,
    deadline: o.deadline,
    payout: sum ?? payout(o),
    description: describeForExecutor(o.description, contacts),
    status: o.status,
    urgent: o.priority === "urgent",
    ...(contacts ? { address: o.address || undefined, clientName: o.clientName, clientPhone: o.clientPhone } : {}),
  };
}

/**
 * «Новый заказ» мастерам (ТЗ п.18): колокольчик + карточка с кнопкой «Взять заказ» в Telegram.
 * Получателей считает вызывающий (suitableUsers) — так он может исключить тех, кому слать не нужно.
 * again — заказ вернулся в ленту (мастер отказался), а не появился впервые.
 */
export async function announceOrder(ctx: MutationCtx, o: Doc<"orders">, users: Id<"users">[], opts: { again?: boolean } = {}): Promise<void> {
  if (!users.length) return;
  const service = (await loadCatalog(ctx)).label(o.serviceId);
  const title = opts.again ? `Снова свободен заказ №${o.number}` : `Новый заказ №${o.number}`;
  const where = o.district ? `${o.city}, ${districtLabel(o.district)}` : o.city;
  // У каждого мастера своя ставка (ТЗ п.14.5): одно сообщение на одну сумму.
  const bySum = new Map<number, Id<"users">[]>();
  for (const id of users) {
    const u = await ctx.db.get(id);
    const ex = u?.executorId ? await ctx.db.get(u.executorId) : null;
    const sum = payoutFor(ex?.rates, o);
    bySum.set(sum, [...(bySum.get(sum) ?? []), id]);
  }
  for (const [sum, to] of bySum) {
    await notify(ctx, to, `${title}: ${service}, ${where}. Оплата исполнителю ${money(sum)}`, {
      link: `/w/orders/${o._id}`,
      html: cardHtml(await cardOf(ctx, o, false, sum), `${opts.again ? "🔁" : "🆕"} ${title}`),
      buttons: workerButtons("awaiting_executor", o._id),
    });
  }
}

/**
 * Заказы из ленты, чья услуга переехала в другое направление (catalog.saveService, E10): «Новый заказ» тем мастерам,
 * кому заказ подходит теперь, но не подходил раньше.
 */
export const _announceMoved = internalMutation({
  args: { ids: v.array(v.id("orders")), fromCategory: v.string() },
  handler: async (ctx, { ids, fromCategory }): Promise<number> => {
    let sent = 0;
    for (const id of ids) {
      const o = await ctx.db.get(id);
      if (!o || o.status !== "awaiting_executor" || o.executorId || o.category === fromCategory) continue;
      const before = new Set(await suitableUsers(ctx, { ...o, category: fromCategory }));
      const added = (await suitableUsers(ctx, o)).filter((u) => !before.has(u));
      await announceOrder(ctx, o, added);
      sent += added.length;
    }
    return sent;
  },
});

/**
 * «Вам назначен заказ» мастеру (ТЗ п.12, п.18): колокольчик + карточка в Telegram с кнопками «Подтвердить / Отказаться».
 * Одно сообщение для ручного назначения и автораспределения; note — что добавить к просьбе подтвердить.
 */
export async function notifyAssigned(ctx: MutationCtx, o: Doc<"orders">, opts: { note?: string } = {}): Promise<void> {
  if (!o.executorId) return;
  const service = (await loadCatalog(ctx)).label(o.serviceId);
  const card = cardHtml(await cardOf(ctx, o, false), `📌 Вам назначен заказ №${o.number}`);
  await notify(ctx, [(await executorUser(ctx, o.executorId))?._id], `Вам назначен заказ №${o.number}: ${service}. ${opts.note ?? "Подтвердите в кабинете"}`, {
    link: `/w/orders/${o._id}`,
    tone: "warn",
    html: opts.note ? `${card}\n\n<b>${esc(opts.note)}</b>` : card,
    buttons: workerButtons("assigned", o._id, env("APP_URL")),
  });
}

/**
 * «Взять заказ». Мутации Convex — сериализуемые транзакции: если двое нажали одновременно,
 * вторая транзакция перечитает заказ, увидит executorId и получит отказ.
 * Подходит ли заказ — проверяем здесь заново: прямой вызов мимо ленты не должен пройти.
 */
export async function takeFor(ctx: MutationCtx, userId: Id<"users">, orderId: Id<"orders">): Promise<Doc<"orders">> {
  const me = await ctx.db.get(userId);
  if (!me || me.role !== "executor" || me.active === false || !me.executorId) throw new ConvexError("Нет доступа");
  const ex = await ctx.db.get(me.executorId);
  if (!ex) throw new ConvexError("Профиль исполнителя не найден");
  const o = await ctx.db.get(orderId);
  if (!o) throw new ConvexError("Заказ не найден");
  if (o.executorId) throw new ConvexError(o.executorId === ex._id ? "Этот заказ уже ваш" : "Этот заказ уже взял другой исполнитель");
  if (o.status !== "awaiting_executor") throw new ConvexError("Заказ уже снят с ленты");
  if (!ex.available) throw new ConvexError("Сначала включите приём заказов в профиле");
  // Лимит заказов в работе (ТЗ п.14, E9): больше мастер не успеет — новый заказ он возьмёт, когда сдаст текущий.
  const load = await loadOf(ctx, ex._id);
  const max = maxActiveOf(ex);
  if (load >= max) throw new ConvexError(`У вас уже ${load} ${plural(load, "заказ", "заказа", "заказов")} в работе — это ваш лимит. Завершите текущий, чтобы взять новый`);
  const fit = fitsOrder(ex, o, load);
  if (!fit.fits) throw new ConvexError(`Этот заказ вам не подходит (${fit.reasons.join("; ")})`);
  // Выплата — по ставке мастера (ТЗ п.14.5); acceptedPayout — сумма, за которую он взялся: дальше любая её правка
  // приходит ему уведомлением (E7).
  const terms = rateTerms(o, ex, "executor");
  const sum = payout({ ...o, ...terms });
  await ctx.db.patch(orderId, { executorId: ex._id, assignedAt: nowIso(), status: "accepted", acceptedPayout: sum, ...terms });
  await log(ctx, orderId, "taken", "Исполнитель взял заказ из ленты", userActor(me._id), { from: o.status, to: "accepted" });
  await audit(ctx, me, "order.taken", `${shortName(ex.name)} взял заказ №${o.number} из ленты`, { entityId: orderId, meta: { executorId: ex._id } });
  await notify(ctx, await staffIds(ctx, o.category), `${shortName(ex.name)} взял заказ №${o.number}`, { link: `/orders/${orderId}`, tone: "ok", email: { kind: "order_assigned" } });
  await orderNotice(ctx, orderId);
  return (await ctx.db.get(orderId))!;
}

export const take = mutation({
  args: { id: v.id("orders") },
  handler: async (ctx, { id }) => {
    const me = await requireRole(ctx, EXECUTOR);
    const o = await takeFor(ctx, me._id, id);
    return { number: o.number };
  },
});

const FLOW = {
  accept: { from: ["assigned"], to: "accepted", text: "Исполнитель подтвердил заказ" },
  decline: { from: ["assigned", "accepted"], to: "awaiting_executor", text: "Исполнитель отказался, заказ вернулся в ленту" },
  start: { from: ["accepted"], to: "in_progress", text: "Статус изменён на «В работе»" },
  wait: { from: ["in_progress"], to: "awaiting_client", text: "Статус изменён на «Ожидает клиента»" },
  resume: { from: ["awaiting_client"], to: "in_progress", text: "Статус изменён на «В работе»" },
  done: { from: ["in_progress", "awaiting_client"], to: "done", text: "Работа выполнена" },
} as const;
export type ExecAction = keyof typeof FLOW;
const actionArg = v.union(v.literal("accept"), v.literal("decline"), v.literal("start"), v.literal("wait"), v.literal("resume"), v.literal("done"));

/** Шаг мастера по заказу — одна функция для кабинета и Telegram. */
export async function actFor(ctx: MutationCtx, userId: Id<"users">, id: Id<"orders">, action: ExecAction): Promise<Doc<"orders">> {
  const me = await ctx.db.get(userId);
  if (!me || me.role !== "executor" || me.active === false || !me.executorId) throw new ConvexError("Нет доступа");
  const ex = await ctx.db.get(me.executorId);
  const o = await ctx.db.get(id);
  if (!ex || !o || o.executorId !== ex._id) throw new ConvexError("Это не ваш заказ");
  const step = FLOW[action];
  if (!(step.from as readonly string[]).includes(o.status)) throw new ConvexError("Статус уже изменился — обновите заказ");
  // Подтвердил — фиксируем выплату, на которую он согласился; отказался — заказ снова ничей.
  // Отказ возвращает заказу его условия выплаты: ставка ушедшего мастера к следующему не относится.
  const extra: Partial<Doc<"orders">> =
    action === "decline" ? { executorId: undefined, assignedAt: undefined, acceptedPayout: undefined, ...baseTerms(o) } : action === "accept" ? { acceptedPayout: payout(o) } : {};
  const actor = userActor(me._id);
  // «Работа выполнена»: клиенту — «заказ выполнен», статус сразу по деньгам — «Ожидает оплаты» или «Оплачен».
  let settled: StatusMove | null = null;
  if (action === "done") settled = (await finishWork(ctx, o, actor, step.text)).settled;
  else await setStatus(ctx, o, step.to, actor, step.text, extra);
  // Отказ — в историю мастера за 90 дней (ТЗ п.12.6): подбор учитывает его при следующих заказах.
  if (action === "decline") await recordRefusal(ctx, ex._id);
  await audit(ctx, me, action === "decline" ? "order.declined" : "order.status", `Заказ №${o.number}: ${lowerFirst(step.text)} (${shortName(ex.name)})${settled ? `, статус «${ORDER_STATUS[settled.to].label}»` : ""}`, {
    entityId: id,
    meta: { from: o.status, to: step.to, ...(settled ? { then: settled.to } : {}) },
  });
  const tone = action === "decline" ? "warn" : action === "done" ? "ok" : "info";
  await notify(ctx, await staffIds(ctx, o.category), `Заказ №${o.number}: ${lowerFirst(step.text)} (${shortName(ex.name)})`, { link: `/orders/${id}`, tone });
  const fresh = (await ctx.db.get(id))!;
  await orderNotice(ctx, id);
  // Отказ вернул заказ в ленту — остальные подходящие мастера должны узнать, что он снова свободен.
  if (action === "decline") await announceOrder(ctx, fresh, (await suitableUsers(ctx, fresh)).filter((u) => u !== me._id), { again: true });
  return fresh;
}

export const act = mutation({
  args: { id: v.id("orders"), action: actionArg },
  handler: async (ctx, { id, action }) => {
    const me = await requireRole(ctx, EXECUTOR);
    await actFor(ctx, me._id, id, action);
  },
});

/** «Принимаю заказы» / «Не принимаю» — сам мастер; until — «не принимаю до …» (сам вернётся на смену в это время). */
export const setAvailable = mutation({
  args: shiftArgs,
  handler: async (ctx, a) => {
    const { me, ex } = await myExecutor(ctx);
    await applyShift(ctx, ex, a, me, "executor");
  },
});

// ── Telegram: те же действия по chat_id привязанного мастера ────────────────

type TgResult = { ok: true; card: CardData } | { ok: false; error: string };

async function chatUser(ctx: QueryCtx, chatId: string) {
  const u = await ctx.db.query("users").withIndex("by_telegram_chat", (q) => q.eq("telegramChatId", chatId)).first();
  return u && u.active !== false ? u : null;
}

const errText = (e: unknown) => (e instanceof ConvexError ? String(e.data) : "Не получилось — попробуйте в кабинете");

export const takeFromTelegram = internalMutation({
  args: { chatId: v.string(), orderId: v.string() },
  handler: async (ctx, { chatId, orderId }): Promise<TgResult> => {
    const u = await chatUser(ctx, chatId);
    if (!u) return { ok: false, error: "Telegram не привязан к аккаунту" };
    const id = ctx.db.normalizeId("orders", orderId);
    if (!id) return { ok: false, error: "Заказ не найден" };
    try {
      const o = await takeFor(ctx, u._id, id);
      return { ok: true, card: await cardOf(ctx, o, contactsOpen(o)) };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  },
});

export const actFromTelegram = internalMutation({
  args: { chatId: v.string(), orderId: v.string(), action: actionArg },
  handler: async (ctx, { chatId, orderId, action }): Promise<TgResult> => {
    const u = await chatUser(ctx, chatId);
    if (!u) return { ok: false, error: "Telegram не привязан к аккаунту" };
    const id = ctx.db.normalizeId("orders", orderId);
    if (!id) return { ok: false, error: "Заказ не найден" };
    try {
      const o = await actFor(ctx, u._id, id, action);
      return { ok: true, card: await cardOf(ctx, o, contactsOpen(o)) };
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  },
});

/**
 * Для /orders и /feed в боте: кто пишет и что ему показать.
 * available=false — мастер на выходном: лента пуста не потому, что заказов нет.
 */
export const _forChat = internalQuery({
  args: { chatId: v.string(), what: v.union(v.literal("orders"), v.literal("feed")) },
  handler: async (ctx, { chatId, what }): Promise<{ role: string | null; name: string; cards: CardData[]; available?: boolean }> => {
    const u = await chatUser(ctx, chatId);
    if (!u) return { role: null, name: "", cards: [] };
    if (u.role !== "executor" || !u.executorId) return { role: u.role ?? null, name: u.name ?? "", cards: [] };
    const ex = await ctx.db.get(u.executorId);
    if (!ex) return { role: u.role, name: u.name ?? "", cards: [] };
    const rows =
      what === "feed"
        ? await openOrdersFor(ctx, ex)
        : (await ctx.db.query("orders").withIndex("by_executor", (q) => q.eq("executorId", ex._id)).collect()).filter((o) => ACTIVE_STATUSES.includes(o.status));
    rows.sort((a, b) => a.deadline.localeCompare(b.deadline));
    return {
      role: u.role,
      name: u.name ?? "",
      available: ex.available,
      cards: await Promise.all(rows.slice(0, 8).map((o) => (what === "feed" ? cardOf(ctx, o, false, payoutFor(ex.rates, o)) : cardOf(ctx, o, contactsOpen(o))))),
    };
  },
});
