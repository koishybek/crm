// Загрузка демо-данных скриптом scripts/seed-convex.ts. Работает только если на деплойменте
// заданы SEED_SECRET и ALLOW_SEED=1 — на боевой базе заказчика ALLOW_SEED не ставим.
import { ConvexError, v } from "convex/values";
import type { TableNames } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { action, mutation, query } from "./_generated/server";
import { normalizeLogin } from "./lib/login";
import { env } from "./env";
import { createLogin } from "./users";

function guard(secret: string) {
  if (env("ALLOW_SEED") !== "1" || !env("SEED_SECRET") || secret !== env("SEED_SECRET")) throw new ConvexError("Загрузка демо-данных выключена");
}

const SEED_TABLES = ["executors", "users", "clients", "leads", "orders", "messages", "history", "interactions", "clientNotes", "notifications", "counters", "calls", "conversations", "conversationMessages", "audit", "reviews", "adSpend"] as const;
// settings (секрет АТС) не трогаем: это настройка, а не демо-данные.
// settings и integrations не трогаем: это настройки и подключения, а не демо-данные.
const WIPE_TABLES = [...SEED_TABLES, "botChats", "clientNotices", "apiKeys", "apiLeads", "reviewRequests", "rateLimits", "systemStatus", "backups", "oauthStates", "uploads", "categories", "services", "authAccounts", "authSessions", "authRefreshTokens", "authVerificationCodes", "authVerifiers", "authRateLimits"] as const;
const tableArg = v.union(...SEED_TABLES.map((t) => v.literal(t)));

/** Вставка пачки документов. Схема всё равно проверяет каждый документ. */
export const ingest = mutation({
  args: { secret: v.string(), table: tableArg, rows: v.array(v.any()) },
  handler: async (ctx, { secret, table, rows }) => {
    guard(secret);
    const ids: string[] = [];
    for (const r of rows) ids.push(await ctx.db.insert(table, r));
    return ids;
  },
});

export const patchMany = mutation({
  args: { secret: v.string(), table: tableArg, patches: v.array(v.object({ id: v.string(), fields: v.any() })) },
  handler: async (ctx, { secret, table, patches }) => {
    guard(secret);
    for (const p of patches) {
      const id = ctx.db.normalizeId(table, p.id);
      if (id) await ctx.db.patch(id, p.fields);
    }
  },
});

/** Удаляет до 400 документов таблицы за вызов; скрипт зовёт, пока не вернётся 0. */
export const wipe = mutation({
  args: { secret: v.string(), table: v.union(...WIPE_TABLES.map((t) => v.literal(t))) },
  handler: async (ctx, { secret, table }) => {
    guard(secret);
    const rows = await ctx.db.query(table as TableNames).take(400);
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});

/** Файлы хранилища (записи звонков, вложения) — по 200 за вызов. */
export const wipeFiles = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    guard(secret);
    const files = await ctx.db.system.query("_storage").take(200);
    for (const f of files) await ctx.storage.delete(f._id);
    return files.length;
  },
});

/** Кто привязал Telegram — чтобы перезаливка демо-данных не отвязывала людей от бота. */
export const telegramLinks = query({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    guard(secret);
    const users = await ctx.db.query("users").collect();
    return users.filter((u) => u.telegramChatId && u.email).map((u) => ({ login: u.email!, name: u.name ?? "", chatId: u.telegramChatId! }));
  },
});

export const uploadUrl = mutation({
  args: { secret: v.string() },
  handler: async (ctx, { secret }) => {
    guard(secret);
    return ctx.storage.generateUploadUrl();
  },
});

/** Демо-звонки с записью проходят настоящий AI: расшифровка → разбор → заявка. */
export const processCalls = mutation({
  args: { secret: v.string(), ids: v.array(v.id("calls")) },
  handler: async (ctx, { secret, ids }) => {
    guard(secret);
    for (const callId of ids) await ctx.scheduler.runAfter(0, internal.ai.processCall, { callId });
  },
});

export const logins = action({
  args: { secret: v.string(), logins: v.array(v.object({ login: v.string(), password: v.string() })) },
  handler: async (ctx, { secret, logins }) => {
    guard(secret);
    for (const l of logins) await createLogin(ctx, l.login, l.password);
    return logins.length;
  },
});

/** Боевой запуск: в чистой базе создать первого владельца (дальше он заводит команду сам). */
export const bootstrapOwner = action({
  args: { secret: v.string(), name: v.string(), login: v.string(), password: v.string() },
  handler: async (ctx, a) => {
    if (!env("SEED_SECRET") || a.secret !== env("SEED_SECRET")) throw new ConvexError("Нет доступа");
    if (a.password.length < 8) throw new ConvexError("Пароль — минимум 8 символов");
    const login = normalizeLogin(a.login);
    await ctx.runMutation(internal.users._insertUser, { name: a.name.trim(), login, role: "owner", phone: login.includes("@") ? undefined : login });
    await createLogin(ctx, login, a.password);
    return login;
  },
});
