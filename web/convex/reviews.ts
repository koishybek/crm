// Отзывы клиентов и рейтинг мастера (ТЗ п.14 «Рейтинг и отзывы», п.29 «закрытие → рейтинг»).
// Оценку оставляет клиент по одноразовой ссылке, сотрудник со слов клиента или канал (Telegram, WhatsApp).
// Один отзыв на заказ; рейтинг мастера пересчитывается в той же мутации, что и отзыв.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { inScope, requireRole, scopeOf, STAFF, TEAM, type Me } from "./lib/access";
import { almatyStamp, audit, type AuditActor } from "./lib/audit";
import { log, notify, nowIso, TENANT, userActor } from "./lib/domain";
import { hitLimit } from "./lib/rateLimit";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import {
  bayesianRating,
  checkReview,
  isReviewable,
  LOW_RATING,
  REVIEW_EDIT_DAYS,
  REVIEW_LINK_DAYS,
  REVIEW_VIA,
  type ExecutorReviewsInfo,
  type OrderReviewInfo,
  type ReviewLinkInfo,
  type ReviewLinkState,
  type ReviewSubmitResult,
  type ReviewView,
} from "../src/data/reviews";
import type { ReviewVia } from "../src/data/types";
import { firstName, shortName } from "../src/lib/format";

const DAY_MS = 86400_000;
/** Токен ссылки — 24 случайных байта в base64url (32 символа): угадать или перебрать нельзя. */
const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
/** Попыток отправить оценку по одной ссылке за час: защита от флуда и перебора оценок. */
const SUBMIT_LIMIT = { max: 10, windowMs: 3600_000 };
/** Последних отзывов в карточке мастера. */
const EXECUTOR_LATEST = 20;

const LINK_ERROR: Record<Exclude<ReviewLinkState, "ok">, string> = {
  used: "По этому заказу оценка уже получена — спасибо!",
  expired: "Срок действия ссылки истёк",
  invalid: "Ссылка не найдена",
};

function newToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Ссылка для клиента: адрес приложения из APP_URL; без него — относительная, интерфейс допишет свой адрес. */
const reviewUrl = (token: string): string => `${env("APP_URL")?.replace(/\/+$/, "") ?? ""}/otzyv/${token}`;

const toView = (r: Doc<"reviews">, orderNumber?: number): ReviewView => ({
  id: r._id,
  orderId: r.orderId,
  executorId: r.executorId,
  clientId: r.clientId,
  rating: r.rating,
  text: r.text,
  via: r.via,
  at: r.at,
  authorId: r.authorId,
  orderNumber,
});

const reviewOf = (ctx: QueryCtx, orderId: Id<"orders">): Promise<Doc<"reviews"> | null> =>
  ctx.db
    .query("reviews")
    .withIndex("by_order", (q) => q.eq("orderId", orderId))
    .first();

/** Заказ для оценки сотрудником: выполнен (и дальше по пути до «Закрыт») и с мастером. */
async function reviewableOrder(ctx: QueryCtx, orderId: Id<"orders">): Promise<Doc<"orders">> {
  const o = await ctx.db.get(orderId);
  if (!o) throw new ConvexError("Заказ не найден");
  if (!isReviewable(o)) throw new ConvexError("Оценку можно получить после выполнения заказа");
  return o;
}

/** Рейтинг мастера заново по всем его отзывам. Пока отзывов нет — прежние значения не трогаем. */
async function recomputeRating(ctx: MutationCtx, executorId: Id<"executors">): Promise<void> {
  const ratings = (
    await ctx.db
      .query("reviews")
      .withIndex("by_executor", (q) => q.eq("executorId", executorId))
      .collect()
  ).map((r) => r.rating);
  if (!ratings.length) return;
  await ctx.db.patch(executorId, { rating: bayesianRating(ratings), reviews: ratings.length });
}

/** Низкая оценка — владельцам и руководителям направления заказа: разобраться, пока клиент на связи. Возвращает, скольким ушло. */
async function alertLowRating(ctx: MutationCtx, o: Doc<"orders">, rating: number, executor: string, text: string | undefined, except?: Id<"users">): Promise<number> {
  const owners = await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect();
  const managers = (await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "manager")).collect()).filter((u) => u.categories?.includes(o.category));
  const ids = [...owners, ...managers].filter((u) => u.active !== false && u._id !== except).map((u) => u._id);
  const comment = text ? `: «${text.length > 100 ? `${text.slice(0, 99)}…` : text}»` : "";
  const title = `Низкая оценка ${rating}★ по заказу №${o.number} — мастер ${shortName(executor)}`;
  // В письме — без слов клиента: письма хранит почтовый сервис за рубежом.
  await notify(ctx, ids, `${title}${comment}`, { link: `/orders/${o._id}`, tone: "bad", email: { kind: "low_rating", text: title } });
  return ids.length;
}

