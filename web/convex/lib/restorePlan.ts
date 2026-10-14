// Восстановление из резервной копии (ТЗ п.20.10, п.26.5): разбор файла копии и план — без обращения к базе.
// Convex не даёт вставить документ со своим _id, поэтому каждый документ получает новый id, а все ссылки на старые
// id (поля v.id, id в журнале и истории) переписываются по таблице соответствия. Ссылка на документ, который ещё не
// вставлен (взаимные ссылки таблиц), откладывается и дописывается вторым проходом. Пользуются scripts/restore.ts
// (вставка через convex/restore.ts) и тесты.
import { fileRefs, type FileEntry } from "./backupFiles";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type BackupDoc = { [k: string]: Json };

export interface BackupData {
  version: number;
  createdAt: string;
  tables: Record<string, BackupDoc[]>;
  /** Запись компании и её оплаты подписки (копии с 14.10.2026); в старых копиях — нет. */
  company?: { row: Record<string, unknown> | null; payments: Record<string, unknown>[] };
  /** Опись файлов (версия 2+); у версии 1 собирается по документам. */
  files: FileEntry[];
}

/** Таблицы из копии, которые не восстанавливаются: без вырезанных из копии секретов строки бесполезны. */
export const NOT_RESTORED: Readonly<Record<string, string>> = {
  apiKeys: "ключи API хранятся только хэшем, его в копии нет — выпустите ключи заново",
  apiLeads: "привязки заявок к ключам API — ключи выпускаются заново",
  reviewRequests: "одноразовые ссылки на отзыв — токенов в копии нет",
  webhooks: "секрета подписи в копии нет — добавьте вебхуки заново",
};

/** Таблицы, которые сливаются с тем, что уже есть на деплойменте (настройки по ключу, подключения по провайдеру). */
export const MERGED_TABLES = ["settings", "integrations"] as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Разобрать файл копии; ошибка — понятным текстом. */
export function parseBackup(raw: unknown): BackupData {
  if (!isObj(raw) || !isObj(raw.tables)) throw new Error("Это не файл резервной копии: нет раздела tables");
  const version = Number(raw.version);
  if (version !== 1 && version !== 2) throw new Error(`Версия копии ${String(raw.version)} не поддерживается (знаю 1 и 2)`);
  const tables: Record<string, BackupDoc[]> = {};
  for (const [name, docs] of Object.entries(raw.tables)) {
    if (!Array.isArray(docs) || docs.some((d) => !isObj(d) || typeof d._id !== "string")) throw new Error(`Таблица ${name} в копии повреждена`);
    tables[name] = docs as BackupDoc[];
  }
  const files = Array.isArray(raw.files) ? (raw.files as FileEntry[]) : Object.entries(tables).flatMap(([t, docs]) => docs.flatMap((d) => fileRefs(t, d)));
  const company = isObj(raw.company) && Array.isArray(raw.company.payments) ? { row: isObj(raw.company.row) ? raw.company.row : null, payments: raw.company.payments.filter(isObj) } : undefined;
  return { version, createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "", tables, files, company };
}

/** Все id документов копии → таблица. */
export function idIndex(data: BackupData): Map<string, string> {
  const m = new Map<string, string>();
  for (const [t, docs] of Object.entries(data.tables)) for (const d of docs) m.set(d._id as string, t);
  return m;
}

/** Строки внутри значения (глубоко). */
function* strings(v: Json): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

/**
 * Порядок вставки: сначала таблицы, на которые ссылаются (исполнители раньше заказов). Взаимные ссылки
 * ломают порядок — такие таблицы идут в исходном порядке, а ссылки дописываются вторым проходом.
 */
export function tableOrder(data: BackupData, tables: readonly string[]): string[] {
  const ids = idIndex(data);
  const deps = new Map<string, Set<string>>();
  for (const t of tables) {
    const d = new Set<string>();
    for (const doc of data.tables[t] ?? []) {
      for (const [k, v] of Object.entries(doc)) {
        if (k === "_id") continue;
        for (const s of strings(v)) {
          const ref = ids.get(s);
          if (ref && ref !== t && tables.includes(ref)) d.add(ref);
        }
      }
    }
    deps.set(t, d);
  }
  const order: string[] = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) => [...deps.get(t)!].every((d) => !left.has(d)));
    const next = ready.length ? ready : [[...left][0]!];
    for (const t of next) {
      order.push(t);
      left.delete(t);
    }
  }
  return order;
}

/** Заменить старые id новыми (глубоко); строки из drop (файлы, которых нет) — убрать вместе с полем или элементом. */
export function remap(v: Json, idMap: ReadonlyMap<string, string>, drop: ReadonlySet<string> = new Set()): Json {
  if (typeof v === "string") return idMap.get(v) ?? v;
  if (Array.isArray(v)) return v.filter((x) => !(typeof x === "string" && drop.has(x))).map((x) => remap(x, idMap, drop));
  if (v && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) if (!(typeof x === "string" && drop.has(x))) out[k] = remap(x, idMap, drop);
    return out;
  }
  return v;
}

export interface PreparedDoc {
  /** Поля для вставки: без _id/_creationTime, ссылки переписаны. */
  fields: { [k: string]: Json };
  /** Поля со ссылками на ещё не вставленные документы — дописать вторым проходом. */
  deferred: { [k: string]: Json };
}

/**
 * Документ к вставке. allIds — все id копии: ссылка на документ копии, которого ещё нет в idMap, откладывается
 * (поле целиком). Ссылки на документы вне копии остаются как есть.
 */
export function prepareDoc(doc: BackupDoc, idMap: ReadonlyMap<string, string>, allIds: ReadonlyMap<string, string>, drop: ReadonlySet<string>): PreparedDoc {
  const fields: { [k: string]: Json } = {};
  const deferred: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "_id" || k === "_creationTime" || (typeof v === "string" && drop.has(v))) continue;
    const pending = [...strings(v)].some((s) => s !== doc._id && allIds.has(s) && !idMap.has(s));
    if (pending) deferred[k] = v;
    else fields[k] = remap(v, idMap, drop);
  }
  return { fields, deferred };
}

/** Подключения после восстановления: токенов в копии нет — подключить заново. */
export function restoredIntegration(doc: BackupDoc): { [k: string]: Json } {
  const { _id: _i, _creationTime: _c, cursor: _cur, syncLeaseUntil: _s, refreshLeaseUntil: _r, backoffUntil: _b, backoffStep: _bs, ...rest } = doc;
  void [_i, _c, _cur, _s, _r, _b, _bs];
  return { ...rest, status: "disconnected", lastError: "Восстановлено из резервной копии — подключите заново" };
}
