// AI-подбор исполнителя (ТЗ п.12.7, п.23.1) — «Рекомендация AI» в окне назначения. Правила (fitsOrder, rankExecutors)
// отбирают до 5 подходящих мастеров; LLM — та же модель, что разбирает обращения (convex/ai.ts, только роль user), —
// предлагает порядок и коротко объясняет. Назначает человек. В LLM уходят только услуга, город и район, срок, навыки
// и обезличенные показатели кандидатов («К1…К5»): ни данных клиента, ни имён мастеров. Передавать данные в LLM —
// решение владельца: настройка «AI-подбор исполнителя», по умолчанию выключена. Выключено, AI не подключён или не
// ответил — рекомендация по правилам с объяснением.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation, query, type QueryCtx } from "./_generated/server";
import { assertScope, OWNER, requireRole, TEAM } from "./lib/access";
import { audit } from "./lib/audit";
import { activeExecutorIds } from "./lib/matching";
import { hitLimit } from "./lib/rateLimit";
import { toExecutor } from "./lib/dto";
import { canChat, chatJson } from "./ai";
import { loadCatalog } from "./catalog";
import {
  AI_MATCH_TOP,
  buildMatchPrompt,
  candidateFacts,
  parseMatchAnswer,
  rulesWhy,
  RULES_SUMMARY,
  type AiMatchItem,
  type AiMatchResult,
  type MatchCandidateFacts,
  type MatchOrderFacts,
} from "../src/data/aiMatch";
import { WORK_STATUSES } from "../src/data/catalog";
import { payoutFor, rankExecutors, type Load } from "../src/data/logic";

const KEY = "aiMatch.enabled";
/** Запросов к AI на одного сотрудника в час — защита от случайных повторов и расходов. */
const PER_HOUR = 30;

export interface AiMatchSettings {
  /** Владелец разрешил передавать обезличенные данные заказа и мастеров в LLM. */
  enabled: boolean;
  /** Основной LLM подключён (LLM_API_KEY). */
  connected: boolean;
}

async function readEnabled(ctx: QueryCtx): Promise<boolean> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", KEY))
    .unique();
  return row?.value === "true";
}

/** Включён ли AI-подбор — видят сотрудники (кнопка «Спросить AI»), меняет владелец. */
export const settings = query({
  args: {},
  handler: async (ctx): Promise<AiMatchSettings> => {
    await requireRole(ctx, TEAM);
    return { enabled: await readEnabled(ctx), connected: canChat() };
  },
});

export const configure = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, { enabled }): Promise<AiMatchSettings> => {
    const me = await requireRole(ctx, OWNER);
    const before = await readEnabled(ctx);
    if (before !== enabled) {
      const row = await ctx.db
        .query("settings")
        .withIndex("by_key", (q) => q.eq("key", KEY))
        .unique();
      if (row) await ctx.db.patch(row._id, { value: String(enabled) });
      else await ctx.db.insert("settings", { key: KEY, value: String(enabled) });
      await audit(
        ctx,
        me,
        "settings.aiMatch",
        enabled ? "AI-подбор исполнителя включён: обезличенные данные заказа и мастеров передаются в LLM" : "AI-подбор исполнителя выключен",
        { meta: { before, after: enabled } },
      );
    }
    return { enabled, connected: canChat() };
  },
});

interface MatchContext {
  enabled: boolean;
  /** Сотрудник исчерпал лимит запросов к AI за час. */
  limited: boolean;
  order: MatchOrderFacts;
  /** Кандидаты по правилам, лучшие сверху; facts — то, что уходит в LLM. */
  candidates: (AiMatchItem & { facts: MatchCandidateFacts })[];
}

/**
 * Подготовка (мутация — ради лимита и журнала): права и направление сотрудника, кандидаты по правилам, обезличенные
 * данные для LLM. Запрос к AI учитывается в лимите и пишется в журнал, только если AI действительно будет спрошен.
 */
