export type CsvValue = string | number | null | undefined;

/**
 * CSV/Excel-инъекция формул (OWASP): Excel, LibreOffice и Google Sheets исполняют ячейку как формулу,
 * если она начинается с = + - @ (в том числе полноширинных и после пробелов), табуляции, CR или LF —
 * даже в кавычках. Имена клиентов приходят от анонимов (Telegram, AI), поэтому такой ячейке ставим
 * апостроф — она откроется как текст. Числа не трогаем: формулой они быть не могут, а минус у суммы
 * должен остаться числом.
 */
const FORMULA_START = /^[\t\r\n]|^\s*[=+\-@＝＋－＠]/;

/** Одна ячейка: в кавычках, внутренние кавычки удвоены, опасное начало обезврежено. */
export function csvCell(x: CsvValue): string {
  if (typeof x === "number") return Number.isFinite(x) ? `"${x}"` : '""';
  const s = String(x ?? "");
  return `"${(FORMULA_START.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

/** Таблица для Excel: «;» как разделитель и BOM, чтобы кириллица открылась без танцев. */
export function toCsv(rows: readonly (readonly CsvValue[])[]): string {
  return "﻿" + rows.map((r) => r.map(csvCell).join(";")).join("\r\n");
}

/** Выгрузка таблицы в CSV-файл (скачивание в браузере). */
export function exportCsv(rows: readonly (readonly CsvValue[])[], name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);
