// Опись файлов в резервной копии (ТЗ п.20.10): какие файлы хранилища на что ссылаются. Сами файлы в JSON-копию
// не входят (их копирует во внешнее хранилище offsite.ts, если владелец включил), опись нужна, чтобы при
// восстановлении было видно, каких файлов не хватает и к чему они относились.
import type { Value } from "convex/values";

export interface FileRef {
  storageId: string;
  /** Таблица и документ, к которому относится файл. */
  table: string;
  docId: string;
  /** «Запись звонка», «Файл заказа №1024: фото.jpg». */
  about: string;
}

/** Строка в описи: ссылка + сведения из хранилища. missing — файла в хранилище уже нет. */
export interface FileEntry extends FileRef {
  size?: number;
  contentType?: string;
  missing?: true;
}

const str = (v: Value | undefined): string | undefined => (typeof v === "string" ? v : undefined);

function attachmentRefs(doc: Record<string, Value>, table: string, prefix: string): FileRef[] {
  const files = doc.files;
  if (!Array.isArray(files)) return [];
  const out: FileRef[] = [];
  for (const f of files) {
    if (!f || typeof f !== "object" || Array.isArray(f) || f instanceof ArrayBuffer) continue;
    const a = f as Record<string, Value>;
    const id = str(a.storageId);
    if (id) out.push({ storageId: id, table, docId: String(doc._id), about: `${prefix}: ${str(a.name) ?? "файл"}` });
  }
  return out;
}

/** Ссылки документа на файлы хранилища (по таблицам, где они бывают). */
export function fileRefs(table: string, doc: Record<string, Value>): FileRef[] {
  const docId = String(doc._id);
  switch (table) {
    case "orders":
      return attachmentRefs(doc, table, `Файл заказа №${String(doc.number ?? "")}`);
    case "messages":
      return attachmentRefs(doc, table, "Вложение в переписке по заказу");
    case "calls": {
      const id = str(doc.recordingId);
      return id ? [{ storageId: id, table, docId, about: "Запись звонка" }] : [];
    }
    case "conversationMessages": {
      const id = str(doc.fileId);
      return id ? [{ storageId: id, table, docId, about: "Вложение в переписке с клиентом" }] : [];
    }
    default:
      return [];
  }
}
