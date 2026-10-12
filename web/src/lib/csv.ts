/** Выгрузка таблицы в CSV для Excel: «;» как разделитель и BOM, чтобы кириллица открылась без танцев. */
export function exportCsv(rows: (string | number | undefined)[][], name: string) {
  const csv = "﻿" + rows.map((r) => r.map((x) => `"${String(x ?? "").replace(/"/g, '""')}"`).join(";")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 10);
