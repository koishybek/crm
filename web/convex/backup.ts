// Резервные копии (ТЗ п.20, п.26): каждую ночь — JSON-снимок бизнес-таблиц в файловом хранилище Convex,
// храним 14 последних; с описью файлов (lib/backupFiles.ts) и, если подключено, — копией во внешнем хранилище (offsite.ts).
// Секреты (токены интеграций, хэши ключей API, коды привязки Telegram, секреты настроек)
// и служебные таблицы (вход, лимиты, OAuth) в копию не попадают. Копия внутри деплоймента от потери самого
// деплоймента не спасает — для этого внешнее хранилище; восстановление — scripts/restore.ts.
import { ConvexError, v, type Value } from "convex/values";
import { internal } from "./_generated/api";
import type { Id, TableNames } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./lib/functions";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { fileRefs, type FileEntry, type FileRef } from "./lib/backupFiles";
import { dropFile, ensureSigningKey, fileSigner } from "./lib/files";
import { markError, markOk } from "./lib/health";
import { hitLimit } from "./lib/rateLimit";
import { offsiteStore } from "./lib/offsiteStore";
import { actionFor } from "./lib/tenantDb";
import { fileSize, type BackupList } from "../src/data/systemHealth";

/** Сколько последних копий храним. */
export const KEEP_BACKUPS = 14;
/** Ручной запуск — не чаще раза в 10 минут. */
const MANUAL_EVERY_MS = 10 * 60_000;
/**
 * Документов на одну страницу чтения: страница — отдельная транзакция, ответ — с запасом до лимита размера.
 * У звонков в документе расшифровка (до 20 000 символов) — их страница меньше.
 */
const PAGE = 100;
const PAGE_OF: Partial<Record<TableNames, number>> = { calls: 25 };
/** 2 — добавлена опись файлов («files»). Восстановление (scripts/restore.ts) понимает обе версии. */
export const BACKUP_VERSION = 2;

/** Что копируем: всё, с чем работает бизнес. */
export const BACKUP_TABLES = [
  "users",
  "executors",
  "clients",
  "leads",
  "orders",
  "messages",
  "history",
  "interactions",
  "clientNotes",
  "categories",
  "services",
  "calls",
  "settings",
  "botChats",
  "counters",
  "audit",
  "conversations",
  "conversationMessages",
  "clientNotices",
  "integrations",
  "apiKeys",
  "apiLeads",
  "reviews",
  "reviewRequests",
  "adSpend",
  "payouts",
  "campaignSpend",
  "webhooks",
  "paymentIntents",
  "documents",
] as const satisfies readonly TableNames[];
export type BackupTable = (typeof BACKUP_TABLES)[number];

/**
 * Что не копируем: вход и сессии (auth*), счётчики лимитов, одноразовые OAuth-state, сами копии,
 * колокольчик, отметки мониторинга, принятые обновления Telegram, служебный учёт загрузок (самих файлов в копии нет)
 * отметки эскалаций (живут неделю-две и после восстановления не нужны), выгрузки CSV (временные файлы на сутки) и предрасчёт
 * аналитики (stats*, dailyStats — после восстановления его заново соберёт крон: statsState в копию не попадает) —
 * их не восстанавливают.
 */
const SKIPPED_TABLES = ["tenants", "rateLimits", "oauthStates", "backups", "notifications", "systemStatus", "telegramUpdates", "uploads", "escalations", "exports", "webhookDeliveries", "statsFacts", "dailyStats", "statsDirty", "statsState", "pushSubscriptions", "clientErrors", "offsiteFiles", "subscriptionPayments", "platformSettings"] as const satisfies readonly TableNames[];
// Новая таблица в схеме не должна молча выпасть из копий: её нужно явно отнести к BACKUP_TABLES или SKIPPED_TABLES.
type Unsorted = Exclude<TableNames, BackupTable | (typeof SKIPPED_TABLES)[number] | `auth${string}`>;
const allTablesSorted: [Unsorted] extends [never] ? true : Unsorted = true;
void allTablesSorted;

/** Поля-секреты, которые вырезаются из копии. */
const SECRET_FIELDS: Partial<Record<BackupTable, readonly string[]>> = {
  integrations: ["accessToken", "refreshToken"],
  users: ["telegramLinkCode", "telegramLinkExpiresAt"],
  apiKeys: ["hash"],
  reviewRequests: ["token"],
  webhooks: ["secret"],
  documents: ["publicTokenHash", "publicExpiresAt"],
};
/** Настройки-секреты (ключ АТС и т.п.) не копируются целиком. */
const SECRET_SETTING = /secret|token|key/i;

