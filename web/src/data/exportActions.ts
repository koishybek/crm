// Выгрузки владельца в CSV: файл собирает сервер (convex/exports.ts) и отдаёт подписанную ссылку на 15 минут.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run, type Result } from "./convex";
import { EXPORT_MAX_ROWS, type ExportKind, type ExportRange } from "./exports";
import type { AuditEntity } from "./types";
import { num, plural } from "../lib/format";

export interface ExportRequest extends ExportRange {
  kind: ExportKind;
  /** Только для журнала: те же фильтры, что на его экране. */
  actorId?: Id<"users"> | "system";
  entity?: AuditEntity;
  q?: string;
}

export interface ExportDone {
  url: string;
  name: string;
  rows: number;
  truncated: boolean;
}

export const createExport = (r: ExportRequest): Promise<Result<ExportDone>> => run(convex.action(api.exports.create, r));

/** Сообщение о готовом файле: сколько строк и не обрезан ли он. */
export function exportedText(rows: number, truncated: boolean): string {
  if (truncated) return `Выгружены первые ${num(EXPORT_MAX_ROWS)} строк — для остальных выберите период короче`;
  return rows ? `Файл готов: ${num(rows)} ${plural(rows, "строка", "строки", "строк")}` : "За выбранный период записей нет — файл только с заголовками";
}

/** Скачать файл по ссылке: сервер отдаёт его вложением с именем (Content-Disposition), страница остаётся на месте. */
export function downloadFile(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
