import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { olxCallback } from "./channels/olx";
import { whatsappVerify, whatsappWebhook, WEBHOOK_PATH as WHATSAPP_WEBHOOK } from "./channels/whatsapp";
import { env } from "./env";
import { serveFile } from "./files";
import { safeEqual } from "./lib/crypto";
import { FILES_PATH } from "./lib/files";
import { OLX_CALLBACK_PATH } from "./lib/olxApi";
import { createLeadHttp, getLeadHttp } from "./publicApi";
import { leadOptions, leadPost } from "./site";

const http = httpRouter();

auth.addHttpRoutes(http);

/** update_id обновления Telegram; null — его нет (не обновление Bot API). */
function updateIdOf(update: unknown): number | null {
  const id = typeof update === "object" && update !== null ? (update as { update_id?: unknown }).update_id : undefined;
  return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}

/** Вебхук Telegram. Секрет из setWebhook приходит в заголовке — чужие запросы отбрасываем (сравнение за постоянное время). */
http.route({
  path: "/telegram",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const secret = env("TELEGRAM_WEBHOOK_SECRET");
    if (!secret || !safeEqual(request.headers.get("x-telegram-bot-api-secret-token") ?? "", secret)) return new Response("forbidden", { status: 403 });
    let update: unknown;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    // Повтор доставки (Telegram не дождался ответа) приходит с тем же update_id — второй раз не обрабатываем (аудит L-3).
    const updateId = updateIdOf(update);
    if (updateId !== null && !(await ctx.runMutation(internal.telegram._firstSeen, { updateId }))) return new Response("ok", { status: 200 });
    // Отвечаем Telegram сразу, обработка — фоном (иначе он повторит запрос).
    await ctx.scheduler.runAfter(0, internal.telegram.handleUpdate, { update });
    return new Response("ok", { status: 200 });
  }),
});

// ── Телефония: события АТС ──────────────────────────────────────────────────
// POST /pbx/events, ключ — в заголовке X-Pbx-Secret. ?secret=… в адресе тоже принимается — для АТС, которые не умеют
// заголовки, но это менее безопасно: адрес с ключом оседает в журналах АТС и прокси (аудит L-2, E20).
// Тело JSON или form-urlencoded, не больше 64 КБ:
//   event: ringing | answered | ended | missed | recording
//   callId, direction (in|out), from, to, operator (email/телефон сотрудника), duration (сек), recordingUrl, at (ISO)
// Названия полей у АТС разные — принимаем распространённые варианты.

/** Событие звонка — несколько полей: больше 64 КБ — не событие АТС. */
const PBX_MAX_BODY = 64 * 1024;

const pick = (o: Record<string, unknown>, ...keys: string[]) => {
  for (const k of keys) {
    const val = o[k];
    if (val !== undefined && val !== null && String(val).trim() !== "") return String(val).trim();
  }
  return undefined;
};

http.route({
  path: "/pbx/events",
  method: "GET",
  handler: httpAction(async () => new Response("ok", { status: 200 })),
});

http.route({
  path: "/pbx/events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    // Отказ АТС — красная отметка «Телефония» в «Состоянии системы»: владелец видит, что события не доходят и почему.
    const reject = async (status: number, body: string, why: string) => {
      await ctx.runMutation(internal.health._mark, { key: "pbx", ok: false, note: why });
      return new Response(body, { status });
    };
    const expected = await ctx.runQuery(internal.calls._pbxSecret, {});
    if (!expected) return new Response("not configured", { status: 503 });
    // Заголовок важнее адреса: если ключ есть в обоих, проверяем заголовок.
    const header = request.headers.get("x-pbx-secret");
    const given = header ?? new URL(request.url).searchParams.get("secret");
    if (!given || !safeEqual(given, expected)) {
      await ctx.runMutation(internal.calls._pbxRejected, { via: header !== null ? "header" : given ? "query" : "none" });
      return new Response("forbidden", { status: 403 });
    }
    const tooLarge = "АТС прислала слишком большое событие (больше 64 КБ)";
    if (Number(request.headers.get("content-length") ?? 0) > PBX_MAX_BODY) return reject(413, "too large", tooLarge);
    const raw = await request.text();
    if (raw.length > PBX_MAX_BODY) return reject(413, "too large", tooLarge);
    let parsed: unknown;
    const type = request.headers.get("content-type") ?? "";
    try {
      parsed = type.includes("application/json") ? (JSON.parse(raw) as unknown) : Object.fromEntries(new URLSearchParams(raw));
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return reject(400, "bad body", "АТС прислала событие, которое не удалось прочитать");
    const body = parsed as Record<string, unknown>;
    const event = pick(body, "event", "type", "status", "state");
    if (!event) return reject(400, "event required", "АТС прислала событие без типа (event)");
    const dir = pick(body, "direction", "dir", "call_type");
    const duration = Number(pick(body, "duration", "billsec", "talk_time", "seconds"));
    try {
      await ctx.runMutation(internal.calls._ingest, {
        event,
        externalId: pick(body, "callId", "call_id", "uuid", "id", "callid"),
        direction: dir && /^(out|outgoing|исход)/i.test(dir) ? "out" : "in",
        from: pick(body, "from", "caller", "caller_id", "src", "number_from", "client_number"),
        to: pick(body, "to", "callee", "dst", "did", "number_to"),
        operator: pick(body, "operator", "agent", "user", "employee", "operator_email"),
        duration: Number.isFinite(duration) ? duration : undefined,
        recordingUrl: pick(body, "recordingUrl", "recording_url", "recording", "record", "link", "record_url"),
        at: pick(body, "at", "time", "timestamp", "date"),
      });
    } catch (e) {
      console.error(`АТС: событие не сохранено: ${e instanceof Error ? e.name : "ошибка"}`);
      return reject(500, "error", "Событие АТС не сохранено — внутренняя ошибка");
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }),
});

// ── WhatsApp Cloud API (Meta) ───────────────────────────────────────────────
// Callback URL в Meta: https://<deployment>.convex.site/whatsapp/webhook. GET — проверка адреса, POST — события (подпись App Secret).
http.route({ path: WHATSAPP_WEBHOOK, method: "GET", handler: whatsappVerify });
http.route({ path: WHATSAPP_WEBHOOK, method: "POST", handler: whatsappWebhook });

// ── OLX.kz (Partner API) ─────────────────────────────────────────────────────
// Адрес возврата после входа в OLX — зарегистрирован в приложении developer.olx.kz: https://<deployment>.convex.site/olx/callback.
http.route({ path: OLX_CALLBACK_PATH, method: "GET", handler: olxCallback });

// ── Заявки с сайта и публичный API ───────────────────────────────────────────
// CORS — только у формы сайта: её зовут браузеры с /zayavka и с сайтов компании. API — для серверов, по ключу.
http.route({ path: "/public/lead", method: "OPTIONS", handler: leadOptions });
http.route({ path: "/public/lead", method: "POST", handler: leadPost });
http.route({ path: "/api/v1/leads", method: "POST", handler: createLeadHttp });
http.route({ pathPrefix: "/api/v1/leads/", method: "GET", handler: getLeadHttp });

// ── Файлы по подписанной ссылке ─────────────────────────────────────────────
// GET /files/<storageId>?exp=…&sig=… — фото, документы, записи звонков и копии; ссылку выдаёт запрос с проверкой доступа,
// живёт она 15 минут (convex/files.ts). Поддерживает Range — перемотка аудио и видео.
http.route({ pathPrefix: FILES_PATH, method: "GET", handler: serveFile });

export default http;
