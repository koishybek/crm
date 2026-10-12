// AI-сервис Home Max Service (Cloudflare Worker + Workers AI).
//   POST /v1/transcribe  — тело: аудио (wav/mp3/ogg/m4a), ответ: { text, language, seconds }
//   POST /v1/extract     — тело: { text, services, cities, today, channel }, ответ: разбор заявки
//   GET  /v1/health
// Доступ — заголовок Authorization: Bearer <AI_SECRET>.

interface Env {
  AI: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  AI_SECRET?: string;
}

const STT = "@cf/openai/whisper-large-v3-turbo";
const LLM = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_AUDIO = 25 * 1024 * 1024;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

async function transcribe(req: Request, env: Env, url: URL) {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length) throw new HttpError(400, "Пустой файл");
  if (bytes.length > MAX_AUDIO) throw new HttpError(413, "Запись больше 25 МБ");
  const language = url.searchParams.get("language") || undefined;
  const out = (await env.AI.run(STT, {
    audio: toBase64(bytes),
    task: "transcribe",
    vad_filter: true,
    ...(language ? { language } : {}),
    initial_prompt: "Телефонный разговор клиента с оператором сервисной компании в Казахстане: ремонт техники, кондиционеры, сантехника, электрика, уборка, IT.",
  })) as { text?: string; transcription_info?: { language?: string; duration?: number } };
  return { text: (out.text ?? "").trim(), language: out.transcription_info?.language ?? language ?? null, seconds: out.transcription_info?.duration ?? null };
}

type Service = { id: string; label: string };
type ExtractIn = { text: string; services: Service[]; cities?: string[]; today?: string; channel?: "call" | "message" };

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    serviceId: { type: ["string", "null"] },
    city: { type: ["string", "null"] },
    address: { type: ["string", "null"] },
    when: { type: ["string", "null"] },
    budget: { type: ["number", "null"] },
    urgency: { type: "string" },
    clientName: { type: ["string", "null"] },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "serviceId", "city", "address", "when", "budget", "urgency", "clientName", "questions"],
};

async function extract(body: ExtractIn, env: Env) {
  const text = (body.text ?? "").trim().slice(0, 12000);
  if (text.length < 3) throw new HttpError(400, "Нет текста для разбора");
  const services = (body.services ?? []).slice(0, 300);
  const list = services.map((s) => `${s.id} — ${s.label}`).join("\n");
  const system = [
    "Ты помощник оператора сервисной компании в Казахстане. Из обращения клиента извлеки данные для заявки.",
    "Отвечай только JSON по схеме. Все тексты — на русском, даже если клиент писал по-казахски.",
    "summary — 1–3 коротких предложения: что случилось и что клиент хочет, без воды.",
    `serviceId — ровно один id из списка услуг ниже, наиболее подходящий; если ни одна не подходит — null.\nУслуги:\n${list}`,
    `city — город клиента${body.cities?.length ? ` (обычно один из: ${body.cities.join(", ")})` : ""}, иначе null. address — улица/микрорайон/дом/квартира, если названы.`,
    `when — когда клиенту удобно, коротко как он сказал (например «завтра после 18:00»); сегодня ${body.today ?? "неизвестно"}. budget — сумма в тенге числом, если названа.`,
    "urgency: urgent — авария, течёт, нет света/воды, «срочно», «сегодня»; high — нужно в ближайшие 1–2 дня; иначе normal.",
    "clientName — имя клиента, если представился. questions — до 3 вопросов, которые оператору стоит уточнить (того, чего нет в обращении).",
  ].join("\n");
  const user = `${body.channel === "message" ? "Сообщение клиента" : "Расшифровка звонка"}:\n"""\n${text}\n"""`;
  const out = (await env.AI.run(LLM, {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: SCHEMA },
    temperature: 0.1,
    max_tokens: 700,
  })) as { response?: unknown };
  const raw = typeof out.response === "string" ? safeParse(out.response) : out.response;
  if (!raw || typeof raw !== "object") throw new HttpError(502, "AI вернул не JSON");
  return normalize(raw as Record<string, unknown>, services);
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    return m ? JSON.parse(m[0]) : null;
  }
}

const str = (v: unknown, max = 300) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim().slice(0, max) : null);

function normalize(r: Record<string, unknown>, services: Service[]) {
  const serviceId = str(r.serviceId, 80);
  const urgency = r.urgency === "urgent" || r.urgency === "high" ? r.urgency : "normal";
  const budget = typeof r.budget === "number" && r.budget > 0 && r.budget < 100_000_000 ? Math.round(r.budget) : null;
  return {
    summary: str(r.summary, 600) ?? "",
    serviceId: serviceId && services.some((s) => s.id === serviceId) ? serviceId : null,
    city: str(r.city, 60),
    address: str(r.address, 200),
    when: str(r.when, 120),
    budget,
    urgency,
    clientName: str(r.clientName, 80),
    questions: Array.isArray(r.questions) ? r.questions.map((q) => str(q, 200)).filter((q): q is string => !!q).slice(0, 3) : [],
  };
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/health") return json({ ok: true, stt: STT, llm: LLM });
    if (!env.AI_SECRET || req.headers.get("authorization") !== `Bearer ${env.AI_SECRET}`) return json({ error: "unauthorized" }, 401);
    try {
      if (req.method === "POST" && url.pathname === "/v1/transcribe") return json(await transcribe(req, env, url));
      if (req.method === "POST" && url.pathname === "/v1/extract") return json(await extract((await req.json()) as ExtractIn, env));
      return json({ error: "not found" }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      const message = e instanceof Error ? e.message : String(e);
      console.error("ai error", message);
      return json({ error: "AI временно недоступен", detail: message.slice(0, 300) }, 502);
    }
  },
};