const isBackupTable = (t: string): t is BackupTable => (BACKUP_TABLES as readonly string[]).includes(t);

/** Документ для копии: без секретов; null — не копировать вовсе. */
export function scrub(table: BackupTable, doc: Record<string, Value>): Record<string, Value> | null {
  if (table === "settings" && SECRET_SETTING.test(String(doc.key))) return null;
  const drop = SECRET_FIELDS[table];
  return drop ? Object.fromEntries(Object.entries(doc).filter(([k]) => !drop.includes(k))) : doc;
}

type Page = { docs: Record<string, Value>[]; cursor: string; isDone: boolean };

/** Сведения о файлах из хранилища для описи: размер и тип; нет строки — файла уже нет. */
export const _fileMeta = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }): Promise<{ id: string; size: number; contentType?: string }[]> => {
    const out: { id: string; size: number; contentType?: string }[] = [];
    for (const raw of ids) {
      const id = ctx.db.system.normalizeId("_storage", raw);
      const meta = id ? await ctx.db.system.get(id) : null;
      if (meta) out.push({ id: raw, size: meta.size, contentType: meta.contentType });
    }
    return out;
  },
});

/** Опись: каждая ссылка на файл + размер и тип из хранилища. */
async function inventory(ctx: ActionCtx, refs: FileRef[]): Promise<FileEntry[]> {
  const meta = new Map<string, { size: number; contentType?: string }>();
  const ids = [...new Set(refs.map((r) => r.storageId))];
  for (let i = 0; i < ids.length; i += 200) {
    for (const m of await ctx.runQuery(internal.backup._fileMeta, { ids: ids.slice(i, i + 200) })) meta.set(m.id, m);
  }
  return refs.map((r) => {
    const m = meta.get(r.storageId);
    return m ? { ...r, size: m.size, ...(m.contentType ? { contentType: m.contentType } : {}) } : { ...r, missing: true as const };
  });
}

export const _page = internalQuery({
  args: { table: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { table, cursor }): Promise<Page> => {
    if (!isBackupTable(table)) throw new ConvexError("Таблица не входит в резервную копию");
    const res = await ctx.db.query(table).paginate({ cursor, numItems: PAGE_OF[table] ?? PAGE });
    const docs = res.page.map((d) => scrub(table, d as unknown as Record<string, Value>)).filter((d): d is Record<string, Value> => d !== null);
    return { docs, cursor: res.continueCursor, isDone: res.isDone };
  },
});

/**
 * Снимок → файл в хранилище → строка в «Резервных копиях». by — кто запустил вручную.
 * JSON собираем по страницам сразу в байты (UTF-8): в памяти действия — сам файл, без второй копии в объектах.
 */
export const run = internalAction({
  args: { by: v.optional(v.id("users")), tenantId: v.optional(v.string()) },
  handler: async (ctx, { by, tenantId }): Promise<void> => {
    // Копия — у каждой компании своя (ТЗ §2.5): ручной запуск — своей, ночной крон — всех по очереди.
    const tenants = tenantId ? [tenantId] : await ctx.runQuery(internal.tenants._active, {});
    for (const t of tenants) await backupTenant(actionFor(ctx, t), by);
  },
});

async function backupTenant(ctx: ActionCtx, by: Id<"users"> | undefined): Promise<void> {
  let fileId: Id<"_storage"> | null = null;
  try {
    const at = new Date().toISOString();
    const utf8 = new TextEncoder();
    const parts: Uint8Array<ArrayBuffer>[] = [utf8.encode(`{"version":${BACKUP_VERSION},"createdAt":${JSON.stringify(at)},"tables":{`)];
    let docs = 0;
    const refs: FileRef[] = [];
    for (const [i, table] of BACKUP_TABLES.entries()) {
      parts.push(utf8.encode(`${i ? "," : ""}${JSON.stringify(table)}:[`));
      let cursor: string | null = null;
      let count = 0;
      for (;;) {
        const page: Page = await ctx.runQuery(internal.backup._page, { table, cursor });
        if (page.docs.length) parts.push(utf8.encode(`${count ? "," : ""}${page.docs.map((d) => JSON.stringify(d)).join(",")}`));
        for (const d of page.docs) refs.push(...fileRefs(table, d));
        count += page.docs.length;
        if (page.isDone) break;
        cursor = page.cursor;
      }
      parts.push(utf8.encode("]"));
      docs += count;
    }
    // Опись файлов — после таблиц: сами файлы в JSON не входят.
    parts.push(utf8.encode(`},"files":${JSON.stringify(await inventory(ctx, refs))}}`));
    const blob = new Blob(parts, { type: "application/json" });
    parts.length = 0;
    fileId = await ctx.storage.store(blob);
    await ctx.runMutation(internal.backup._saved, { fileId, at, size: blob.size, docs, by });
  } catch (e) {
    const reason = e instanceof ConvexError ? String(e.data) : e instanceof Error ? e.message.slice(0, 200) : "неизвестная ошибка";
    console.error(`Резервная копия не создана: ${reason}`);
    // Файл записали, а строку о нём — нет: без строки его никто не увидит и не удалит.
    if (fileId) await ctx.storage.delete(fileId).catch(() => undefined);
    await ctx.runMutation(internal.backup._failed, { reason, manual: !!by });
  }
}

