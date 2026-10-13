// Кабинет мастера: запросы, которых нет в worker.ts, — профиль, экран заказа до взятия, фото и данные для ленты.
// Только чтение и только своё: мастер видит свои заказы и свободные заказы, которые ему подходят.
// Цену клиента, маржу, платежи, внутреннюю переписку команды и её файлы не отдаём никогда —
// заказ собирает toWorkerOrder (lib/dto.ts), остальные поля перечислены явно.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { EXECUTOR, requireRole } from "./lib/access";
import { toWorkerOrder } from "./lib/dto";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { payout } from "../src/data/logic";
import { fitsProfile } from "../src/data/workerMatch";
import { executorStats, type EarningOrder } from "../src/data/workerStats";
import type { FeedExtra, WorkerFile, WorkerNote, WorkerOrderView, WorkerPhoto, WorkerProfile, WorkerReview } from "../src/data/workerTypes";

/** Фото в галерее заказа — не больше. */
const GALLERY_LIMIT = 12;
/** Id документа Convex короче; длиннее — заведомо мусор из адресной строки. */
const MAX_ID_LENGTH = 64;
/** Отзывов в профиле. */
const REVIEWS_LIMIT = 20;

async function myExecutor(ctx: QueryCtx) {
  const me = await requireRole(ctx, EXECUTOR);
  const ex = me.executorId ? await ctx.db.get(me.executorId) : null;
  if (!ex) throw new ConvexError("Профиль мастера не найден");
  return { me, ex };
}

const messagesOf = (ctx: QueryCtx, orderId: Id<"orders">) =>
  ctx.db
    .query("messages")
    .withIndex("by_order", (q) => q.eq("orderId", orderId))
    .collect();

const isOwn = (m: Doc<"messages">, userId: Id<"users">) => m.author.type === "user" && m.author.id === userId;

/**
 * Картинки заказа, которые можно показать мастеру. Скрываем вложения внутренних заметок команды
 * (там бывают счета и цены клиента) и фото самого мастера — они показываются в его сообщениях.
 * Документы (PDF, таблицы) мастер не видит вовсе.
 */
function visibleImages(o: Doc<"orders">, messages: Doc<"messages">[], userId: Id<"users"> | null) {
  const hidden = new Set(messages.filter((m) => m.channel === "internal" || (userId !== null && isOwn(m, userId))).flatMap((m) => m.files.map((f) => f.id)));
  return o.files.filter((f) => f.kind === "image" && f.storageId !== undefined && !hidden.has(f.id));
}

async function photosOf(ctx: QueryCtx, files: Doc<"orders">["files"]): Promise<WorkerPhoto[]> {
  const out: WorkerPhoto[] = [];
  for (const f of files.slice(0, GALLERY_LIMIT)) {
    const url = f.storageId ? await ctx.storage.getUrl(f.storageId) : null;
    if (url) out.push({ id: f.id, name: f.name, url });
  }
  return out;
}

async function noteOf(ctx: QueryCtx, m: Doc<"messages">): Promise<WorkerNote> {
  const files = await Promise.all(
    m.files.map(async (f): Promise<WorkerFile> => ({ id: f.id, name: f.name, kind: f.kind, url: f.storageId ? ((await ctx.storage.getUrl(f.storageId)) ?? undefined) : undefined })),
  );
  return { id: m._id, text: m.text, at: m.at, files };
}

/** События, которые меняют статус заказа: последнее из них у свободного заказа — его публикация в ленту. */
const STATUS_MOVES: ReadonlySet<Doc<"history">["kind"]> = new Set(["status", "published", "taken", "assigned", "created"]);

/** Когда заказ (в последний раз) попал в ленту: заказ мог вернуться туда после отказа мастера. */
async function publishedAt(ctx: QueryCtx, o: Doc<"orders">): Promise<string> {
  const events = await ctx.db
    .query("history")
    .withIndex("by_order", (q) => q.eq("orderId", o._id))
    .order("desc")
    .take(50);
  const last = events.find((e) => STATUS_MOVES.has(e.kind));
  return last && (last.kind === "status" || last.kind === "published") ? last.at : o.createdAt;
}

