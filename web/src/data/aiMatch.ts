// AI-подбор исполнителя (ТЗ п.12.7, п.23.1): AI только советует порядок среди кандидатов, отобранных правилами
// (fitsOrder + rankExecutors), — назначает человек. Здесь общее для сервера (convex/aiMatch.ts) и интерфейса:
// что уходит в LLM (без данных клиента и без имён мастеров), как читаем ответ и рекомендация по правилам, когда AI
// выключен или не ответил.
import { autoAssignWhy } from "./autoAssign";
import { HISTORY, onTimePct, type Candidate } from "./logic";
import type { ExecutorStats90, Urgency } from "./types";

/** Кандидатов, которых показываем AI и человеку. */
export const AI_MATCH_TOP = 5;
/** Объяснение по кандидату и общий вывод — не длиннее. */
const WHY_MAX = 240;
const SUMMARY_MAX = 400;

export interface AiMatchItem {
  executorId: string;
  name: string;
  /** Почему он на этом месте — по-русски, коротко. */
  why: string;
  /** Сколько получит по своей ставке. */
  payout: number;
}

export interface AiMatchResult {
  /** ai — порядок предложил AI; rules — рекомендация по правилам (AI выключен, не подключён или не ответил). */
  source: "ai" | "rules";
  items: AiMatchItem[];
  summary: string;
  /** Почему рекомендация по правилам, а не от AI. */
  note?: string;
}

/** Заказ для подсказки — только то, что нужно для подбора: услуга, место, срок, навыки. Ни клиента, ни адреса, ни цен. */
export interface MatchOrderFacts {
  service: string;
  category: string;
  city: string;
  district?: string;
  /** Срок — часов от «сейчас» (отрицательное — уже просрочен). */
  hoursLeft: number;
  priority: Urgency;
  requiredSkills: readonly string[];
}

/** Обезличенный кандидат: метка «К1…К5» вместо имени, только показатели. */
export interface MatchCandidateFacts {
  label: string;
  state: Candidate["state"];
  load: number;
  rating: number;
  reviews: number;
  matchedSkills: number;
  stats?: Pick<ExecutorStats90, "done" | "onTime" | "cancelled" | "refusals" | "avgHours">;
  /** Мастер работает только в своих районах (а не во всём городе). */
  districtOnly: boolean;
}

const URGENCY_TEXT: Record<Urgency, string> = { normal: "обычная", high: "высокая", urgent: "срочно" };
const STATE_TEXT: Record<Candidate["state"], string> = { free: "свободен", busy: "на заказе", onsite: "на выезде", off: "выходной" };

/** Метка кандидата для AI: «К1», «К2», … — по месту в правилах. */
export const candidateLabel = (i: number): string => `К${i + 1}`;

/** Кандидат → обезличенные показатели. */
export function candidateFacts(c: Candidate, i: number): MatchCandidateFacts {
  const s = c.e.stats90;
  return {
    label: candidateLabel(i),
    state: c.state,
    load: c.load,
    rating: Math.round(c.e.rating * 10) / 10,
    reviews: c.e.reviews,
    matchedSkills: c.matched,
    stats: s ? { done: s.done, onTime: s.onTime, cancelled: s.cancelled, refusals: s.refusals, avgHours: s.avgHours } : undefined,
    districtOnly: !!c.e.districts?.length,
  };
}

function candidateLine(c: MatchCandidateFacts): string {
  const pct = onTimePct(c.stats);
  const parts = [
    STATE_TEXT[c.state],
    `заказов в работе: ${c.load}`,
    `рейтинг ${c.rating} (оценок: ${c.reviews})`,
    `совпало навыков: ${c.matchedSkills}`,
    c.stats ? `за ${HISTORY.days} дней сдано ${c.stats.done}${pct === null ? "" : `, вовремя ${pct}%`}, отмен ${c.stats.cancelled}, отказов ${c.stats.refusals}` : "истории за 90 дней нет",
    c.stats?.avgHours !== undefined ? `в среднем ${c.stats.avgHours} ч на заказ` : null,
    c.districtOnly ? "работает только в своих районах" : "работает по всему городу",
  ];
  return `${c.label}: ${parts.filter(Boolean).join("; ")}`;
}