const ratingMove = (from: number, to: number) => (from === to ? `${to.toFixed(1)}` : `${from.toFixed(1)} → ${to.toFixed(1)}`);

interface NewReview {
  rating: number;
  text?: string;
  via: ReviewVia;
  /** Сотрудник, записавший оценку со слов клиента. */
  author?: Me;
  /** Автор записи в журнале: сотрудник или канал («Сайт», «Telegram», «WhatsApp»). */
  actor: AuditActor;
}

/** Новый отзыв: запись, рейтинг мастера, история заказа, уведомление о низкой оценке и журнал — одной транзакцией. */
async function createReview(ctx: MutationCtx, o: Doc<"orders">, r: NewReview): Promise<Id<"reviews">> {
  const executorId = o.executorId!;
  const before = await ctx.db.get(executorId);
  const id = await ctx.db.insert("reviews", {
    tenantId: TENANT,
    orderId: o._id,
    executorId,
    clientId: o.clientId,
    rating: r.rating,
    text: r.text,
    via: r.via,
    at: nowIso(),
    authorId: r.author?._id,
  });
  await recomputeRating(ctx, executorId);
  const after = await ctx.db.get(executorId);
  const name = after?.name ?? "мастер";
  await log(ctx, o._id, "comment", `Оценка клиента: ${r.rating}★ (${REVIEW_VIA[r.via]})`, r.author ? userActor(r.author._id) : { type: "client", id: o.clientId });
  const low = r.rating <= LOW_RATING;
  const notified = low ? await alertLowRating(ctx, o, r.rating, name, r.text, r.author?._id) : 0;
  // Текст клиента в журнал не копируем — только отметку, что он есть: сам отзыв виден в карточке заказа.
  await audit(
    ctx,
    r.actor,
    "review.created",
    `Заказ №${o.number}: оценка ${r.rating}★ ${REVIEW_VIA[r.via]} — ${shortName(name)}${r.text ? ", с комментарием" : ""}; рейтинг ${ratingMove(before?.rating ?? 0, after?.rating ?? 0)}${low ? `; низкая оценка — уведомлено: ${notified}` : ""}`,
    {
      entityId: o._id,
      meta: { reviewId: id, executorId, rating: r.rating, via: r.via, comment: !!r.text, low, notified, executorRating: { from: before?.rating, to: after?.rating, reviews: after?.reviews } },
    },
  );
  return id;
}

/** Исправление оценки, записанной со слов клиента: только своей (не клиента) и только в первые REVIEW_EDIT_DAYS дней. */
async function updateReview(ctx: MutationCtx, me: Me, o: Doc<"orders">, r: Doc<"reviews">, next: { rating: number; text?: string }): Promise<void> {
  if (r.via !== "operator") throw new ConvexError("Эту оценку клиент оставил сам — изменить её нельзя");
  if (Date.now() - Date.parse(r.at) > REVIEW_EDIT_DAYS * DAY_MS) throw new ConvexError(`Исправить оценку можно в течение ${REVIEW_EDIT_DAYS} дней`);
  const textChanged = (r.text ?? "") !== (next.text ?? "");
  if (r.rating === next.rating && !textChanged) return;
  const before = await ctx.db.get(r.executorId);
  await ctx.db.patch(r._id, { rating: next.rating, text: next.text });
  await recomputeRating(ctx, r.executorId);
  const after = await ctx.db.get(r.executorId);
  const name = after?.name ?? "мастер";
  if (r.rating !== next.rating) await log(ctx, o._id, "comment", `Оценка клиента исправлена: ${r.rating}★ → ${next.rating}★`, userActor(me._id));
  // Уведомляем, только если оценка стала низкой: о той же низкой оценке уже сообщили.
  const low = next.rating <= LOW_RATING && r.rating > LOW_RATING;
  const notified = low ? await alertLowRating(ctx, o, next.rating, name, next.text, me._id) : 0;
  const parts = [...(r.rating !== next.rating ? [`оценка ${r.rating}★ → ${next.rating}★`] : []), ...(textChanged ? ["комментарий изменён"] : [])];
  await audit(ctx, me, "review.updated", `Заказ №${o.number}: исправлен отзыв со слов клиента — ${parts.join(", ")}; рейтинг ${shortName(name)} ${ratingMove(before?.rating ?? 0, after?.rating ?? 0)}${low ? `; низкая оценка — уведомлено: ${notified}` : ""}`, {
    entityId: o._id,
    meta: { reviewId: r._id, executorId: r.executorId, rating: { from: r.rating, to: next.rating }, textChanged, low, notified },
  });
}

