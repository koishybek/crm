// Восстановление из резервной копии (ТЗ п.20.10, п.26.5): внутренние функции для scripts/restore.ts. Клиенты их
// не видят — скрипт зовёт их ключом деплоя, как seed-convex.ts. Всё, что пишет, требует ALLOW_SEED=1 на деплойменте;
// чтение (проверка «есть ли данные», каких файлов нет) — нет: пробный запуск ничего не меняет.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { WithoutSystemFields } from "convex/server";
import type { Doc, TableNames } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "./lib/functions";
import { BACKUP_TABLES } from "./backup";
import { audit } from "./lib/audit";
import { normalizeLogin } from "./lib/login";
import { MERGED_TABLES, NOT_RESTORED } from "./lib/restorePlan";
import { assertSeedAllowed } from "./seed";
import { createLogin } from "./users";
import { passwordProblem } from "../src/data/passwordRules";

type Merged = (typeof MERGED_TABLES)[number];
/** Таблицы, которые вставляются строками (остальные сливаются или не восстанавливаются). */
export const RESTORE_TABLES = BACKUP_TABLES.filter((t): t is Exclude<(typeof BACKUP_TABLES)[number], Merged> => !Object.hasOwn(NOT_RESTORED, t) && !(MERGED_TABLES as readonly string[]).includes(t));
const restoreTable = v.union(...RESTORE_TABLES.map((t) => v.literal(t)));

/** Список для скрипта: какие таблицы копии вставляются строками. */
export const tables = internalQuery({
  args: {},
  handler: async (): Promise<string[]> => [...RESTORE_TABLES],
});

/** В каких таблицах копии на деплойменте уже есть строки. Настройки и подключения не в счёт — они сливаются. */
export const occupied = internalQuery({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const out: string[] = [];
    for (const t of RESTORE_TABLES) if (await ctx.db.query(t as TableNames).first()) out.push(t);
    return out;
  },
});

/** Какие файлы из описи есть в хранилище этого деплоймента. */
export const existingFiles = internalQuery({
  args: { ids: v.array(v.string()) },
  handler: async (ctx, { ids }): Promise<string[]> => {
    const out: string[] = [];
    for (const raw of ids) {
      const id = ctx.db.system.normalizeId("_storage", raw);
      if (id && (await ctx.db.system.get(id))) out.push(raw);
    }
    return out;
  },
});

/** Вставка пачки документов одной таблицы; схема проверяет каждый. Возвращает новые id в том же порядке. */
export const insert = internalMutation({
  args: { table: restoreTable, rows: v.array(v.any()) },
  handler: async (ctx, { table, rows }): Promise<string[]> => {
    assertSeedAllowed();
    const ids: string[] = [];
    for (const r of rows) ids.push(await ctx.db.insert(table, r));
    return ids;
  },
});

/** Второй проход: дописать отложенные ссылки. */
export const patch = internalMutation({
  args: { table: restoreTable, patches: v.array(v.object({ id: v.string(), fields: v.any() })) },
  handler: async (ctx, { table, patches }): Promise<void> => {
    assertSeedAllowed();
    for (const p of patches) {
      const id = ctx.db.normalizeId(table, p.id);
      if (id) await ctx.db.patch(id, p.fields);
    }
  },
});

/** Настройки — по ключу (значение из копии важнее), подключения — только если такого провайдера ещё нет. */
export const merge = internalMutation({
  args: {
    settings: v.array(v.object({ key: v.string(), value: v.string() })),
    integrations: v.array(v.any()),
  },
  handler: async (ctx, a): Promise<{ settings: number; integrations: number }> => {
    assertSeedAllowed();
    for (const s of a.settings) {
      const row = await ctx.db
        .query("settings")
        .withIndex("by_key", (q) => q.eq("key", s.key))
        .unique();
      if (row) await ctx.db.patch(row._id, { value: s.value });
      else await ctx.db.insert("settings", s);
    }
    let integrations = 0;
    for (const i of a.integrations as WithoutSystemFields<Doc<"integrations">>[]) {
      const has = await ctx.db
        .query("integrations")
        .withIndex("by_provider", (q) => q.eq("provider", i.provider))
        .first();
      if (has) continue;
      await ctx.db.insert("integrations", i);
      integrations++;
    }
    return { settings: a.settings.length, integrations };
  },
});

/** Итог в журнал действий. */
export const finish = internalMutation({
  args: { createdAt: v.string(), docs: v.number(), missingFiles: v.number() },
  handler: async (ctx, a): Promise<void> => {
    assertSeedAllowed();
    await audit(ctx, "Система", "system.restored", `Данные восстановлены из резервной копии от ${a.createdAt.slice(0, 16).replace("T", " ")} UTC: ${a.docs} записей${a.missingFiles ? `, файлов не найдено: ${a.missingFiles}` : ""}`, {
      meta: { docs: a.docs, missingFiles: a.missingFiles },
    });
  },
});

export const _ownerByLogin = internalQuery({
  args: { login: v.string() },
  handler: async (ctx, { login }) => {
    const u = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", login))
      .first();
    return u && u.role === "owner" && u.active !== false ? u._id : null;
  },
});

export const _mustChange = internalMutation({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }): Promise<void> => {
    await ctx.db.patch(userId, { mustChangePassword: true });
  },
});

/**
 * Входов в копии нет (пароли не копируются): владельцу из копии — временный пароль, при входе он задаст свой.
 * Остальным пароли выдаёт владелец в «Настройках».
 */
export const ownerLogin = internalAction({
  args: { login: v.string(), password: v.string() },
  handler: async (ctx, a): Promise<void> => {
    assertSeedAllowed();
    const problem = passwordProblem(a.password, "owner");
    if (problem) throw new ConvexError(problem);
    const login = normalizeLogin(a.login);
    const userId = login ? await ctx.runQuery(internal.restore._ownerByLogin, { login }) : null;
    if (!userId) throw new ConvexError("Владельца с таким логином в восстановленных данных нет");
    await createLogin(ctx, login!, a.password);
    await ctx.runMutation(internal.restore._mustChange, { userId });
  },
});
