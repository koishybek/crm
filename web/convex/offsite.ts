// Внешнее хранилище резервных копий (ТЗ п.20.10, п.26.5): после ночной копии (backup.ts) тот же JSON уходит
// во внешнее хранилище — от потери самого деплоймента: S3-совместимое (Cloudflare R2, PS Cloud, AWS S3) или
// Cloudflare Worker с Workers KV (web/backup-worker), выбор — lib/offsiteStore.ts. Там храним 30 последних копий
// (старые удаляем по префиксу). По настройке владельца (по умолчанию выключено) туда же копируются сами файлы —
// записи звонков, фото, вложения: каждый один раз, а удалённые у нас (срок хранения, удаление данных клиента)
// удаляются и там; в Workers KV файлы больше 25 МБ не помещаются — их пропускаем с пометкой. Без переменных
// BACKUP_S3_* и BACKUP_WORKER_* — «Внешнее хранилище не подключено».
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type QueryCtx } from "./lib/functions";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { markError, markOk } from "./lib/health";
import { offsiteMissing, offsiteStore, storeErrorText, type OffsiteStore } from "./lib/offsiteStore";
import { backupName } from "./backup";
import type { OffsiteStatus } from "../src/data/offsite";
import { DEFAULT_TENANT, tenantOfDoc } from "./lib/tenantDb";

/** Сколько копий храним во внешнем хранилище. */
export const KEEP_OFFSITE = 30;
export const BACKUP_PREFIX = "backups/";
export const FILES_PREFIX = "files/";
/** Только наши копии: чужие объекты в том же бакете не трогаем. */
const OUR_BACKUP = /^backups\/homemax-backup-\d{4}-\d{2}-\d{2}-\d{4}\.json$/;
/**
 * Папка компании в бакете (ТЗ §2.5): у компании по умолчанию — корень (как до SaaS: прежние копии на месте),
 * у остальных — t/<компания>/. Удаление старых копий и файлов не выходит за папку своей компании.
 */
export const tenantPrefix = (tenantId: string): string => (tenantId === DEFAULT_TENANT ? "" : `t/${tenantId}/`);
const COPY_FILES_KEY = "offsiteCopyFiles";

/** За одну ночь файлов — не больше этого (и не дольше FILES_TIME_MS): остальное — следующей ночью. */
const FILES_PER_RUN = 300;
const FILES_BYTES_PER_RUN = 1024 * 1024 * 1024;
const FILES_TIME_MS = 5 * 60_000;
const PAGE = 100;

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
    return b ? { fileId: b.fileId, at: b.at, copyFiles: await copyFilesOn(ctx), tenantId: tenantOfDoc(b) } : null;
  },
});

/** Копии сверх 30 последних — удалить (только наши имена). Возвращает, сколько удалено. */
export async function pruneBackups(store: OffsiteStore, prefix = ""): Promise<number> {
  const ours = (await store.list(`${prefix}${BACKUP_PREFIX}`))
    .filter((o) => o.key.startsWith(prefix) && OUR_BACKUP.test(o.key.slice(prefix.length)))
    .map((o) => o.key);
  // Имя содержит дату и время — сортировка по имени = по времени.
  const old = ours.sort().reverse().slice(KEEP_OFFSITE);
  for (const key of old) await store.remove(key);
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
  /** Больше потолка хранилища (Workers KV — 25 МБ): не копируются. */
  skipped: number;
  /** Не всё успели — продолжим следующей ночью. */
  more: boolean;
}

