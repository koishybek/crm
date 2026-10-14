// Восстановление из резервной копии (ТЗ п.20.10, п.26.5): проход по деплойменту — обзор (только чтение) и запись.
// Зовёт внутренние функции convex/restore.ts через переданного «администратора»: scripts/restore.ts — ключом
// деплоя, тесты — через convex-test. План и переписывание id — lib/restorePlan.ts.
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { internal } from "../_generated/api";
import { MERGED_TABLES, NOT_RESTORED, idIndex, prepareDoc, remap, restoredIntegration, tableOrder, type BackupData, type BackupDoc, type Json } from "./restorePlan";

type Fn<T extends "query" | "mutation" | "action"> = FunctionReference<T, "internal">;

export interface AdminCaller {
  query<F extends Fn<"query">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  mutation<F extends Fn<"mutation">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
  action<F extends Fn<"action">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>>;
}

export type RestoreTable = FunctionArgs<typeof internal.restore.insert>["table"];

export interface RestoreSurvey {
  /** Таблицы в порядке вставки и сколько строк. */
  order: { table: RestoreTable; rows: number }[];
  merged: { table: string; rows: number }[];
  notRestored: { table: string; rows: number; why: string }[];
  /** Таблицы из копии, которых этот деплоймент не знает. */
  unknown: string[];
  files: { total: number; present: number };
  /** Файлы из описи, которых нет в хранилище деплоймента: ссылки на них убираются. */
  missing: Set<string>;
  /** Таблицы, где на деплойменте уже есть строки. */
  occupied: string[];
}

/** Что будет сделано — ничего не меняя. */
export async function surveyRestore(c: AdminCaller, data: BackupData): Promise<RestoreSurvey> {
  const count = (t: string) => data.tables[t]?.length ?? 0;
  const known = await c.query(internal.restore.tables, {});
  const isMerged = (t: string) => (MERGED_TABLES as readonly string[]).includes(t);
  const order = tableOrder(
    data,
    known.filter((t) => count(t) > 0),
  ).map((t) => ({ table: t as RestoreTable, rows: count(t) }));
  const fileIds = [...new Set(data.files.map((f) => f.storageId))];
  const present = new Set<string>();
  for (let i = 0; i < fileIds.length; i += 200) for (const id of await c.query(internal.restore.existingFiles, { ids: fileIds.slice(i, i + 200) })) present.add(id);
  return {
    order,
    merged: MERGED_TABLES.filter((t) => count(t)).map((t) => ({ table: t, rows: count(t) })),
    notRestored: Object.entries(NOT_RESTORED)
      .filter(([t]) => count(t))
      .map(([t, why]) => ({ table: t, rows: count(t), why })),
    unknown: Object.keys(data.tables).filter((t) => !known.includes(t) && !Object.hasOwn(NOT_RESTORED, t) && !isMerged(t)),
    files: { total: fileIds.length, present: present.size },
    missing: new Set(fileIds.filter((id) => !present.has(id))),
    occupied: await c.query(internal.restore.occupied, {}),
  };
}

const BATCH = 100;

export interface RestoreResult {
  docs: number;
  deferred: number;
  settings: number;
  integrations: number;
}

/**
 * Запись: документы по таблицам в порядке плана (новые id, ссылки переписаны), затем отложенные взаимные ссылки,
 * затем настройки и подключения, итог — в журнал. Проверку «база пуста» делает вызывающий.
 */
export async function writeRestore(c: AdminCaller, data: BackupData, s: RestoreSurvey, log: (line: string) => void = () => {}): Promise<RestoreResult> {
  const allIds = idIndex(data);
  const idMap = new Map<string, string>();
  const deferred: { table: RestoreTable; oldId: string; fields: { [k: string]: Json } }[] = [];
  let docs = 0;
  for (const { table } of s.order) {
    const rows = data.tables[table]!;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const prepared = batch.map((d) => prepareDoc(d, idMap, allIds, s.missing));
      const ids = await c.mutation(internal.restore.insert, { table, rows: prepared.map((p) => p.fields) });
      batch.forEach((d, j) => {
        idMap.set(d._id as string, ids[j]!);
        if (Object.keys(prepared[j]!.deferred).length) deferred.push({ table, oldId: d._id as string, fields: prepared[j]!.deferred });
      });
      docs += batch.length;
    }
    log(`  ${table}: ${rows.length} ✓`);
  }
  for (let i = 0; i < deferred.length; i += BATCH) {
    const byTable = new Map<RestoreTable, { id: string; fields: Json }[]>();
    for (const d of deferred.slice(i, i + BATCH)) byTable.set(d.table, [...(byTable.get(d.table) ?? []), { id: idMap.get(d.oldId)!, fields: remap(d.fields, idMap, s.missing) }]);
    for (const [table, patches] of byTable) await c.mutation(internal.restore.patch, { table, patches });
  }
  const settings = (data.tables.settings ?? []).filter((x): x is BackupDoc & { key: string; value: string } => typeof x.key === "string" && typeof x.value === "string").map((x) => ({ key: x.key, value: x.value }));
  const integrations = (data.tables.integrations ?? []).map((d) => remap(restoredIntegration(d), idMap, s.missing));
  const merged = await c.mutation(internal.restore.merge, { settings, integrations });
  await c.mutation(internal.restore.finish, { createdAt: data.createdAt, docs, missingFiles: s.missing.size });
  return { docs, deferred: deferred.length, ...merged };
}
