// Отметки эскалаций (ТЗ п.15): какой уровень уже сработал в текущем эпизоде — ни один уровень не повторяется.
// Эпизод — с какого момента длится ситуация: заказ попал в ленту, мастера назначили, срок заказа, заявка создана,
// звонок пропущен. Новый эпизод (заказ снова в ленте, назначили другого, сдвинули срок) — уровни считаются заново.
// Общие для крона эскалаций (escalations.ts) и автораспределения (autoAssign.ts): «предлагать больше некому» — тоже
// эскалация, и вместе они не шлют одним и тем же людям одно и то же дважды.
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./functions";
import { nowIso } from "./domain";

export type EscalationKind = Doc<"escalations">["kind"];

const markOf = (ctx: QueryCtx, kind: EscalationKind, entityId: string) =>
  ctx.db
    .query("escalations")
    .withIndex("by_kind_entity", (q) => q.eq("kind", kind).eq("entityId", entityId))
    .unique();

/** Какой уровень уже сработал в эпизоде since (ISO); другой эпизод — 0. */
export async function reachedLevel(ctx: QueryCtx, kind: EscalationKind, entityId: string, since: string): Promise<number> {
  const m = await markOf(ctx, kind, entityId);
  return m && m.since === since ? m.level : 0;
}

/** Запомнить, что уровень level эпизода since сработал. */
export async function markLevel(ctx: MutationCtx, kind: EscalationKind, entityId: string, since: string, level: number): Promise<void> {
  const m = await markOf(ctx, kind, entityId);
  if (m) await ctx.db.patch(m._id, { since, level, at: nowIso() });
  else await ctx.db.insert("escalations", { kind, entityId, since, level, at: nowIso() });
}

/** Действующие сотрудники роли (отключённым уведомления не идут). */
export async function activeIds(ctx: QueryCtx, role: "owner" | "operator" | "manager", category?: string): Promise<Id<"users">[]> {
  const users = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", role))
    .collect();
  return users.filter((u) => u.active !== false && (category === undefined || u.categories?.includes(category))).map((u) => u._id);
}

/**
 * Кому эскалация по заказу на уровнях from…to: 1 — руководители направления заказа (если таких нет — владельцы:
 * кто-то должен узнать), 2 — владельцы.
 */
export async function orderLevelRecipients(ctx: QueryCtx, category: string, from: number, to: number): Promise<{ ids: Id<"users">[]; who: string }> {
  const ids = new Set<Id<"users">>();
  const who: string[] = [];
  if (from <= 1 && to >= 1) {
    const managers = await activeIds(ctx, "manager", category);
    for (const id of managers.length ? managers : await activeIds(ctx, "owner")) ids.add(id);
    who.push(managers.length ? "руководителю направления" : "владельцу");
  }
  if (from <= 2 && to >= 2) {
    for (const id of await activeIds(ctx, "owner")) ids.add(id);
    if (!who.includes("владельцу")) who.push("владельцу");
  }
  return { ids: [...ids], who: who.join(" и ") };
}

/** Операторы на связи; если их нет — владельцы: заявку и пропущенный звонок кто-то должен увидеть. */
export async function operatorsOrOwners(ctx: QueryCtx): Promise<{ ids: Id<"users">[]; who: string }> {
  const ops = await activeIds(ctx, "operator");
  return ops.length ? { ids: ops, who: "операторам" } : { ids: await activeIds(ctx, "owner"), who: "владельцу" };
}
