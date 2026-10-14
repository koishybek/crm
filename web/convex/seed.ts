// Загрузка демо-данных скриптом scripts/seed-convex.ts и первый владелец боевой базы (аудит H-1, E17).
// Все функции внутренние: клиенты их не видят, вызвать их можно только с правами администратора деплоймента —
// `npx convex run …` (вход в Convex CLI) или скрипт с ключом деплоя CONVEX_DEPLOY_KEY. Общего секрета больше нет.
// Демо-данные дополнительно требуют ALLOW_SEED=1 на деплойменте — на боевой базе заказчика его не ставим.
import { ConvexError, v } from "convex/values";
import type { TableNames } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, type MutationCtx } from "./_generated/server";
import { normalizeLogin } from "./lib/login";
import { env } from "./env";
import { createLogin } from "./users";
import { passwordProblem } from "../src/data/passwordRules";

export function assertSeedAllowed(): void {
  if (env("ALLOW_SEED") !== "1") throw new ConvexError("Загрузка демо-данных выключена: на деплойменте не задан ALLOW_SEED=1");
}

const SEED_TABLES = ["executors", "users", "clients", "leads", "orders", "messages", "history", "interactions", "clientNotes", "notifications", "counters", "calls", "conversations", "conversationMessages", "audit", "reviews", "adSpend", "payouts", "campaignSpend"] as const;
// settings и integrations не трогаем: это настройки и подключения (ключ АТС, OLX), а не демо-данные.
const WIPE_TABLES = [
  ...SEED_TABLES,
  "botChats",
  "clientNotices",
  "apiKeys",
  "apiLeads",
  "reviewRequests",
  "rateLimits",
  "telegramUpdates",
  "systemStatus",
  "backups",
  "oauthStates",
  "uploads",
  "escalations",
  "exports",
  "webhooks",
  "webhookDeliveries",
  "statsFacts",
  "dailyStats",
  "statsDirty",
  "statsState",
  "pushSubscriptions",
  "clientErrors",
  "offsiteFiles",
  "categories",
  "services",
  "authAccounts",
  "authSessions",
  "authRefreshTokens",
  "authVerificationCodes",
  "authVerifiers",
  "authRateLimits",
] as const;
const tableArg = v.union(...SEED_TABLES.map((t) => v.literal(t)));

/**
 * Демо-данные идут мимо мутаций (и мимо очереди показателей): аналитику соберёт заново крон convex/stats.ts —
 * как при первом запуске. Идущий пересчёт без строки состояния останавливается и начинается снова.
 */
async function resetStats(ctx: MutationCtx, table: string): Promise<void> {
  if (table !== "leads" && table !== "orders") return;
  const stats = await ctx.db.query("statsState").first();
  if (stats) await ctx.db.delete(stats._id);
}

/** Вставка пачки документов. Схема всё равно проверяет каждый документ. */
export const ingest = internalMutation({
  args: { table: tableArg, rows: v.array(v.any()) },
  handler: async (ctx, { table, rows }) => {
    assertSeedAllowed();
    const ids: string[] = [];
    for (const r of rows) ids.push(await ctx.db.insert(table, r));
    await resetStats(ctx, table);
    return ids;
  },
});

export const patchMany = internalMutation({
  args: { table: tableArg, patches: v.array(v.object({ id: v.string(), fields: v.any() })) },
  handler: async (ctx, { table, patches }) => {
    assertSeedAllowed();
    for (const p of patches) {
      const id = ctx.db.normalizeId(table, p.id);
      if (id) await ctx.db.patch(id, p.fields);
    }
    await resetStats(ctx, table);
  },
});

/** Удаляет до 400 документов таблицы за вызов; скрипт зовёт, пока не вернётся 0. */
export const wipe = internalMutation({
  args: { table: v.union(...WIPE_TABLES.map((t) => v.literal(t))) },
  handler: async (ctx, { table }) => {
    assertSeedAllowed();
    const rows = await ctx.db.query(table as TableNames).take(400);
    for (const r of rows) await ctx.db.delete(r._id);
    return rows.length;
  },
});

/** Файлы хранилища (записи звонков, вложения) — по 200 за вызов. */
export const wipeFiles = internalMutation({
  args: {},
  handler: async (ctx) => {
    assertSeedAllowed();
    const files = await ctx.db.system.query("_storage").take(200);
    for (const f of files) await ctx.storage.delete(f._id);
    return files.length;
  },
});

/** Кто привязал Telegram — чтобы перезаливка демо-данных не отвязывала людей от бота. */
export const telegramLinks = internalQuery({
  args: {},
  handler: async (ctx) => {
    assertSeedAllowed();
    const users = await ctx.db.query("users").collect();
    return users.filter((u) => u.telegramChatId && u.email).map((u) => ({ login: u.email!, name: u.name ?? "", chatId: u.telegramChatId! }));
  },
});

export const uploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => {
    assertSeedAllowed();
    return ctx.storage.generateUploadUrl();
  },
});

/** Демо-звонки с записью проходят настоящий AI: расшифровка → разбор → заявка. */
export const processCalls = internalMutation({
  args: { ids: v.array(v.id("calls")) },
  handler: async (ctx, { ids }) => {
    assertSeedAllowed();
    for (const callId of ids) await ctx.scheduler.runAfter(0, internal.ai.processCall, { callId });
  },
});

/** Пароли демо-аккаунтов. Флага «смените пароль» у них нет: демо-доступ показывают заказчику как есть. */
export const logins = internalAction({
  args: { logins: v.array(v.object({ login: v.string(), password: v.string() })) },
  handler: async (ctx, { logins }) => {
    assertSeedAllowed();
    for (const l of logins) await createLogin(ctx, l.login, l.password);
    return logins.length;
  },
});

/**
 * Боевой запуск: в базе без владельцев создать первого (дальше он заводит команду сам в «Настройках»).
 * Только из CLI: npx convex run --prod seed:bootstrapOwner '{"name":"…","login":"…","password":"…"}'.
 * Владелец уже есть — отказ (проверка и вставка — в одной транзакции _insertUser).
 */
export const bootstrapOwner = internalAction({
  args: { name: v.string(), login: v.string(), password: v.string() },
  handler: async (ctx, a): Promise<string> => {
    const problem = passwordProblem(a.password, "owner");
    if (problem) throw new ConvexError(problem);
    const login = normalizeLogin(a.login);
    if (!a.name.trim() || !login) throw new ConvexError("Укажите имя и логин");
    await ctx.runMutation(internal.users._insertUser, { name: a.name.trim(), login, role: "owner", phone: login.includes("@") ? undefined : login, firstOwner: true });
    await createLogin(ctx, login, a.password);
    return login;
  },
});
