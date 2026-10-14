// Кабинет мастера: запросы, которых нет в worker.ts, — профиль, экран заказа до взятия, фото и данные для ленты.
// Только чтение и только своё: мастер видит свои заказы и свободные заказы, которые ему подходят.
// Цену клиента, маржу, платежи, внутреннюю переписку команды и переписку по клиенту не отдаём никогда —
// заказ собирает toWorkerOrder (lib/dto.ts), переписка — только канал «С мастером», файлы — только видимые мастеру.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type QueryCtx } from "./_generated/server";
import { EXECUTOR, requireRole } from "./lib/access";
import { executorFiles, executorThread, toWorkerOrder } from "./lib/dto";
import { fileSigner, type FileSigner } from "./lib/files";
import { loadCatalog } from "./catalog";
import { env } from "./env";
import { contactsOpen, payout, payoutFor } from "../src/data/logic";
import { fitsProfile } from "../src/data/workerMatch";
import { executorStats, type EarningOrder } from "../src/data/workerStats";
import { firstName } from "../src/lib/format";
import type { FeedExtra, WorkerFile, WorkerNote, WorkerOrderView, WorkerPhoto, WorkerProfile, WorkerReview } from "../src/data/workerTypes";

/** Фото в галерее заказа — не больше. */
const GALLERY_LIMIT = 12;
/** Документов к заказу — не больше. */
const DOCUMENTS_LIMIT = 20;
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

type StoredFile = Doc<"orders">["files"][number];

/**
 * Файлы заказа для мастера: отмеченные «Показать мастеру» (в том числе из переписки с ним). skip — вложения,
 * которые уже видны в его переписке, чтобы не дублировать их в галерее.
 */
function visibleFiles(o: Doc<"orders">, skip: ReadonlySet<string>): StoredFile[] {
  return executorFiles(o.files).filter((f) => !skip.has(f.id));
}

function photosOf(files: StoredFile[], signer: FileSigner): WorkerPhoto[] {
  const out: WorkerPhoto[] = [];
  for (const f of files) {
    if (out.length >= GALLERY_LIMIT) break;
    const url = f.kind === "image" ? signer.url(f.storageId) : undefined;
    if (url) out.push({ id: f.id, name: f.name, url });
  }
  return out;
}

const fileOf = (f: StoredFile, signer: FileSigner): WorkerFile => ({ id: f.id, name: f.name, kind: f.kind, url: signer.url(f.storageId, f.kind === "file" ? f.name : undefined) });

const documentsOf = (files: StoredFile[], signer: FileSigner): WorkerFile[] =>
  files
    .filter((f) => f.kind === "file")
    .slice(0, DOCUMENTS_LIMIT)
    .map((f) => fileOf(f, signer));

/** Переписка мастера с офисом: его сообщения и ответы команды (с именем сотрудника). */
async function notesOf(ctx: QueryCtx, thread: Doc<"messages">[], me: Id<"users">, signer: FileSigner): Promise<WorkerNote[]> {
  const names = new Map<string, string | undefined>();
  for (const m of thread) {
    if (m.author.type !== "user" || m.author.id === me || names.has(m.author.id)) continue;
    const id = ctx.db.normalizeId("users", m.author.id);
    const name = id ? (await ctx.db.get(id))?.name : undefined;
    names.set(m.author.id, name ? firstName(name) : undefined);
  }
  return thread.map((m) => {
    const mine = m.author.type === "user" && m.author.id === me;
    return { id: m._id, text: m.text, at: m.at, files: m.files.map((f) => fileOf(f, signer)), mine, author: mine || m.author.type !== "user" ? undefined : names.get(m.author.id) };
  });
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

/**
 * Экран заказа для мастера: свой заказ, свободный подходящий заказ или короткий отказ без подробностей.
 * t — метка обновления ссылок на файлы (src/data/files.ts).
 */
export const order = query({
  args: { id: v.string(), t: v.optional(v.number()) },
  handler: async (ctx, { id }): Promise<WorkerOrderView> => {
    const { me, ex } = await myExecutor(ctx);
    const orderId = id.length <= MAX_ID_LENGTH ? ctx.db.normalizeId("orders", id) : null;
    const o = orderId ? await ctx.db.get(orderId) : null;
    if (!o) return { state: "unavailable" };
    const signer = await fileSigner(ctx);

    if (o.executorId === ex._id) {
      const thread = await executorThread(ctx, o._id, me._id);
      const files = visibleFiles(o, new Set(thread.flatMap((m) => m.files.map((f) => f.id))));
      return {
        state: "mine",
        // Адрес и контакты — пока заказ у мастера в работе: после подтверждения и до оплаты.
        order: toWorkerOrder(o, { contacts: contactsOpen(o) }),
        photos: photosOf(files, signer),
        documents: documentsOf(files, signer),
        notes: await notesOf(ctx, thread, me._id, signer),
      };
    }

    // Чужие и неподходящие заказы — без подробностей.
    if (!fitsProfile(ex, o)) return { state: "unavailable" };
    if (o.executorId) return { state: "taken" };
    if (o.status !== "awaiting_executor") return { state: "unavailable" };
    const files = visibleFiles(o, new Set());
    return {
      state: "available",
      order: toWorkerOrder(o, { contacts: false, payout: payoutFor(ex.rates, o) }),
      photos: photosOf(files, signer),
      documents: documentsOf(files, signer),
      publishedAt: await publishedAt(ctx, o),
    };
  },
});

/** Для карточек ленты: когда заказ опубликован (метка «Новый», сортировка) и превью первого фото, видимого мастеру. */
export const feedExtras = query({
  args: { t: v.optional(v.number()) },
  handler: async (ctx): Promise<FeedExtra[]> => {
    const { ex } = await myExecutor(ctx);
    const signer = await fileSigner(ctx);
    const waiting = await ctx.db
      .query("orders")
      .withIndex("by_status", (q) => q.eq("status", "awaiting_executor"))
      .collect();
    const out: FeedExtra[] = [];
    for (const o of waiting) {
      if (o.executorId || !fitsProfile(ex, o)) continue;
      const images = executorFiles(o.files).filter((f) => f.kind === "image");
      out.push({ id: o._id, publishedAt: await publishedAt(ctx, o), thumbUrl: signer.url(images[0]?.storageId), photos: images.length });
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
      unavailableUntil: ex.unavailableUntil,
      unavailableReason: ex.unavailableReason,
      cooperation: ex.cooperation,
      joinedAt: ex.joinedAt,
      districts: ex.districts ?? [],
      telegram: { enabled: !!env("TELEGRAM_BOT_TOKEN") && !!env("TELEGRAM_BOT_USERNAME"), linked: !!me.telegramChatId },
      stats: executorStats(orders.map(toEarning), Date.now()),
      reviews,
    };
  },
});
