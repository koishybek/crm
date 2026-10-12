// AI-слой (ТЗ п.8, п.20): расшифровка звонков и разбор обращений → черновик заявки.
// Провайдер меняется переменными окружения, код CRM не трогаем:
//   по умолчанию  AI_URL + AI_SECRET          — наш сервис на Cloudflare Workers AI (ai-service/)
//   AI_PROVIDER=openai + AI_API_KEY [+ AI_BASE_URL, AI_STT_MODEL, AI_LLM_MODEL] — любой OpenAI-совместимый API
// Правило ТЗ: AI ничего не решает сам — только предлагает; финансы и статусы заказов он не трогает.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, query, type ActionCtx } from "./_generated/server";
import { env } from "./env";
import { URGENCY } from "../src/data/catalog";
import { money } from "../src/lib/format";
import type { AiDraft, AiSummary, Urgency } from "../src/data/types";

export interface Extraction {
  summary: string;
  serviceId: string | null;
  city: string | null;
  address: string | null;
  when: string | null;
  budget: number | null;
  urgency: Urgency;
  clientName: string | null;
  questions: string[];
}

type Provider = { kind: "worker"; url: string; secret: string } | { kind: "openai"; base: string; key: string; stt: string; llm: string };

export function aiProvider(): Provider | null {
  if (env("AI_PROVIDER") === "openai" && env("AI_API_KEY")) {
    return { kind: "openai", base: (env("AI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, ""), key: env("AI_API_KEY")!, stt: env("AI_STT_MODEL") ?? "whisper-1", llm: env("AI_LLM_MODEL") ?? "gpt-4.1-mini" };
  }
  const url = env("AI_URL");
  const secret = env("AI_SECRET");
  return url && secret ? { kind: "worker", url: url.replace(/\/$/, ""), secret } : null;
}

const TIMEOUT_MS = 120_000;
async function call(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    throw new ConvexError(e instanceof Error && e.name === "AbortError" ? "AI не ответил вовремя — попробуйте ещё раз" : "AI недоступен — попробуйте позже");
  } finally {
    clearTimeout(t);
  }
}

async function fail(res: Response): Promise<never> {
  let detail = "";
  try {
    detail = ((await res.json()) as { error?: string }).error ?? "";
  } catch {
    /* не JSON */
  }
  throw new ConvexError(detail && res.status < 500 ? detail : "AI не смог обработать запрос");
}

// Whisper на тишине «досочиняет» титры из видео, на которых его учили. В звонках таких фраз не бывает.
const PHANTOMS = [/продолжение следует\.*/gi, /субтитры (?:сделал|создавал|подготовил)[^.!?]*[.!?]?/gi, /редактор субтитров[^.!?]*[.!?]?/gi, /спасибо за просмотр[.!]?/gi, /подписывайтесь на (?:наш )?канал[^.!?]*[.!?]?/gi];
export const cleanTranscript = (t: string) => PHANTOMS.reduce((s, re) => s.replace(re, " "), t).replace(/\s{2,}/g, " ").trim();

export async function transcribe(audio: Blob): Promise<{ text: string; language: string | null; seconds: number | null }> {
  const p = aiProvider();
  if (!p) throw new ConvexError("AI не подключён");
  if (p.kind === "worker") {
    const res = await call(`${p.url}/v1/transcribe`, { method: "POST", headers: { Authorization: `Bearer ${p.secret}`, "Content-Type": audio.type || "application/octet-stream" }, body: audio });
    if (!res.ok) await fail(res);
    const j = (await res.json()) as { text: string; language: string | null; seconds: number | null };
    return { ...j, text: cleanTranscript(j.text ?? "") };
  }
  const form = new FormData();
  form.append("file", audio, "call.wav");
  form.append("model", p.stt);
  const res = await call(`${p.base}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${p.key}` }, body: form });
  if (!res.ok) await fail(res);
  const j = (await res.json()) as { text?: string; language?: string; duration?: number };
  return { text: cleanTranscript(j.text ?? ""), language: j.language ?? null, seconds: j.duration ?? null };
}

export type CatalogHint = { services: { id: string; label: string }[]; cities: string[] };

