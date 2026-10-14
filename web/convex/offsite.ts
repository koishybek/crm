// Внешнее хранилище резервных копий (ТЗ п.20.10, п.26.5): после ночной копии (backup.ts) тот же JSON уходит
// в S3-совместимое хранилище (Cloudflare R2, PS Cloud, AWS S3) — от потери самого деплоймента. Там храним 30
// последних копий (старые удаляем по префиксу). По настройке владельца (по умолчанию выключено) туда же
// копируются сами файлы — записи звонков, фото, вложения: каждый один раз, а удалённые у нас (срок хранения,
// удаление данных клиента) удаляются и там. Без переменных BACKUP_S3_* — «Внешнее хранилище не подключено».
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./lib/functions";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { markError, markOk } from "./lib/health";
import { s3Config, s3Delete, s3List, s3Missing, s3Put, S3Error, type S3Config } from "./lib/s3";
import { backupName } from "./backup";
import type { OffsiteStatus } from "../src/data/offsite";

/** Сколько копий храним во внешнем хранилище. */
export const KEEP_OFFSITE = 30;
export const BACKUP_PREFIX = "backups/";
export const FILES_PREFIX = "files/";
/** Только наши копии: чужие объекты в том же бакете не трогаем. */
const OUR_BACKUP = /^backups\/homemax-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/;
const COPY_FILES_KEY = "offsiteCopyFiles";

/** За одну ночь файлов — не больше этого (и не дольше FILES_TIME_MS): остальное — следующей ночью. */
const FILES_PER_RUN = 300;
const FILES_BYTES_PER_RUN = 1024 * 1024 * 1024;
const FILES_TIME_MS = 5 * 60_000;
const PAGE = 100;

const errorText = (e: unknown): string => (e instanceof S3Error ? e.message : e instanceof Error ? e.message.slice(0, 200) : "неизвестная ошибка");

async function copyFilesOn(ctx: QueryCtx): Promise<boolean> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", COPY_FILES_KEY))
    .unique();
  return row?.value === "1";
}

export const _backup = internalQuery({
  args: { backupId: v.id("backups") },
  handler: async (ctx, { backupId }) => {
    const b = await ctx.db.get(backupId);
    return b ? { fileId: b.fileId, at: b.at, copyFiles: await copyFilesOn(ctx) } : null;
  },
});

/** Копии сверх 30 последних — удалить (только наши имена). Возвращает, сколько удалено. */
export async function pruneBackups(cfg: S3Config): Promise<number> {
  const ours = (await s3List(cfg, BACKUP_PREFIX)).filter((o) => OUR_BACKUP.test(o.key)).map((o) => o.key);
  // Имя содержит дату и время — сортировка по имени = по времени.
  const old = ours.sort().reverse().slice(KEEP_OFFSITE);
  for (const key of old) await s3Delete(cfg, key);
  return old.length;
}

// ── Файлы ────────────────────────────────────────────────────────────────────

type StoredFile = { storageId: Id<"_storage">; size: number; contentType?: string };

/** Страница хранилища: файлы, которых во внешнем хранилище ещё нет. Сами копии и выгрузки CSV — не файлы бизнеса. */
export const _toCopy = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<{ items: StoredFile[]; cursor: string; isDone: boolean }> => {
    const service = new Set<string>([...(await ctx.db.query("backups").collect()).map((b) => b.fileId), ...(await ctx.db.query("exports").collect()).map((e) => e.fileId)]);
    const res = await ctx.db.system.query("_storage").paginate({ cursor, numItems: PAGE });
    const items: StoredFile[] = [];
    for (const f of res.page) {
      if (service.has(f._id)) continue;
      const copied = await ctx.db
        .query("offsiteFiles")
        .withIndex("by_storage", (q) => q.eq("storageId", f._id))
        .first();
      if (!copied) items.push({ storageId: f._id, size: f.size, ...(f.contentType ? { contentType: f.contentType } : {}) });
    }
    return { items, cursor: res.continueCursor, isDone: res.isDone };
  },
});

/** Страница скопированных файлов, которых у нас уже нет (удалены по сроку или по просьбе клиента). */
export const _gone = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }): Promise<{ items: { id: Id<"offsiteFiles">; key: string }[]; cursor: string; isDone: boolean }> => {
    const res = await ctx.db.query("offsiteFiles").paginate({ cursor, numItems: PAGE });
    const items: { id: Id<"offsiteFiles">; key: string }[] = [];
    for (const r of res.page) if (!(await ctx.db.system.get(r.storageId))) items.push({ id: r._id, key: r.key });
    return { items, cursor: res.continueCursor, isDone: res.isDone };
  },
});

export const _copied = internalMutation({
  args: { items: v.array(v.object({ storageId: v.id("_storage"), key: v.string(), size: v.number() })) },
  handler: async (ctx, { items }): Promise<void> => {
    const at = nowIso();
    for (const i of items) await ctx.db.insert("offsiteFiles", { ...i, at });
  },
});

export const _forget = internalMutation({
  args: { ids: v.array(v.id("offsiteFiles")) },
  handler: async (ctx, { ids }): Promise<void> => {
    for (const id of ids) if (await ctx.db.get(id)) await ctx.db.delete(id);
  },
});

export interface FilesSync {
  copied: number;
  removed: number;
  /** Не всё успели — продолжим следующей ночью. */
  more: boolean;
}

