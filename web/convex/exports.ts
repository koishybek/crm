// Выгрузки CSV (владелец и сотрудники с правом «Выгрузка в Excel») (ТЗ п.26.9 «Экспорт CSV/Excel»): заявки, заказы, звонки, исполнители, оплаты, выплаты и журнал
// за выбранный период. Файл собирается на сервере постранично (не только то, что загружено в браузер), ячейки защищены
// от формул (src/lib/csv.ts), кодировка — UTF-8 с BOM. Готовый файл отдаётся только по подписанной ссылке на 15 минут,
// хранится сутки и удаляется уборкой; каждая выгрузка — в журнале (без персональных данных в деталях).
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery, type ActionCtx } from "./lib/functions";
import { requireRole, STAFF, type Me } from "./lib/access";
import { almatyStamp, audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { exportPage, EXPORT_HEADERS, executorStatsPage, type AuditExportFilters, type Cell, type ExecutorStat, type ExportPage, type ExportRange, type ExportRow } from "./lib/exportRows";
import { dropFile, ensureSigningKey, fileSigner } from "./lib/files";
import { hitLimit } from "./lib/rateLimit";
import { buildAccountingFile } from "./accounting";
import { auditEntity } from "./schema";
import { AUDIT_QUERY_MAX } from "../src/data/audit";
import { EXPORT_KIND, EXPORT_KINDS, EXPORT_MAX_ROWS, EXPORT_TTL_MS, exportFileName, type ExportKind } from "../src/data/exports";
import { exportAllowed, exportColumns } from "../src/data/exportAccess";
import { toCsv } from "../src/lib/csv";
import { num, plural } from "../src/lib/format";
import { perTenant } from "./lib/tenant";

const exportKind = v.union(...EXPORT_KINDS.map((k) => v.literal(k)));
/** Выгрузок одного владельца в час — тяжёлые запросы, а не кнопка для нажатий подряд. */
const EXPORTS_PER_HOUR = 30;
/** Устаревших выгрузок за один проход уборки. */
const CLEANUP_BATCH = 100;

export interface ExportResult {
  url: string;
  name: string;
  rows: number;
  /** Строк больше EXPORT_MAX_ROWS — в файле первые из них; период стоит сузить. */
  truncated: boolean;
}

/** Выгрузка — только с правом на неё и на сами данные (src/data/exportAccess.ts). */
async function exporter(ctx: Parameters<typeof requireRole>[0], kind: ExportKind): Promise<Me> {
  const me = await requireRole(ctx, STAFF);
  if (!exportAllowed(me, kind)) throw new ConvexError(`Нет доступа к выгрузке «${EXPORT_KIND[kind].label}» — права выдаёт владелец`);
  return me;
}

/**
 * Проверка до сборки файла: права, период — даты по порядку, не чаще EXPORTS_PER_HOUR в час. columns — какие колонки
 * пользователь видит (деньги — по правам).
 */
export const _start = internalMutation({
  args: { kind: exportKind, from: v.string(), to: v.string() },
  handler: async (ctx, a): Promise<{ range: ExportRange; columns: number[] }> => {
    const me = await exporter(ctx, a.kind);
    const from = Date.parse(a.from);
    const to = Date.parse(a.to);
    if (Number.isNaN(from) || Number.isNaN(to)) throw new ConvexError("Неверная дата периода");
    if (from > to) throw new ConvexError("Начало периода позже конца");
    if (!(await hitLimit(ctx, `export:${me._id}`, EXPORTS_PER_HOUR, 3600_000))) throw new ConvexError("Слишком много выгрузок подряд — попробуйте через час");
    // Ссылку на готовый файл подписываем — ключ подписи должен быть (без FILES_SIGNING_KEY он создаётся один раз).
    await ensureSigningKey(ctx);
    return { range: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, columns: exportColumns(me, a.kind, EXPORT_HEADERS[a.kind]) };
  },
});

const auditArgs = { actorId: v.optional(v.union(v.id("users"), v.literal("system"))), entity: v.optional(auditEntity), q: v.optional(v.string()) };

export const _page = internalQuery({
  args: { kind: exportKind, from: v.string(), to: v.string(), cursor: v.union(v.string(), v.null()), ...auditArgs },
  handler: (ctx, { kind, from, to, cursor, ...filters }): Promise<ExportPage> => exportPage(ctx, kind, { from, to }, cursor, filters),
});

export const _stats = internalQuery({
  args: { source: v.union(v.literal("orders"), v.literal("payouts")), from: v.string(), to: v.string(), cursor: v.union(v.string(), v.null()) },
  handler: (ctx, { source, from, to, cursor }) => executorStatsPage(ctx, source, { from, to }, cursor),
});

/** Файл сохранён: строка выгрузки со сроком, запись в журнале, подписанная ссылка для скачивания. */
export const _saved = internalMutation({
  args: { kind: exportKind, from: v.string(), to: v.string(), rows: v.number(), size: v.number(), fileId: v.id("_storage"), truncated: v.boolean(), filtered: v.boolean() },
  handler: async (ctx, a): Promise<{ url: string; name: string }> => {
    const me = await exporter(ctx, a.kind);
    const now = Date.now();
    const id = await ctx.db.insert("exports", { kind: a.kind, from: a.from, to: a.to, rows: a.rows, size: a.size, fileId: a.fileId, by: me._id, at: nowIso(), expiresAt: new Date(now + EXPORT_TTL_MS).toISOString() });
    const name = exportFileName(a.kind, a);
    const what = `${EXPORT_KIND[a.kind].label} за ${almatyStamp(a.from)} — ${almatyStamp(a.to)}`;
    // В деталях — только что и за какой период: ни имён, ни телефонов, ни текста поиска.
    await audit(ctx, me, "export.created", `Выгрузка: ${what}${a.filtered ? " (по фильтрам журнала)" : ""} — ${num(a.rows)} ${plural(a.rows, "строка", "строки", "строк")}${a.truncated ? `, файл обрезан до ${num(EXPORT_MAX_ROWS)}` : ""}`, {
      entityId: id,
      meta: { kind: a.kind, from: a.from, to: a.to, rows: a.rows, size: a.size, ...(a.truncated ? { truncated: true } : {}), ...(a.filtered ? { filtered: true } : {}) },
    });
    const url = (await fileSigner(ctx)).url(a.fileId, name);
    if (!url) throw new ConvexError("Не удалось подготовить ссылку на файл: у сервера не задан адрес (CONVEX_SITE_URL)");
    return { url, name };
  },
});

const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Все страницы выгрузки подряд: без повторов, не больше EXPORT_MAX_ROWS, по времени. */
async function collect(ctx: ActionCtx, kind: ExportKind, range: ExportRange, filters: AuditExportFilters): Promise<{ rows: ExportRow[]; truncated: boolean }> {
  const seen = new Set<string>();
  const rows: ExportRow[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page: ExportPage = await ctx.runQuery(internal.exports._page, { kind, ...range, cursor, ...filters });
    for (const r of page.rows) {
      if (seen.has(r.key)) continue;
      if (rows.length >= EXPORT_MAX_ROWS) return { rows: rows.sort((a, b) => order(a.sort, b.sort)), truncated: true };
      seen.add(r.key);
      rows.push(r);
    }
    if (page.isDone) break;
    cursor = page.cursor;
  }
  return { rows: rows.sort((a, b) => order(a.sort, b.sort)), truncated: false };
}

/** Заказы и выплаты исполнителей за период — по страницам, суммой по мастеру. */
async function executorStats(ctx: ActionCtx, range: ExportRange): Promise<Map<string, ExecutorStat>> {
  const total = new Map<string, ExecutorStat>();
  for (const source of ["orders", "payouts"] as const) {
    let cursor: string | null = null;
    for (;;) {
      const page: { stats: ExecutorStat[]; cursor: string; isDone: boolean } = await ctx.runQuery(internal.exports._stats, { source, ...range, cursor });
      for (const s of page.stats) {
        const t = total.get(s.executorId) ?? { executorId: s.executorId, done: 0, accrued: 0, paid: 0 };
        total.set(s.executorId, { executorId: s.executorId, done: t.done + s.done, accrued: t.accrued + s.accrued, paid: t.paid + s.paid });
      }
      if (page.isDone) break;
      cursor = page.cursor;
    }
  }
  return total;
}

/**
 * Выгрузка за период → CSV-файл в хранилище → подписанная ссылка на скачивание (15 минут; файл живёт сутки).
 * Для журнала — те же фильтры, что на его экране: кто действовал, тип объекта, текст.
 */
export const create = action({
  args: { kind: exportKind, from: v.string(), to: v.string(), ...auditArgs },
  handler: async (ctx, { kind, from, to, ...auditFilters }): Promise<ExportResult> => {
    const { range, columns } = await ctx.runMutation(internal.exports._start, { kind, from, to });
    if (kind === "accounting" || kind === "commerceml") {
      const file = await buildAccountingFile(ctx, kind, range);
      return saveFile(ctx, kind, range, file.blob, file.rows, file.truncated, false);
    }
    const filters: AuditExportFilters = kind === "audit" ? { ...auditFilters, q: auditFilters.q?.trim().slice(0, AUDIT_QUERY_MAX) || undefined } : {};
    const { rows, truncated } = await collect(ctx, kind, range, filters);
    let cells: Cell[][] = rows.map((r) => r.cells);
    if (kind === "executors") {
      const stats = await executorStats(ctx, range);
      cells = rows.map((r) => {
        const s = stats.get(r.key);
        return [...r.cells, s?.done ?? 0, s?.accrued ?? 0, s?.paid ?? 0];
      });
    }
    const pick = <T>(row: readonly T[]): T[] => columns.map((i) => row[i]!);
    const blob = new Blob([toCsv([pick(EXPORT_HEADERS[kind]), ...cells.map(pick)])], { type: "text/csv;charset=utf-8" });
    const filtered = kind === "audit" && Object.values(filters).some((x) => x !== undefined);
    return saveFile(ctx, kind, range, blob, cells.length, truncated, filtered);
  },
});

/** Файл → хранилище → строка выгрузки, журнал, подписанная ссылка. */
async function saveFile(ctx: ActionCtx, kind: ExportKind, range: ExportRange, blob: Blob, rows: number, truncated: boolean, filtered: boolean): Promise<ExportResult> {
  const fileId = await ctx.storage.store(blob);
  try {
    const saved = await ctx.runMutation(internal.exports._saved, { kind, ...range, rows, size: blob.size, fileId, truncated, filtered });
    return { ...saved, rows, truncated };
  } catch (e) {
    // Строки о файле нет — без неё его никто не увидит и не удалит.
    await ctx.storage.delete(fileId).catch(() => undefined);
    throw e;
  }
}

/** Крон: выгрузки старше суток удаляются вместе с файлом — ссылку на них уже не получить. */
export const cleanup = internalMutation({
  args: {},
  handler: async (cronCtx): Promise<{ removed: number }> => perTenant(cronCtx, internal.exports.cleanup, { removed: 0 }, async (ctx) => {
    const old = await ctx.db
      .query("exports")
      .withIndex("by_expires", (q) => q.lt("expiresAt", nowIso()))
      .take(CLEANUP_BATCH);
    for (const x of old) {
      await dropFile(ctx, x.fileId);
      await ctx.db.delete(x._id);
    }
    return { removed: old.length };
  }),
});
