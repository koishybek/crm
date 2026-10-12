// Мониторинг подсистем: отметки из actions и сводка для владельца.
import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { markError, markOk, type HealthKey } from "./lib/health";

const healthKey = v.union(
  v.literal("ai"),
  v.literal("telegram"),
  v.literal("whatsapp"),
  v.literal("olx"),
  v.literal("pbx"),
  v.literal("email"),
  v.literal("site"),
  v.literal("api"),
  v.literal("backup"),
  v.literal("reminders"),
);

/** Для actions (у них нет ctx.db): отметить успех или ошибку подсистемы. */
export const _mark = internalMutation({
  args: { key: healthKey, ok: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, { key, ok, note }): Promise<void> => {
    if (ok) await markOk(ctx, key as HealthKey, note);
    else await markError(ctx, key as HealthKey, note ?? "Ошибка");
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireRole(ctx, OWNER);
    const rows = await ctx.db.query("systemStatus").collect();
    return rows.map((r) => ({ key: r.key, okAt: r.okAt, okNote: r.okNote, errorAt: r.errorAt, error: r.error }));
  },
});