/** Инкрементальная синхронизация файлов: удалённые у нас — удалить там, новые — скопировать (с потолком на ночь). */
export async function syncFiles(ctx: ActionCtx, cfg: S3Config, startedAt = Date.now()): Promise<FilesSync> {
  let removed = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { items: { id: Id<"offsiteFiles">; key: string }[]; cursor: string; isDone: boolean } = await ctx.runQuery(internal.offsite._gone, { cursor });
    for (const g of page.items) await s3Delete(cfg, g.key);
    if (page.items.length) await ctx.runMutation(internal.offsite._forget, { ids: page.items.map((g) => g.id) });
    removed += page.items.length;
    if (page.isDone) break;
    cursor = page.cursor;
  }
  let copied = 0;
  let bytes = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { items: StoredFile[]; cursor: string; isDone: boolean } = await ctx.runQuery(internal.offsite._toCopy, { cursor });
    const done: { storageId: Id<"_storage">; key: string; size: number }[] = [];
    for (const f of page.items) {
      if (copied >= FILES_PER_RUN || bytes >= FILES_BYTES_PER_RUN || Date.now() - startedAt > FILES_TIME_MS) {
        if (done.length) await ctx.runMutation(internal.offsite._copied, { items: done });
        return { copied, removed, more: true };
      }
      const blob = await ctx.storage.get(f.storageId);
      if (!blob) continue;
      const key = `${FILES_PREFIX}${f.storageId}`;
      await s3Put(cfg, key, blob, f.contentType ?? "application/octet-stream");
      done.push({ storageId: f.storageId, key, size: f.size });
      copied++;
      bytes += f.size;
    }
    if (done.length) await ctx.runMutation(internal.offsite._copied, { items: done });
    if (page.isDone) return { copied, removed, more: false };
    cursor = page.cursor;
  }
}

// ── Копия ────────────────────────────────────────────────────────────────────

/** Выгрузить копию во внешнее хранилище, убрать старые и (если включено) синхронизировать файлы. */
export const push = internalAction({
  args: { backupId: v.id("backups") },
  handler: async (ctx, { backupId }): Promise<void> => {
    const cfg = s3Config();
    if (!cfg) return;
    const b = await ctx.runQuery(internal.offsite._backup, { backupId });
    if (!b) return;
    const started = Date.now();
    try {
      const blob = await ctx.storage.get(b.fileId);
      if (!blob) throw new Error("файл копии не найден в хранилище");
      await s3Put(cfg, `${BACKUP_PREFIX}${backupName(b.at)}`, blob, "application/json");
      const pruned = await pruneBackups(cfg);
      const files = b.copyFiles ? await syncFiles(ctx, cfg, started) : null;
      await ctx.runMutation(internal.offsite._pushed, { backupId, pruned, files: files ?? undefined });
    } catch (e) {
      const reason = errorText(e);
      console.error(`Внешнее хранилище: ${reason}`);
      await ctx.runMutation(internal.offsite._failed, { reason });
    }
  },
});

export const _pushed = internalMutation({
  args: { backupId: v.id("backups"), pruned: v.number(), files: v.optional(v.object({ copied: v.number(), removed: v.number(), more: v.boolean() })) },
  handler: async (ctx, { backupId, pruned, files }): Promise<void> => {
    if (await ctx.db.get(backupId)) await ctx.db.patch(backupId, { offsiteAt: nowIso() });
    const filesNote = files ? `; файлов скопировано: ${files.copied}${files.removed ? `, удалено: ${files.removed}` : ""}${files.more ? " (остальные — следующей ночью)" : ""}` : "";
    await markOk(ctx, "offsite", `Копия выгружена${pruned ? `, старых удалено: ${pruned}` : ""}${filesNote}`);
    await audit(ctx, "Система", "system.offsiteBackup", `Резервная копия выгружена во внешнее хранилище${filesNote}`, { entityId: backupId, meta: { pruned, ...(files ?? {}) } });
  },
});

export const _failed = internalMutation({
  args: { reason: v.string() },
  handler: async (ctx, { reason }): Promise<void> => {
    await markError(ctx, "offsite", `Копия не выгружена: ${reason}`);
    await audit(ctx, "Система", "system.offsiteFailed", `Резервная копия не выгружена во внешнее хранилище: ${reason.slice(0, 200)}`);
  },
});

// ── Карточка владельца ───────────────────────────────────────────────────────

export const status = query({
  args: {},
  handler: async (ctx): Promise<OffsiteStatus> => {
    await requireRole(ctx, OWNER);
    const cfg = s3Config();
    const mark = await ctx.db
      .query("systemStatus")
      .withIndex("by_key", (q) => q.eq("key", "offsite"))
      .unique();
    return {
      configured: !!cfg,
      missing: s3Missing(),
      host: cfg?.endpoint.host,
      bucket: cfg?.bucket,
      region: cfg?.cred.region,
      keep: KEEP_OFFSITE,
      copyFiles: await copyFilesOn(ctx),
      health: mark ? { okAt: mark.okAt, okNote: mark.okNote, errorAt: mark.errorAt, error: mark.error } : undefined,
    };
  },
});

/** «Копировать файлы во внешнее хранилище» — по умолчанию выключено (объём и стоимость хранения решает владелец). */
export const setCopyFiles = mutation({
  args: { on: v.boolean() },
  handler: async (ctx, { on }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", COPY_FILES_KEY))
      .unique();
    if ((row?.value === "1") === on) return;
    if (row) await ctx.db.patch(row._id, { value: on ? "1" : "0" });
    else await ctx.db.insert("settings", { key: COPY_FILES_KEY, value: on ? "1" : "0" });
    await audit(ctx, me, "settings.offsiteFiles", on ? "Включено копирование файлов во внешнее хранилище" : "Выключено копирование файлов во внешнее хранилище");
  },
});