export async function extract(text: string, hint: CatalogHint, channel: "call" | "message"): Promise<Extraction> {
  const p = aiProvider();
  if (!p) throw new ConvexError("AI не подключён");
  const today = new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10); // Алматы, UTC+5
  if (p.kind === "worker") {
    const res = await call(`${p.url}/v1/extract`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, services: hint.services, cities: hint.cities, today, channel }),
    });
    if (!res.ok) await fail(res);
    return sanitize((await res.json()) as Partial<Extraction>, hint);
  }
  const res = await call(`${p.base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: p.llm,
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            `Извлеки данные для заявки сервисной компании (Казахстан). Ответ — JSON с полями summary (1–3 предложения по-русски), serviceId (id из списка или null), city, address, when, budget (число в тенге или null), urgency (normal|high|urgent), clientName, questions (до 3 вопросов оператору). Сегодня ${today}.\nУслуги:\n` +
            hint.services.map((s) => `${s.id} — ${s.label}`).join("\n"),
        },
        { role: "user", content: text.slice(0, 12000) },
      ],
    }),
  });
  if (!res.ok) await fail(res);
  const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  let parsed: Partial<Extraction> = {};
  try {
    parsed = JSON.parse(j.choices?.[0]?.message?.content ?? "{}") as Partial<Extraction>;
  } catch {
    throw new ConvexError("AI вернул неразборчивый ответ");
  }
  return sanitize(parsed, hint);
}

/** Доверяем AI только в рамках справочника: чужие id и мусор — в null. */
function sanitize(r: Partial<Extraction>, hint: CatalogHint): Extraction {
  const s = (x: unknown, max = 300) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null);
  const city = s(r.city, 60);
  return {
    summary: s(r.summary, 600) ?? "",
    serviceId: r.serviceId && hint.services.some((x) => x.id === r.serviceId) ? r.serviceId : null,
    city: city ? (hint.cities.find((c) => c.toLowerCase() === city.toLowerCase()) ?? city) : null,
    address: s(r.address, 200),
    when: s(r.when, 120),
    budget: typeof r.budget === "number" && r.budget > 0 ? Math.round(r.budget) : null,
    urgency: r.urgency === "urgent" || r.urgency === "high" ? r.urgency : "normal",
    clientName: s(r.clientName, 80),
    questions: Array.isArray(r.questions) ? r.questions.map((q) => s(q, 200)).filter((q): q is string => !!q).slice(0, 3) : [],
  };
}

/** Разбор → блок «AI-разбор» в заявке и черновик полей формы. */
export function toSummary(x: Extraction, serviceLabel: (id: string) => string): { ai: AiSummary; draft: AiDraft } {
  const extracted = [
    x.serviceId && { label: "Услуга", value: serviceLabel(x.serviceId) },
    x.city && { label: "Город", value: x.city },
    x.address && { label: "Адрес", value: x.address },
    x.when && { label: "Когда", value: x.when },
    { label: "Срочность", value: URGENCY[x.urgency].label },
    x.budget && { label: "Бюджет", value: money(x.budget) },
    x.clientName && { label: "Имя", value: x.clientName },
  ].filter((e): e is { label: string; value: string } => !!e);
  const description = [x.summary, x.address ? `Адрес: ${x.address}.` : "", x.when ? `Когда: ${x.when}.` : "", x.budget ? `Бюджет клиента: ${money(x.budget)}.` : ""]
    .filter(Boolean)
    .join(" ");
  return {
    ai: { summary: x.summary || "AI не смог кратко пересказать обращение", extracted, questions: x.questions },
    draft: {
      serviceId: x.serviceId ?? undefined,
      city: x.city ?? undefined,
      address: x.address ?? undefined,
      urgency: x.urgency,
      clientName: x.clientName ?? undefined,
      description: description || undefined,
    },
  };
}

// ── Для интерфейса ───────────────────────────────────────────────────────────

export const status = query({
  args: {},
  handler: async () => {
    const p = aiProvider();
    return { enabled: !!p, provider: p?.kind === "openai" ? "OpenAI-совместимый API" : p ? "Cloudflare Workers AI" : null };
  },
});

async function staffOnly(ctx: ActionCtx) {
  const role = await ctx.runQuery(internal.users._viewerRole, {});
  if (role !== "owner" && role !== "operator" && role !== "manager") throw new ConvexError("Нет доступа");
}

/** Оператор вставил сообщение клиента (WhatsApp/OLX/Instagram) — AI раскладывает его по полям заявки. */
export const parseText = action({
  args: { text: v.string() },
  handler: async (ctx, { text }): Promise<{ ai: AiSummary; draft: AiDraft }> => {
    await staffOnly(ctx);
    if (text.trim().length < 5) throw new ConvexError("Вставьте текст обращения");
    const hint: CatalogHint = await ctx.runQuery(internal.catalog._hint, {});
    const x = await extract(text, hint, "message");
    return toSummary(x, (id) => hint.services.find((s) => s.id === id)?.label ?? id);
  },
});

/**
 * Фоновая обработка звонка: скачать запись (если пришла ссылкой от АТС) → в хранилище →
 * расшифровать → разобрать → сохранить на звонке; если AI уверенно понял услугу — создать заявку (кроме autoLead=false).
 */
export const processCall = internalAction({
  args: { callId: v.id("calls"), autoLead: v.optional(v.boolean()) },
  handler: async (ctx, { callId, autoLead }): Promise<void> => {
    const c: Doc<"calls"> | null = await ctx.runQuery(internal.calls._get, { id: callId });
    if (!c) return;
    if (!aiProvider()) return void (await ctx.runMutation(internal.calls._saveAi, { id: callId, status: "none" }));
    try {
      let recordingId: Id<"_storage"> | undefined = c.recordingId;
      if (!recordingId && c.recordingUrl) {
        const res = await call(c.recordingUrl, {});
        if (!res.ok) throw new ConvexError(`АТС не отдала запись (HTTP ${res.status})`);
        recordingId = await ctx.storage.store(await res.blob());
      }
      if (!recordingId) return void (await ctx.runMutation(internal.calls._saveAi, { id: callId, status: "none" }));
      const blob = await ctx.storage.get(recordingId);
      if (!blob) throw new ConvexError("Запись не найдена в хранилище");
      const { text } = await transcribe(blob);
      if (!text) throw new ConvexError("В записи не распознана речь");
      const hint: CatalogHint = await ctx.runQuery(internal.catalog._hint, {});
      const x = await extract(text, hint, "call");
      const { ai, draft } = toSummary(x, (id) => hint.services.find((s) => s.id === id)?.label ?? id);
      await ctx.runMutation(internal.calls._saveAi, { id: callId, status: "done", recordingId, transcript: text, ai, draft, autoLead: autoLead !== false && !!x.serviceId });
    } catch (e) {
      await ctx.runMutation(internal.calls._saveAi, { id: callId, status: "failed", error: e instanceof ConvexError ? String(e.data) : "Ошибка AI" });
    }
  },
});

