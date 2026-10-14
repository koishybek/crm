// Мониторинг подсистем: отметки из actions и сводка для владельца.
import { v } from "convex/values";
import { internalMutation, query } from "./lib/functions";
import { OWNER, requireRole } from "./lib/access";
import { markError, markOk, type HealthKey } from "./lib/health";
import { s3Missing } from "./lib/s3";
import { integrationsKeyIssue } from "./lib/secretBox";
import { canExtract, canTranscribe } from "./ai";
import { configured as whatsappConfigured, missingEnv as whatsappMissing } from "./channels/whatsapp";
import { env } from "./env";
import type { HealthMark, SubsystemInfo, SystemOverview } from "../src/data/systemHealth";

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
  v.literal("escalations"),
  v.literal("offsite"),
  v.literal("payments"),
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

const TELEGRAM_ENV = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET"];

/**
 * «Состояние системы» (ТЗ п.20): по каждой подсистеме — подключена ли (переменные окружения, ключи, интеграции)
 * и её отметки. Цвет считает экран (src/data/systemHealth.ts): «давно не работало» зависит от текущего времени.
 * Значения секретов не отдаём — только имена недостающих переменных.
 */
export const overview = query({
  args: {},
  handler: async (ctx): Promise<SystemOverview> => {
    await requireRole(ctx, OWNER);
    const marks = new Map<string, HealthMark>((await ctx.db.query("systemStatus").collect()).map((r) => [r.key, { okAt: r.okAt, okNote: r.okNote, errorAt: r.errorAt, error: r.error }]));
    const integration = (provider: "olx" | "email") =>
      ctx.db
        .query("integrations")
        .withIndex("by_provider", (q) => q.eq("provider", provider))
        .first();
    const [olx, email, pbxSecret, keys, payProvider] = await Promise.all([
      integration("olx"),
      integration("email"),
      ctx.db
        .query("settings")
        .withIndex("by_key", (q) => q.eq("key", "pbxSecret"))
        .unique(),
      ctx.db.query("apiKeys").collect(),
      ctx.db
        .query("settings")
        .withIndex("by_key", (q) => q.eq("key", "pay.provider"))
        .unique(),
    ]);
    const sub = (key: SubsystemInfo["key"], configured: boolean, extra: Pick<SubsystemInfo, "hint" | "issue" | "warning"> = {}): SubsystemInfo => ({ key, configured, ...extra, mark: marks.get(key) });
    /**
     * OLX и email: подключение — строкой в integrations (отключили — серый); ошибка подключения — красный и без отметок.
     * problem — то, что ломает канал независимо от подключения (нет ключа шифрования токенов): у подключённого — красный.
     */
    const linked = (key: "olx" | "email", row: typeof olx, hint: string, problem?: string | null) =>
      sub(key, row ? row.status !== "disconnected" : marks.has(key), {
        hint: problem ?? hint,
        issue: problem ?? (row?.status === "error" ? (row.lastError ?? "Ошибка подключения") : undefined),
      });
    const tgMissing = TELEGRAM_ENV.filter((k) => !env(k));
    const waMissing = whatsappMissing();
    const activeKeys = keys.filter((k) => !k.revokedAt).length;
    return {
      subsystems: [
        sub("reminders", true),
        sub("escalations", true),
        sub("backup", true),
        sub("offsite", s3Missing().length === 0, { hint: `Внешнее хранилище не подключено — не заданы: ${s3Missing().join(", ")}` }),
        sub("ai", canExtract(), {
          hint: "Не заданы ключи AI: LLM_API_KEY или AI_URL + AI_SECRET",
          warning: canTranscribe() ? undefined : "Разбор текста работает, расшифровка звонков не настроена (STT_API_KEY или AI_URL + AI_SECRET)",
        }),
        sub("pbx", !!pbxSecret, { hint: "Ключ подключения АТС не создан — раздел «Телефония (АТС)»" }),
        sub("telegram", tgMissing.length === 0, { hint: `Не заданы: ${tgMissing.join(", ")}` }),
        sub("whatsapp", whatsappConfigured(), { hint: `Не заданы: ${waMissing.join(", ")}` }),
        linked("olx", olx, "Аккаунт OLX не подключён", integrationsKeyIssue()),
        linked("email", email, "Почта не подключена"),
        sub("site", marks.has("site"), { hint: "Заявок с сайта ещё не было" }),
        sub("api", activeKeys > 0 || marks.has("api"), { hint: "Ключей API нет" }),
        sub("payments", !!payProvider || marks.has("payments"), { hint: "Онлайн-оплата не подключена — «Настройки → Онлайн-оплата»" }),
      ],
    };
  },
});