/** Инкрементальная синхронизация файлов: удалённые у нас — удалить там, новые — скопировать (с потолком на ночь). */
export async function syncFiles(ctx: ActionCtx, store: OffsiteStore, startedAt = Date.now(), prefix = ""): Promise<FilesSync> {
  let removed = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { items: { id: Id<"offsiteFiles">; key: string }[]; cursor: string; isDone: boolean } = await ctx.runQuery(internal.offsite._gone, { cursor });
    for (const g of page.items) await store.remove(g.key);
    if (page.items.length) await ctx.runMutation(internal.offsite._forget, { ids: page.items.map((g) => g.id) });
    removed += page.items.length;
    if (page.isDone) break;
    cursor = page.cursor;
  }
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  for (let cursor: string | null = null; ; ) {
    const page: { items: StoredFile[]; cursor: string; isDone: boolean } = await ctx.runQuery(internal.offsite._toCopy, { cursor });
    const done: { storageId: Id<"_storage">; key: string; size: number }[] = [];
    for (const f of page.items) {
      if (copied >= FILES_PER_RUN || bytes >= FILES_BYTES_PER_RUN || Date.now() - startedAt > FILES_TIME_MS) {
        if (done.length) await ctx.runMutation(internal.offsite._copied, { items: done });
        return { copied, removed, skipped, more: true };
      }
      if (store.maxBytes !== null && f.size > store.maxBytes) {
        skipped++;
        continue;
      }
      const blob = await ctx.storage.get(f.storageId);
      if (!blob) continue;
      const key = `${prefix}${FILES_PREFIX}${f.storageId}`;
      await store.put(key, blob, f.contentType ?? "application/octet-stream");
      done.push({ storageId: f.storageId, key, size: f.size });
      copied++;
      bytes += f.size;
    }
    if (done.length) await ctx.runMutation(internal.offsite._copied, { items: done });
    if (page.isDone) return { copied, removed, skipped, more: false };
    cursor = page.cursor;
  }
}

// ── Копия ────────────────────────────────────────────────────────────────────

/** Выгрузить копию во внешнее хранилище, убрать старые и (если включено) синхронизировать файлы. */
export const push = internalAction({
  args: { backupId: v.id("backups") },
  handler: async (ctx, { backupId }): Promise<void> => {
    const store = offsiteStore();
    if (!store) return;
    const b = await ctx.runQuery(internal.offsite._backup, { backupId });
    if (!b) return;
    const started = Date.now();
    try {
      const blob = await ctx.storage.get(b.fileId);
      if (!blob) throw new Error("файл копии не найден в хранилище");
      if (store.maxBytes !== null && blob.size > store.maxBytes) throw new Error("копия больше 25 МБ — Workers KV её не примет, нужно S3-хранилище (BACKUP_S3_*)");
      const prefix = tenantPrefix(b.tenantId);
      await store.put(`${prefix}${BACKUP_PREFIX}${backupName(b.at)}`, blob, "application/json");
      const pruned = await pruneBackups(store, prefix);
      const files = b.copyFiles ? await syncFiles(ctx, store, started, prefix) : null;
      await ctx.runMutation(internal.offsite._pushed, { backupId, pruned, files: files ?? undefined });
    } catch (e) {
      const reason = storeErrorText(e);
      console.error(`Внешнее хранилище: ${reason}`);
      await ctx.runMutation(internal.offsite._failed, { reason });
    }
  },
});

export const _pushed = internalMutation({
  args: { backupId: v.id("backups"), pruned: v.number(), files: v.optional(v.object({ copied: v.number(), removed: v.number(), skipped: v.number(), more: v.boolean() })) },
  handler: async (ctx, { backupId, pruned, files }): Promise<void> => {
    if (await ctx.db.get(backupId)) await ctx.db.patch(backupId, { offsiteAt: nowIso() });
    const filesNote = files
      ? `; файлов скопировано: ${files.copied}${files.removed ? `, удалено: ${files.removed}` : ""}${files.skipped ? `, пропущено больше 25 МБ: ${files.skipped}` : ""}${files.more ? " (остальные — следующей ночью)" : ""}`
      : "";
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
    const store = offsiteStore();
    const mark = await ctx.db
      .query("systemStatus")
      .withIndex("by_key", (q) => q.eq("key", "offsite"))
      .unique();
    return {
      configured: !!store,
      provider: store?.provider ?? null,
      missing: offsiteMissing(),
      host: store?.where.host,
      bucket: store?.where.bucket,
      region: store?.where.region,
      maxFileMb: store?.maxBytes ? Math.floor(store.maxBytes / (1024 * 1024)) : undefined,
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
