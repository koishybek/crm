// Журнал ключевых действий (ТЗ п.20 «Audit Log», п.26 «логирование критических действий», п.27).
// audit() вызывается в той же мутации, что и само действие: запись и изменение атомарны —
// нет действия без следа и следа без действия.
import type { Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { auditEntity } from "../schema";
import { TENANT, nowIso } from "./domain";

export type AuditEntity = Infer<typeof auditEntity>;
/** Действие — «сущность.что»: «order.status», «order.finance», «user.access», «integration.connected». */
export type AuditAction = `${AuditEntity}.${string}`;

/** Кто сделал: сотрудник или автоматический источник. */
export type AuditActor = { _id: Id<"users">; name?: string; role?: string } | "Система" | "AI" | "Telegram" | "WhatsApp" | "OLX" | "Сайт" | "API" | "АТС";

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
    tenantId: TENANT,
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