/**
 * Инструкция и данные для LLM — одним сообщением роли user (шлюз не принимает system). Только услуга, город и район,
 * срок, срочность, навыки и обезличенные показатели кандидатов: ни имени, ни телефона, ни адреса клиента, ни описания.
 */
export function buildMatchPrompt(o: MatchOrderFacts, candidates: readonly MatchCandidateFacts[]): string {
  const due = o.hoursLeft < 0 ? `просрочен на ${Math.abs(o.hoursLeft)} ч` : `через ${o.hoursLeft} ч`;
  return [
    "Ты помогаешь диспетчеру сервисной компании в Казахстане выбрать исполнителя на заказ. Решение принимает человек — ты только советуешь.",
    "Все кандидаты уже подходят по правилам (город, направление, навыки, на смене). Расставь их от лучшего к худшему:",
    "важнее всего успеть в срок и не получить отказ, затем качество (рейтинг, сдача вовремя), затем равномерная загрузка.",
    'Ответь только JSON-объектом: {"order": ["К2","К1",...], "reasons": {"К2": "коротко почему", ...}, "summary": "1–2 предложения"}.',
    "В order — все метки кандидатов ровно по одному разу. Тексты — по-русски, коротко, без выдуманных фактов: опирайся только на данные ниже.",
    "",
    `Заказ: ${o.service} (${o.category}); город ${o.city}${o.district ? `, район ${o.district}` : ""}; срок ${due}; срочность ${URGENCY_TEXT[o.priority]}${
      o.requiredSkills.length ? `; нужны навыки: ${o.requiredSkills.join(", ")}` : ""
    }.`,
    "Кандидаты:",
    ...candidates.map(candidateLine),
  ].join("\n");
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const text = (x: unknown, max: number): string | null => (typeof x === "string" && x.trim() ? clip(x.replace(/\s+/g, " ").trim(), max) : null);

/**
 * Ответ LLM → порядок меток и объяснения. Чужие и повторные метки отбрасываем, пропущенных добавляем в конец
 * в порядке правил. Совсем неразборчивый ответ (нет ни одной нашей метки) — null.
 */
export function parseMatchAnswer(raw: Record<string, unknown>, labels: readonly string[]): { order: string[]; reasons: Record<string, string>; summary: string } | null {
  const known = new Set(labels);
  const picked: string[] = [];
  if (Array.isArray(raw.order)) {
    for (const x of raw.order) {
      const label = typeof x === "string" ? x.trim().toUpperCase().replace("K", "К") : "";
      if (known.has(label) && !picked.includes(label)) picked.push(label);
    }
  }
  if (!picked.length) return null;
  const order = [...picked, ...labels.filter((l) => !picked.includes(l))];
  const reasons: Record<string, string> = {};
  if (raw.reasons && typeof raw.reasons === "object" && !Array.isArray(raw.reasons)) {
    for (const [k, v] of Object.entries(raw.reasons as Record<string, unknown>)) {
      const label = k.trim().toUpperCase().replace("K", "К");
      const why = text(v, WHY_MAX);
      if (known.has(label) && why) reasons[label] = why;
    }
  }
  return { order, reasons, summary: text(raw.summary, SUMMARY_MAX) ?? "" };
}

/** Почему кандидат на этом месте по правилам: «свободен, заказов в работе: 0, рейтинг 4,9, вовремя 92% · отказов 1». */
export const rulesWhy = (c: Candidate): string => autoAssignWhy(c);

export const RULES_SUMMARY = "Порядок по правилам подбора: подходит заказу, свободные раньше занятых, меньше заказов в работе, больше баллов качества (рейтинг и история за 90 дней).";
