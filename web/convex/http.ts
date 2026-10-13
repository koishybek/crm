import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { auth } from "./auth";
import { whatsappVerify, whatsappWebhook, WEBHOOK_PATH as WHATSAPP_WEBHOOK } from "./channels/whatsapp";
import { env } from "./env";
import { safeEqual } from "./lib/crypto";
import { createLeadHttp, getLeadHttp } from "./publicApi";
import { leadOptions, leadPost } from "./site";

const http = httpRouter();

auth.addHttpRoutes(http);

/** Вебхук Telegram. Секрет из setWebhook приходит в заголовке — чужие запросы отбрасываем. */
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
    // Отвечаем Telegram сразу, обработка — фоном (иначе он повторит запрос).
    await ctx.scheduler.runAfter(0, internal.telegram.handleUpdate, { update });
    return new Response("ok", { status: 200 });
  }),
});

// ── Телефония: события АТС ──────────────────────────────────────────────────
// POST /pbx/events?secret=… (или заголовок X-Pbx-Secret), тело JSON или form-urlencoded:
//   event: ringing | answered | ended | missed | recording
//   callId, direction (in|out), from, to, operator (email/телефон сотрудника), duration (сек), recordingUrl, at (ISO)
// Названия полей у АТС разные — принимаем распространённые варианты.

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
    const expected = await ctx.runQuery(internal.calls._pbxSecret, {});
    if (!expected) return new Response("not configured", { status: 503 });
    const url = new URL(request.url);
    const given = request.headers.get("x-pbx-secret") ?? url.searchParams.get("secret");
    if (!given || !safeEqual(given, expected)) return new Response("forbidden", { status: 403 });
    let body: Record<string, unknown> = {};
    const type = request.headers.get("content-type") ?? "";
    try {
      if (type.includes("application/json")) body = (await request.json()) as Record<string, unknown>;
      else body = Object.fromEntries(new URLSearchParams(await request.text()));
    } catch {
      return new Response("bad body", { status: 400 });
    }
    const event = pick(body, "event", "type", "status", "state");
    if (!event) return new Response("event required", { status: 400 });
    const dir = pick(body, "direction", "dir", "call_type");
    const duration = Number(pick(body, "duration", "billsec", "talk_time", "seconds"));
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
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  }),
});

// ── WhatsApp Cloud API (Meta) ───────────────────────────────────────────────
// Callback URL в Meta: https://<deployment>.convex.site/whatsapp/webhook. GET — проверка адреса, POST — события (подпись App Secret).
http.route({ path: WHATSAPP_WEBHOOK, method: "GET", handler: whatsappVerify });
http.route({ path: WHATSAPP_WEBHOOK, method: "POST", handler: whatsappWebhook });

// ── Заявки с сайта и публичный API ───────────────────────────────────────────
// CORS — только у формы сайта: её зовут браузеры с /zayavka и с сайтов компании. API — для серверов, по ключу.
http.route({ path: "/public/lead", method: "OPTIONS", handler: leadOptions });
http.route({ path: "/public/lead", method: "POST", handler: leadPost });
http.route({ path: "/api/v1/leads", method: "POST", handler: createLeadHttp });
http.route({ pathPrefix: "/api/v1/leads/", method: "GET", handler: getLeadHttp });

export default http;
