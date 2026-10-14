// Журнал действий в интерфейсе: фильтры экрана. Выгрузку в CSV по этим же фильтрам собирает сервер
// (convex/exports.ts, kind "audit") — все записи периода, а не только загруженные на экран.
import type { Id } from "../../convex/_generated/dataModel";
import type { AuditEntity } from "./types";

export interface AuditFilters {
  from?: string;
  /** Сотрудник или "system" — система, AI и каналы. */
  actorId?: Id<"users"> | "system";
  entity?: AuditEntity;
  q?: string;
}