export const _prepare = internalMutation({
  args: { orderId: v.id("orders"), ai: v.boolean() },
  handler: async (ctx, { orderId, ai }): Promise<MatchContext> => {
    const me = await requireRole(ctx, TEAM);
    const o = await ctx.db.get(orderId);
    if (!o) throw new ConvexError("Заказ не найден");
    assertScope(me, o.category);
    const catalog = await loadCatalog(ctx);
    const reachable = await activeExecutorIds(ctx);
    const executors = (await ctx.db.query("executors").collect()).filter((e) => reachable.has(e._id) && e._id !== o.executorId).map(toExecutor);
    const load: Load[] = [];
    for (const status of WORK_STATUSES) {
      for (const x of await ctx.db
        .query("orders")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect()) {
        if (x.executorId) load.push({ executorId: x.executorId, status: x.status });
      }
    }
    const ranked = rankExecutors(o, executors, load)
      // Чья ставка больше цены клиента, того не советуем: назначить его можно, только поправив выплату вручную.
      .filter((c) => c.fits && (o.clientPrice <= 0 || payoutFor(c.e.rates, o) <= o.clientPrice))
      .slice(0, AI_MATCH_TOP);
    const enabled = await readEnabled(ctx);
    let limited = false;
    if (ai && enabled && canChat() && ranked.length > 1) {
      limited = !(await hitLimit(ctx, `aimatch:${me._id}`, PER_HOUR, 3_600_000));
      if (!limited) {
        await audit(ctx, me, "order.aiMatch", `Заказ №${o.number}: запрошена рекомендация AI по исполнителю (кандидатов: ${ranked.length})`, {
          entityId: o._id,
          meta: { candidates: ranked.length },
        });
      }
    }
    const category = catalog.categories.find((c) => c.id === o.category)?.label ?? o.category;
    return {
      enabled,
      limited,
      order: {
        service: catalog.label(o.serviceId),
        category,
        city: o.city,
        district: o.district,
        hoursLeft: Math.round((Date.parse(o.deadline) - Date.now()) / 3_600_000),
        priority: o.priority,
        requiredSkills: o.requiredSkills ?? [],
      },
      candidates: ranked.map((c, i) => ({ executorId: c.e.id, name: c.e.name, why: rulesWhy(c), payout: payoutFor(c.e.rates, o), facts: candidateFacts(c, i) })),
    };
  },
});

const strip = (c: MatchContext["candidates"][number]): AiMatchItem => ({ executorId: c.executorId, name: c.name, why: c.why, payout: c.payout });

/** Рекомендация по правилам: порядок rankExecutors и объяснение по показателям. */
function byRules(ctx: MatchContext, note?: string): AiMatchResult {
  return {
    source: "rules",
    items: ctx.candidates.map(strip),
    summary: ctx.candidates.length ? RULES_SUMMARY : "Подходящих исполнителей сейчас нет — назначьте вручную из списка всех исполнителей.",
    ...(note ? { note } : {}),
  };
}

/** «Спросить AI»: порядок кандидатов от AI с объяснением, при любом сбое — по правилам. Назначает человек. */
export const recommend = action({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<AiMatchResult> => {
    const prepared: MatchContext = await ctx.runMutation(internal.aiMatch._prepare, { orderId, ai: true });
    if (prepared.candidates.length < 2) return byRules(prepared, prepared.candidates.length ? "Подходит один исполнитель — выбирать не из кого." : undefined);
    if (!prepared.enabled) return byRules(prepared, "AI-подбор выключен владельцем — рекомендация по правилам.");
    if (!canChat()) return byRules(prepared, "AI не подключён — рекомендация по правилам.");
    if (prepared.limited) return byRules(prepared, "Слишком много запросов к AI за час — рекомендация по правилам.");
    const labels = prepared.candidates.map((c) => c.facts.label);
    try {
      const raw = await chatJson(buildMatchPrompt(prepared.order, prepared.candidates.map((c) => c.facts)));
      const answer = parseMatchAnswer(raw, labels);
      if (!answer) throw new ConvexError("AI вернул неразборчивый ответ");
      await ctx.runMutation(internal.health._mark, { key: "ai", ok: true, note: "AI-подбор исполнителя" });
      const byLabel = new Map(prepared.candidates.map((c) => [c.facts.label, c]));
      return {
        source: "ai",
        items: answer.order.map((label) => {
          const c = byLabel.get(label)!;
          return { ...strip(c), why: answer.reasons[label] ?? c.why };
        }),
        summary: answer.summary || "Порядок предложил AI по показателям кандидатов.",
      };
    } catch (e) {
      // Текст ответа провайдера в лог не пишем — только факт сбоя.
      console.warn("AI-подбор: LLM не ответил, рекомендация по правилам");
      await ctx.runMutation(internal.health._mark, { key: "ai", ok: false, note: `AI-подбор: ${e instanceof ConvexError ? String(e.data) : "ошибка AI"}` });
      return byRules(prepared, "AI не ответил — рекомендация по правилам.");
    }
  },
});