// ── Карточки заказа и мастера ────────────────────────────────────────────────

/** Отзыв по заказу и что с ним можно сделать. null — заказа нет или он не в направлении руководителя. */
export const forOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<OrderReviewInfo | null> => {
    const me = await requireRole(ctx, TEAM);
    const o = await ctx.db.get(orderId);
    if (!o || !inScope(scopeOf(me), o.category)) return null;
    const r = await reviewOf(ctx, orderId);
    const open = r
      ? undefined
      : (
          await ctx.db
            .query("reviewRequests")
            .withIndex("by_order", (q) => q.eq("orderId", orderId))
            .collect()
        )
          .filter((x) => !x.usedAt)
          .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))[0];
    return {
      review: r ? toView(r, o.number) : null,
      reviewable: isReviewable(o),
      editableUntil: r?.via === "operator" ? new Date(Date.parse(r.at) + REVIEW_EDIT_DAYS * DAY_MS).toISOString() : undefined,
      linkExpiresAt: open?.expiresAt,
    };
  },
});

/** Отзывы о мастере: последние и распределение оценок. null — мастера нет или он не в направлении руководителя. */
export const forExecutor = query({
  args: { executorId: v.id("executors") },
  handler: async (ctx, { executorId }): Promise<ExecutorReviewsInfo | null> => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const e = await ctx.db.get(executorId);
    if (!e || (scope && !e.categories.some((c) => scope.includes(c)))) return null;
    const all = await ctx.db
      .query("reviews")
      .withIndex("by_executor", (q) => q.eq("executorId", executorId))
      .order("desc")
      .collect();
    const latest = all.slice(0, EXECUTOR_LATEST);
    const orders = await Promise.all(latest.map((r) => ctx.db.get(r.orderId)));
    return {
      latest: latest.map((r, i) => toView(r, orders[i]?.number)),
      total: all.length,
      byStars: [1, 2, 3, 4, 5].map((s) => all.filter((r) => r.rating === s).length),
    };
  },
});

// ── Ссылка для клиента ───────────────────────────────────────────────────────

/**
 * Ссылка «оцените работу» по заказу: есть действующая неиспользованная — та же, иначе новая на REVIEW_LINK_DAYS дней.
 * В журнал — только создание новой ссылки (кто запросил: сотрудник или система), сам токен — никогда.
 */
export async function issueReviewLink(ctx: MutationCtx, o: Doc<"orders">, actor: AuditActor): Promise<{ url: string; expiresAt: string }> {
  const now = Date.now();
  const open = (
    await ctx.db
      .query("reviewRequests")
      .withIndex("by_order", (q) => q.eq("orderId", o._id))
      .collect()
  ).find((r) => !r.usedAt && Date.parse(r.expiresAt) > now);
  if (open) return { url: reviewUrl(open.token), expiresAt: open.expiresAt };
  const token = newToken();
  const expiresAt = new Date(now + REVIEW_LINK_DAYS * DAY_MS).toISOString();
  await ctx.db.insert("reviewRequests", { token, orderId: o._id, createdAt: nowIso(), expiresAt });
  await audit(ctx, actor, "review.requested", `Заказ №${o.number}: создана ссылка для оценки, действует до ${almatyStamp(expiresAt)}`, { entityId: o._id, meta: { expiresAt } });
  return { url: reviewUrl(token), expiresAt };
}

/** Ссылка «оцените работу» для клиента — сотрудник отправляет её сам (автоматически её шлёт clientNotify.ts). */
export const requestLink = mutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<{ url: string; expiresAt: string }> => {
    const me = await requireRole(ctx, STAFF);
    const o = await reviewableOrder(ctx, orderId);
    if (await reviewOf(ctx, orderId)) throw new ConvexError("Клиент уже оценил этот заказ");
    return issueReviewLink(ctx, o, me);
  },
});

async function findRequest(ctx: QueryCtx, token: string): Promise<Doc<"reviewRequests"> | null> {
  if (!TOKEN_RE.test(token)) return null;
  return ctx.db
    .query("reviewRequests")
    .withIndex("by_token", (q) => q.eq("token", token))
    .first();
}

/** Уже оценено (по этой ссылке или иначе) важнее срока: клиенту — «спасибо», а не «ссылка устарела». */
async function linkState(ctx: QueryCtx, req: Doc<"reviewRequests">, o: Doc<"orders">): Promise<ReviewLinkState> {
  if (req.usedAt || (await reviewOf(ctx, o._id))) return "used";
  if (Date.parse(req.expiresAt) <= Date.now() || !isReviewable(o)) return "expired";
  return "ok";
}

