// Файлы: подтверждение загрузки на сервере (аудит M-10, E21), выдача по подписанной ссылке на 15 минут (E16),
// уборка брошенных загрузок и разовый перенос старой переписки мастеров в канал «С мастером» (M-6).
// Ссылки подписывают запросы (lib/files.ts → fileSigner), здесь их проверяет GET /files/….
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { currentUser } from "./lib/access";
import { audit } from "./lib/audit";
import { checkFileLink, dropFile, ensureSigningKey, fileResponse, parseFileLink, registerUpload, signingKey, type UploadKind } from "./lib/files";

/** Неприкреплённая загрузка живёт сутки. */
const UNUSED_TTL_MS = 86400_000;
/** За один проход уборки — не больше. */
const CLEANUP_BATCH = 100;

/**
 * Второй шаг загрузки: после POST по uploadUrl клиент «забирает» файл. Сервер сверяет тип и размер по метаданным
 * хранилища и закрепляет файл за пользователем — прикрепить к заказу или звонку можно только свой подтверждённый файл.
 */
export const confirmUpload = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }): Promise<{ ok: true; kind: UploadKind } | { ok: false; error: string }> => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    await ensureSigningKey(ctx);
    return registerUpload(ctx, me._id, storageId);
  },
});

export const _signingKey = internalQuery({
  args: {},
  handler: (ctx): Promise<string | null> => signingKey(ctx),
});

export const _meta = internalQuery({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }): Promise<{ size: number; contentType?: string } | null> => {
    const meta = await ctx.db.system.get("_storage", storageId);
    return meta ? { size: meta.size, contentType: meta.contentType } : null;
  },
});

/** Крон: ключ подписи на месте (без FILES_SIGNING_KEY) и неприкреплённые загрузки старше суток удалены вместе с файлом. */
export const maintain = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ removed: number }> => {
    await ensureSigningKey(ctx);
    const before = new Date(Date.now() - UNUSED_TTL_MS).toISOString();
    const stale = await ctx.db
      .query("uploads")
      .withIndex("by_used", (q) => q.eq("usedAt", undefined).lt("at", before))
      .take(CLEANUP_BATCH);
    for (const u of stale) {
      await dropFile(ctx, u.storageId);
      await ctx.db.delete(u._id);
    }
    return { removed: stale.length };
  },
});

/** Сообщений за один шаг переноса. */
const MIGRATE_BATCH = 200;

/**
 * Разовый перенос старых данных (запускает интегратор после выкладки: npx convex run files:migrateExecutorChannel).
 * Сообщения мастеров, написанные до канала «С мастером» во «внутренний», переходят в него вместе с файлами — мастер снова
 * видит свою переписку; фото из переписки по клиенту, которые мастер раньше видел в галерее, получают «Показать мастеру».
 * Решение сотрудника («скрыть») не трогаем. Идёт пачками, следующую ставит сам; в конце — запись в журнале.
 */
export const migrateExecutorChannel = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())), moved: v.optional(v.number()), shown: v.optional(v.number()) },
  handler: async (ctx, a): Promise<void> => {
    const page = await ctx.db.query("messages").paginate({ cursor: a.cursor ?? null, numItems: MIGRATE_BATCH });
    const roles = new Map<string, string | undefined>();
    const roleOf = async (id: string) => {
      if (!roles.has(id)) {
        const userId = ctx.db.normalizeId("users", id);
        roles.set(id, userId ? (await ctx.db.get(userId))?.role : undefined);
      }
      return roles.get(id);
    };
    let moved = a.moved ?? 0;
    let shown = a.shown ?? 0;
    const show = new Map<Id<"orders">, Set<string>>();
    for (const m of page.page) {
      const byExecutor = m.author.type === "user" && (await roleOf(m.author.id)) === "executor";
      if (byExecutor && m.channel === "internal") {
        await ctx.db.patch(m._id, { channel: "executor", files: m.files.map((f) => ({ ...f, forExecutor: true })) });
        moved++;
      }
      const visible = byExecutor ? m.files : m.channel === "client" ? m.files.filter((f) => f.kind === "image") : [];
      if (visible.length) show.set(m.orderId, new Set([...(show.get(m.orderId) ?? []), ...visible.map((f) => f.id)]));
    }
    for (const [orderId, ids] of show) {
      const o = await ctx.db.get(orderId);
      if (!o || !o.files.some((f) => ids.has(f.id) && f.forExecutor === undefined)) continue;
      await ctx.db.patch(orderId, { files: o.files.map((f) => (ids.has(f.id) && f.forExecutor === undefined ? (shown++, { ...f, forExecutor: true }) : f)) });
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.files.migrateExecutorChannel, { cursor: page.continueCursor, moved, shown });
      return;
    }
    await audit(ctx, "Система", "system.migration", `Переписка мастеров перенесена в канал «С мастером»: сообщений ${moved}, файлов показано мастерам ${shown}`, { meta: { moved, shown } });
  },
});

const denied = (text: string) => new Response(text, { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

/** GET /files/<storageId>?exp=…&sig=… — файл по подписанной ссылке. Срок вышел или подпись не та — 403. */
export const serveFile = httpAction(async (ctx, request) => {
  const link = parseFileLink(new URL(request.url));
  if (!link) return denied("Нет доступа");
  const verdict = checkFileLink(link, await ctx.runQuery(internal.files._signingKey, {}), Date.now());
  if (verdict === "expired") return denied("Ссылка устарела — обновите страницу");
  if (verdict !== "ok") return denied("Нет доступа");
  // Подпись верна — значит, id выдан нашим запросом и это id файла хранилища.
  const storageId = link.storageId as Id<"_storage">;
  const meta = await ctx.runQuery(internal.files._meta, { storageId });
  const blob = meta ? await ctx.storage.get(storageId) : null;
  if (!meta || !blob) return new Response("Файл не найден", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  return fileResponse(request, blob, { type: meta.contentType ?? blob.type, name: link.name, exp: link.exp, nowMs: Date.now() });
});