/** Экран заказа для мастера: свой заказ, свободный подходящий заказ или короткий отказ без подробностей. */
export const order = query({
  args: { id: v.string() },
  handler: async (ctx, { id }): Promise<WorkerOrderView> => {
    const { me, ex } = await myExecutor(ctx);
    const orderId = id.length <= MAX_ID_LENGTH ? ctx.db.normalizeId("orders", id) : null;
    const o = orderId ? await ctx.db.get(orderId) : null;
    if (!o) return { state: "unavailable" };

    if (o.executorId === ex._id) {
      const messages = await messagesOf(ctx, o._id);
      return {
        state: "mine",
        // Адрес и контакты — по тем же правилам, что в worker.order: после подтверждения заказа.
        order: await toWorkerOrder(ctx, o, { contacts: o.status !== "assigned", files: false }),
        photos: await photosOf(ctx, visibleImages(o, messages, me._id)),
        // Переписку команды мастер не видит — только свои сообщения оператору.
        notes: await Promise.all(messages.filter((m) => isOwn(m, me._id)).map((m) => noteOf(ctx, m))),
      };
    }

    // Чужие и неподходящие заказы — без подробностей.
    if (!fitsProfile(ex, o)) return { state: "unavailable" };
    if (o.executorId) return { state: "taken" };
    if (o.status !== "awaiting_executor") return { state: "unavailable" };
    return {
      state: "available",
      order: await toWorkerOrder(ctx, o, { contacts: false, files: false }),
      photos: await photosOf(ctx, visibleImages(o, await messagesOf(ctx, o._id), null)),
      publishedAt: await publishedAt(ctx, o),
    };
  },
});

/** Для карточек ленты: когда заказ опубликован (метка «Новый», сортировка) и превью первого фото. */
export const feedExtras = query({
  args: {},
  handler: async (ctx): Promise<FeedExtra[]> => {
    const { ex } = await myExecutor(ctx);
    const waiting = await ctx.db
      .query("orders")
      .withIndex("by_status", (q) => q.eq("status", "awaiting_executor"))
      .collect();
    const out: FeedExtra[] = [];
    for (const o of waiting) {
      if (o.executorId || !fitsProfile(ex, o)) continue;
      const images = o.files.some((f) => f.kind === "image") ? visibleImages(o, await messagesOf(ctx, o._id), null) : [];
      const first = images[0]?.storageId;
      out.push({ id: o._id, publishedAt: await publishedAt(ctx, o), thumbUrl: first ? ((await ctx.storage.getUrl(first)) ?? undefined) : undefined, photos: images.length });
    }
    return out;
  },
});

const toEarning = (o: Doc<"orders">): EarningOrder => ({
  status: o.status,
  payout: payout(o),
  payoutPaid: o.payoutPaid,
  deadline: o.deadline,
  createdAt: o.createdAt,
  assignedAt: o.assignedAt,
  doneAt: o.doneAt,
});

/** Профиль мастера: кто он, что умеет, рейтинг и отзывы, приём заказов, Telegram и показатели месяца. */
export const profile = query({
  args: {},
  handler: async (ctx): Promise<WorkerProfile> => {
    const { me, ex } = await myExecutor(ctx);
    const catalog = await loadCatalog(ctx);
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_executor", (q) => q.eq("executorId", ex._id))
      .collect();
    const reviewDocs = await ctx.db
      .query("reviews")
      .withIndex("by_executor", (q) => q.eq("executorId", ex._id))
      .order("desc")
      .take(REVIEWS_LIMIT);
    const reviews = await Promise.all(
      reviewDocs.map(async (r): Promise<WorkerReview> => {
        const o = await ctx.db.get(r.orderId);
        return { id: r._id, rating: r.rating, text: r.text, at: r.at, service: o ? catalog.label(o.serviceId) : "" };
      }),
    );
    const categories = ex.categories.map((id): WorkerProfile["categories"][number] => {
      const c = catalog.categories.find((x) => x.id === id);
      return { id, label: c?.label ?? id, tone: c?.tone ?? "gray" };
    });
    return {
      name: ex.name,
      phone: ex.phone,
      city: ex.city,
      categories,
      skills: ex.skills,
      rating: ex.rating,
      reviewsCount: ex.reviews,
      available: ex.available,
      cooperation: ex.cooperation,
      joinedAt: ex.joinedAt,
      telegram: { enabled: !!env("TELEGRAM_BOT_TOKEN") && !!env("TELEGRAM_BOT_USERNAME"), linked: !!me.telegramChatId },
      stats: executorStats(orders.map(toEarning), Date.now()),
      reviews,
    };
  },
});