/** Публичная страница оценки (без входа): ни имени, ни телефона, ни адреса клиента. По неизвестной ссылке — только состояние. */
export const byToken = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<ReviewLinkInfo> => {
    const req = await findRequest(ctx, token);
    const o = req ? await ctx.db.get(req.orderId) : null;
    if (!req || !o) return { state: "invalid" };
    const ex = o.executorId ? await ctx.db.get(o.executorId) : null;
    return {
      state: await linkState(ctx, req, o),
      order: { number: o.number, service: (await loadCatalog(ctx)).label(o.serviceId), executor: ex ? firstName(ex.name) : "", doneAt: o.doneAt },
    };
  },
});

/**
 * Оценка по ссылке (публично, без входа). Ошибки возвращаются данными, а не исключением: иначе откатился бы
 * и счётчик попыток. Неизвестные токены ничего не пишут — перебором нельзя раздуть таблицу лимитов.
 */
export const submitByToken = mutation({
  args: { token: v.string(), rating: v.number(), text: v.optional(v.string()) },
  handler: async (ctx, a): Promise<ReviewSubmitResult> => {
    const req = await findRequest(ctx, a.token);
    const o = req ? await ctx.db.get(req.orderId) : null;
    if (!req || !o) return { ok: false, state: "invalid", error: LINK_ERROR.invalid };
    if (!(await hitLimit(ctx, `review:${req._id}`, SUBMIT_LIMIT.max, SUBMIT_LIMIT.windowMs))) return { ok: false, state: "limited", error: "Слишком много попыток — попробуйте через час" };
    const state = await linkState(ctx, req, o);
    if (state !== "ok") return { ok: false, state, error: LINK_ERROR[state] };
    const input = checkReview(a.rating, a.text);
    if (!input.ok) return { ok: false, state: "input", error: input.error };
    await ctx.db.patch(req._id, { usedAt: nowIso() });
    await createReview(ctx, o, { rating: input.rating, text: input.text, via: "link", actor: "Сайт" });
    return { ok: true };
  },
});

// ── Со слов клиента и из каналов ─────────────────────────────────────────────

/**
 * Сотрудник записывает оценку со слов клиента (звонок, переписка). Один отзыв на заказ: свою запись можно
 * исправить в первые REVIEW_EDIT_DAYS дней, отзыв, оставленный самим клиентом, — нельзя.
 */
export const addByOperator = mutation({
  args: { orderId: v.id("orders"), rating: v.number(), text: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ updated: boolean }> => {
    const me = await requireRole(ctx, STAFF);
    const o = await reviewableOrder(ctx, a.orderId);
    const input = checkReview(a.rating, a.text);
    if (!input.ok) throw new ConvexError(input.error);
    const existing = await reviewOf(ctx, o._id);
    if (existing) {
      await updateReview(ctx, me, o, existing, input);
      return { updated: true };
    }
    await createReview(ctx, o, { rating: input.rating, text: input.text, via: "operator", author: me, actor: me });
    return { updated: false };
  },
});

export type ChannelReviewResult = { ok: true } | { ok: false; error: string };

/**
 * Оценка, которую клиент прислал в канал (Telegram, WhatsApp). Те же проверки и «один отзыв на заказ»;
 * ответ — данными, его можно переслать клиенту. Для вызова из мутаций каналов — напрямую, из действий — через _submit.
 */
export async function submitFromChannel(ctx: MutationCtx, a: { orderId: Id<"orders">; rating: number; text?: string; via: "telegram" | "whatsapp" }): Promise<ChannelReviewResult> {
  const o = await ctx.db.get(a.orderId);
  if (!o) return { ok: false, error: "Заказ не найден" };
  if (!isReviewable(o)) return { ok: false, error: "Оценку можно оставить после выполнения заказа" };
  const input = checkReview(a.rating, a.text);
  if (!input.ok) return { ok: false, error: input.error };
  if (await reviewOf(ctx, o._id)) return { ok: false, error: LINK_ERROR.used };
  await createReview(ctx, o, { rating: input.rating, text: input.text, via: a.via, actor: a.via === "telegram" ? "Telegram" : "WhatsApp" });
  return { ok: true };
}

export const _submit = internalMutation({
  args: { orderId: v.id("orders"), rating: v.number(), text: v.optional(v.string()), via: v.union(v.literal("telegram"), v.literal("whatsapp")) },
  handler: (ctx, a): Promise<ChannelReviewResult> => submitFromChannel(ctx, a),
});