export const _saved = internalMutation({
  args: { fileId: v.id("_storage"), at: v.string(), size: v.number(), docs: v.number(), by: v.optional(v.id("users")) },
  handler: async (ctx, a): Promise<Id<"backups">> => {
    const id = await ctx.db.insert("backups", { at: a.at, fileId: a.fileId, size: a.size, docs: a.docs, by: a.by });
    // Скачивание копии — по подписанной ссылке: ключ подписи должен быть.
    await ensureSigningKey(ctx);
    const old = (await ctx.db.query("backups").withIndex("by_at").order("desc").collect()).slice(KEEP_BACKUPS);
    for (const b of old) {
      await dropFile(ctx, b.fileId);
      await ctx.db.delete(b._id);
    }
    await markOk(ctx, "backup", `${a.docs} записей, ${fileSize(a.size)}`);
    // Внешнее хранилище подключено — та же копия уходит и туда (offsite.ts).
    if (offsiteStore()) await ctx.scheduler.runAfter(0, internal.offsite.push, { backupId: id });
    await audit(ctx, "Система", "system.backupCreated", `Резервная копия создана: ${a.docs} записей, ${fileSize(a.size)}${old.length ? `; старых копий удалено: ${old.length}` : ""}`, {
      entityId: id,
      meta: { docs: a.docs, size: a.size, removed: old.length, manual: !!a.by },
    });
    return id;
  },
});

export const _failed = internalMutation({
  args: { reason: v.string(), manual: v.boolean() },
  handler: async (ctx, { reason, manual }): Promise<void> => {
    await markError(ctx, "backup", `Копия не создана: ${reason}`);
    await audit(ctx, "Система", "system.backupFailed", `Резервная копия не создана: ${reason.slice(0, 200)}`, { meta: { manual } });
  },
});

/** Имя файла копии при скачивании: «homemax-backup-2026-10-13-0200.json» (время — по Алматы). */
export const backupName = (at: string) => `homemax-backup-${new Date(Date.parse(at) + 5 * 3600_000).toISOString().slice(0, 16).replace("T", "-").replace(":", "")}.json`;

/**
 * Копии для владельца: свежие сверху, с подписанной ссылкой на скачивание (15 минут) и состоянием последней попытки.
 * t — метка обновления ссылок (src/data/files.ts).
 */
export const list = query({
  args: { t: v.optional(v.number()) },
  handler: async (ctx): Promise<BackupList> => {
    await requireRole(ctx, OWNER);
    const signer = await fileSigner(ctx);
    const [rows, status] = await Promise.all([
      ctx.db.query("backups").withIndex("by_at").order("desc").take(KEEP_BACKUPS),
      ctx.db
        .query("systemStatus")
        .withIndex("by_key", (q) => q.eq("key", "backup"))
        .unique(),
    ]);
    return {
      keep: KEEP_BACKUPS,
      items: rows.map((b) => ({ id: b._id, at: b.at, size: b.size, docs: b.docs, manual: !!b.by, url: signer.url(b.fileId, backupName(b.at)), offsite: !!b.offsiteAt })),
      lastError: status?.errorAt && (!status.okAt || status.errorAt > status.okAt) ? { at: status.errorAt, text: status.error ?? "Ошибка" } : undefined,
    };
  },
});

/** «Сделать копию сейчас» — копия создаётся в фоне и появляется в списке через минуту. */
export const runNow = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    if (!(await hitLimit(ctx, `backup:manual:${me.tenantId}`, 1, MANUAL_EVERY_MS))) throw new ConvexError("Копию уже запускали меньше 10 минут назад — подождите немного");
    await ctx.scheduler.runAfter(0, internal.backup.run, { by: me._id });
    await audit(ctx, me, "system.backupRequested", "Запущено резервное копирование вручную");
  },
});
