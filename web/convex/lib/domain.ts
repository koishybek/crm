// Общие шаги мутаций: нумерация, журнал, уведомления (в базе + Telegram), счётчики клиента.
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./functions";
import { ACTIVE_STATUSES, ORDER_STATUS } from "../../src/data/catalog";
import type { Actor, HistoryKind, OrderStatus } from "../../src/data/types";
import { queueEmail, type EmailEvent } from "./mail";
import { orderTouched } from "./stats";
import { queuePush } from "./push";
import type { TgButton } from "./tg";
import { emitEvent } from "./webhookEvents";

export const nowIso = () => new Date().toISOString();
export const uid = (p: string) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
export const userActor = (id: Id<"users">): Actor => ({ type: "user", id });

/** Сквозной номер для заявок и заказов: заявка 1024 → заказ 1024. */
export async function nextNumber(ctx: MutationCtx): Promise<number> {
  const c = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", "number"))
    .unique();
  if (!c) {
    await ctx.db.insert("counters", { name: "number", value: 1001 });
    return 1001;
  }
  await ctx.db.patch(c._id, { value: c.value + 1 });
  return c.value + 1;
}

/** Смена статуса для истории — откуда и куда. */
export type StatusMove = { from: OrderStatus; to: OrderStatus };

/** Запись в историю заказа. Она идёт за каждой правкой заказа — здесь же загрузка мастеров и очередь показателей (lib/stats). */
export async function log(ctx: MutationCtx, orderId: Id<"orders">, kind: HistoryKind, text: string, actor: Actor, move?: StatusMove) {
  await ctx.db.insert("history", { orderId, kind, text, actor, at: nowIso(), ...move });
  // Каждая смена статуса проходит через историю — и через setStatus, и через назначение/взятие: здесь и событие вебхука.
  if (move && move.from !== move.to) await emitEvent(ctx, "order.status_changed", { orderId, from: move.from });
  await orderTouched(ctx, orderId);
}

/** Сотрудники для рассылок по заказам, прочитанные один раз (E22): в цикле по заказам состав не перечитывается. */
export interface StaffRoster {
  /** Все владельцы, в том числе отключённые (notify их пропустит), — для эскалации просрочки. */
  owners: Id<"users">[];
  /** Кому слать события по заказу/заявке: владельцы, операторы и руководители направления, без отключённых. */
  staff(category?: string): Id<"users">[];
}

export async function staffRoster(ctx: QueryCtx): Promise<StaffRoster> {
  const byRole = (role: "owner" | "operator" | "manager") =>
    ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", role))
      .collect();
  const [owners, ops, managers] = await Promise.all([byRole("owner"), byRole("operator"), byRole("manager")]);
  // Список на направление считается один раз за запрос.
  const cache = new Map<string, Id<"users">[]>();
  return {
    owners: owners.map((u) => u._id),
    staff(category) {
      const key = category ?? "";
      let ids = cache.get(key);
      if (!ids) {
        const scoped = category ? managers.filter((u) => u.categories?.includes(category)) : [];
        ids = [...owners, ...ops, ...scoped].filter((u) => u.active !== false).map((u) => u._id);
        cache.set(key, ids);
      }
      return [...ids];
    },
  };
}

/** Кому слать события по заказу/заявке: владельцы, операторы и руководители этого направления. */
export async function staffIds(ctx: QueryCtx, category?: string): Promise<Id<"users">[]> {
  return (await staffRoster(ctx)).staff(category);
}

export async function executorUser(ctx: QueryCtx, executorId: Id<"executors">): Promise<Doc<"users"> | null> {
  return ctx.db
    .query("users")
    .withIndex("by_executor", (q) => q.eq("executorId", executorId))
    .first();
}

export type { TgButton } from "./tg";

/**
 * Уведомление в колокольчик + копия в Telegram (если подключён), на телефон (web push, если включён — lib/push.ts)
 * и на email (важное событие — opts.email, правило — lib/mail.ts). Отправка — после коммита, через планировщик.
 */
export async function notify(
  ctx: MutationCtx,
  userIds: (Id<"users"> | null | undefined)[],
  text: string,
  opts: { link?: string; tone?: Doc<"notifications">["tone"]; except?: Id<"users">; buttons?: TgButton[][]; html?: string; email?: EmailEvent } = {},
) {
  const at = nowIso();
  let emails = 0;
  for (const id of new Set(userIds.filter((x): x is Id<"users"> => !!x))) {
    if (id === opts.except) continue;
    const u = await ctx.db.get(id);
    // Отключённым (уволен, доступ закрыт) — ни колокольчика, ни Telegram, ни писем (аудит M-5).
    if (!u || u.active === false) continue;
    const notificationId = await ctx.db.insert("notifications", { userId: id, text, link: opts.link, at, read: false, tone: opts.tone ?? "info" });
    if (u.telegramChatId) {
      await ctx.scheduler.runAfter(0, internal.telegram.send, { chatId: u.telegramChatId, text, html: opts.html, link: opts.link, buttons: opts.buttons });
    }
    if (opts.email && (await queueEmail(ctx, u, notificationId, { text, link: opts.link, event: opts.email }, emails))) emails++;
    await queuePush(ctx, id, text, opts.link);
  }
}

export async function setStatus(ctx: MutationCtx, o: Doc<"orders">, to: OrderStatus, actor: Actor, text?: string, extra: Partial<Doc<"orders">> = {}) {
  const at = nowIso();
  const patch: Partial<Doc<"orders">> = { status: to, ...extra };
  if (to === "done") patch.doneAt = at;
  if (to === "paid") patch.paidAt = at;
  if (to === "closed") patch.closedAt = at;
  await ctx.db.patch(o._id, patch);
  await log(ctx, o._id, "status", text ?? `Статус изменён на «${ORDER_STATUS[to].label}»`, actor, { from: o.status, to });
  await refreshClient(ctx, o.clientId);
}

/** Пересчёт денормализованных счётчиков клиента по его заказам. */
export async function refreshClient(ctx: MutationCtx, clientId: Id<"clients">) {
  const c = await ctx.db.get(clientId);
  if (!c) return;
  const orders = (
    await ctx.db
      .query("orders")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .collect()
  ).filter((o) => o.status !== "cancelled");
  const lastOrderAt = orders.reduce<string | undefined>((m, o) => (!m || o.createdAt > m ? o.createdAt : m), undefined);
  await ctx.db.patch(clientId, {
    ordersCount: orders.length,
    activeCount: orders.filter((o) => ACTIVE_STATUSES.includes(o.status)).length,
    lastOrderAt,
    lastActivityAt: [c.lastActivityAt, lastOrderAt ?? ""].sort().pop()!,
  });
}

