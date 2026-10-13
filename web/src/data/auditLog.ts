// Журнал действий в интерфейсе: фильтры экрана и выгрузка в CSV всех записей по фильтрам —
// не только тех, что уже загружены на экран.
import type { PaginationResult } from "convex/server";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run, type Result } from "./convex";
import type { AuditEntity, AuditEntry } from "./types";

export interface AuditFilters {
  from?: string;
  /** Сотрудник или "system" — система, AI и каналы. */
  actorId?: Id<"users"> | "system";
  entity?: AuditEntity;
  q?: string;
}

/** Предел выгрузки: больше — это уже резервная копия, а не таблица для Excel; выгружайте по периодам. */
export const AUDIT_EXPORT_MAX = 20_000;

/** Все записи по фильтрам, новые сверху. truncated — упёрлись в AUDIT_EXPORT_MAX. */
export function fetchAuditForExport(filters: AuditFilters): Promise<Result<{ rows: AuditEntry[]; truncated: boolean }>> {
  return run(
    (async () => {
      const rows: AuditEntry[] = [];
      let cursor: string | null = null;
      for (;;) {
        const res: PaginationResult<AuditEntry> = await convex.query(api.audit.list, { ...filters, paginationOpts: { numItems: 200, cursor } });
        rows.push(...res.page);
        if (rows.length >= AUDIT_EXPORT_MAX) return { rows: rows.slice(0, AUDIT_EXPORT_MAX), truncated: true };
        if (res.isDone) return { rows, truncated: false };
        cursor = res.continueCursor;
      }
    })(),
  );
}
