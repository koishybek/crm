// Журнал ключевых действий (ТЗ п.20 «Audit Log», п.26 «логирование критических действий», п.27).
// audit() вызывается в той же мутации, что и само действие: запись и изменение атомарны —
// нет действия без следа и следа без действия.
import type { Infer } from "convex/values";
import type { MutationCtx } from "./functions";
import type { Id } from "../_generated/dataModel";
import type { auditEntity } from "../schema";
import type { SystemActor } from "../../src/data/audit";
import { nowIso } from "./domain";
import { tenantOf } from "./tenantDb";

export type AuditEntity = Infer<typeof auditEntity>;
/** Действие — «сущность.что»: «order.status», «order.finance», «user.access», «integration.connected». */
export type AuditAction = `${AuditEntity}.${string}`;

/** Кто сделал: сотрудник или автоматический источник. */
export type AuditActor = { _id: Id<"users">; name?: string; role?: string } | SystemActor;

const MAX_META = 4_000;

/** Детали только сериализуемые и ограниченного размера: журнал не должен разрастаться из-за вложений. */
function cleanMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  try {
    const json = JSON.stringify(meta);
    if (json.length > MAX_META) return { truncated: true, preview: json.slice(0, MAX_META) };
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function audit(ctx: MutationCtx, actor: AuditActor, action: AuditAction, summary: string, opts: { entityId?: string; meta?: Record<string, unknown> } = {}): Promise<void> {
  const entity = action.slice(0, action.indexOf(".")) as AuditEntity;
  const human = typeof actor === "string" ? null : actor;
  await ctx.db.insert("audit", {
    tenantId: tenantOf(ctx),
    at: nowIso(),
    actorId: human?._id,
    actorName: human ? human.name || "Сотрудник" : (actor as string),
    actorRole: human?.role,
    action,
    entity,
    entityId: opts.entityId,
    summary: summary.slice(0, 500),
    meta: cleanMeta(opts.meta),
  });
}

// ── Текст записей ────────────────────────────────────────────────────────────
// Журнал читают позже, чем пишут: даты — абсолютные и по Алматы, значения — короткие цитаты.

const ALMATY_MS = 5 * 3600_000; // сервер в UTC, люди — в Алматы (UTC+5)
const pad = (n: number) => String(n).padStart(2, "0");

/** «15.10.2026 18:00» по времени Алматы. */
export function almatyStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + ALMATY_MS);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** Фраза в середине предложения: «Статус изменён на «В работе»» → «статус изменён на «В работе»» (названия в кавычках не трогаем). */
export const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/** Значение в кавычках-ёлочках, длинное — с многоточием; пустое — «—». */
export function quote(s: string | undefined | null, max = 60): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "—";
  return `«${t.length > max ? `${t.slice(0, max - 1)}…` : t}»`;
}

/** Что добавили и что убрали в списке (теги, направления) — точное сравнение. */
export function listDiff(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  return { added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) };
}

/** «+«VIP», −«Новый»» — изменения списка одной строкой; label — подпись элемента (ключ направления → название). */
export function listDiffText(diff: { added: readonly string[]; removed: readonly string[] }, label: (x: string) => string = (x) => x): string {
  return [...diff.added.map((x) => `+«${label(x)}»`), ...diff.removed.map((x) => `−«${label(x)}»`)].join(", ");
}

/** Телефон в деталях журнала — только последние 4 цифры: журнал не должен становиться копией базы клиентов. */
export const maskPhone = (p: string | undefined): string => (p ? `…${p.slice(-4)}` : "");

/** Сборщик правки: «что поменялось» человеку (parts) и те же изменения структурно — в meta (changes). */
export class ChangeLog {
  readonly parts: string[] = [];
  readonly changes: Record<string, unknown> = {};

  add(text: string, field: string, detail: unknown): void {
    this.parts.push(text);
    this.changes[field] = detail;
  }

  get empty(): boolean {
    return this.parts.length === 0;
  }

  text(separator = "; "): string {
    return this.parts.join(separator);
  }
}
