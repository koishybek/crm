// Zadarma. Документация: https://zadarma.com/ru/support/api/ (разделы «Авторизация», «/v1/request/callback/»,
// «/v1/pbx/record/request/», «Webhook-уведомления»).
// API: https://api.zadarma.com, заголовок «Authorization: key:подпись», подпись = base64(hex(HMAC-SHA1(метод + строка
// параметров по алфавиту + md5(строка параметров), secret))) — как base64_encode(hash_hmac('sha1', …)) в их примерах.
// Вебхуки (POST, form-urlencoded) подписаны заголовком Signature — base64(hex(HMAC-SHA1(поля события, secret))):
//   NOTIFY_START, NOTIFY_INTERNAL, NOTIFY_END: caller_id + called_did + call_start
//   NOTIFY_ANSWER: caller_id + destination + call_start
//   NOTIFY_OUT_START, NOTIFY_OUT_END: internal + destination + call_start
//   NOTIFY_RECORD: pbx_call_id + call_id_with_rec
// Проверка адреса при сохранении в кабинете — GET с zd_echo: отвечаем тем же значением (http.ts).
import { safeEqual } from "../crypto";
import { hmacHexBase64 } from "../hmac";
import { md5Hex } from "../md5";
import { field, flatFields, jsonObject, providerFetch, ProviderError, str } from "../providerHttp";
import { isExtension, seconds, textReply, type CallEvent, type PbxAdapter, type PbxCreds, type WebhookInput, type WebhookResult } from "./types";

export const ZADARMA_API = "https://api.zadarma.com";
const LABEL = "Zadarma";

/** Какие поля события подписаны (по документации Zadarma). */
const SIGNED: Record<string, readonly string[]> = {
  NOTIFY_START: ["caller_id", "called_did", "call_start"],
  NOTIFY_INTERNAL: ["caller_id", "called_did", "call_start"],
  NOTIFY_END: ["caller_id", "called_did", "call_start"],
  NOTIFY_ANSWER: ["caller_id", "destination", "call_start"],
  NOTIFY_OUT_START: ["internal", "destination", "call_start"],
  NOTIFY_OUT_END: ["internal", "destination", "call_start"],
  NOTIFY_RECORD: ["pbx_call_id", "call_id_with_rec"],
};

/** Подпись запроса к API: метод — путь с версией («/v1/request/callback/»), параметры — по алфавиту. */
export async function zadarmaAuth(creds: PbxCreds, method: string, params: Record<string, string>): Promise<{ query: string; authorization: string }> {
  const query = new URLSearchParams(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString();
  const sign = await hmacHexBase64("SHA-1", creds.secret ?? "", method + query + md5Hex(query));
  return { query, authorization: `${creds.key}:${sign}` };
}

async function api(creds: PbxCreds, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  if (!creds.key || !creds.secret) throw new ProviderError("Zadarma: не заданы Key и Secret");
  const { query, authorization } = await zadarmaAuth(creds, method, params);
  const r = await providerFetch(`${ZADARMA_API}${method}${query ? `?${query}` : ""}`, { method: "GET", headers: { Authorization: authorization } }, LABEL);
  const body = jsonObject(r, LABEL);
  if (str(body, "status") !== "success") throw new ProviderError(`Zadarma: ${str(body, "message")?.slice(0, 160) || `отказ (HTTP ${r.status})`}`);
  return body;
}

/** Подпись события: проверяем до разбора. */
export async function zadarmaSignature(fields: Map<string, string>, event: string, secret: string): Promise<string | null> {
  const keys = SIGNED[event];
  if (!keys) return null;
  return hmacHexBase64("SHA-1", secret, keys.map((k) => fields.get(k) ?? "").join(""));
}

async function parseWebhook(input: WebhookInput, creds: PbxCreds): Promise<WebhookResult> {
  const f = flatFields(input.body, input.contentType);
  if (!f) return { ok: false, status: 400, why: "Zadarma прислала событие, которое не удалось прочитать" };
  const event = field(f, "event") ?? "";
  if (!creds.secret) return { ok: false, status: 503, why: "Zadarma: не задан Secret — подпись событий проверить нечем" };
  const expected = await zadarmaSignature(f, event, creds.secret);
  // Неизвестное событие (SMS, смена статуса номера) — подтверждаем без разбора; подпись у них считается иначе.
  if (!expected) return { ok: true, events: [], reply: textReply() };
  const given = input.headers.get("signature") ?? "";
  if (!given || !safeEqual(given, expected)) return { ok: false, status: 403, why: "Zadarma: неверная подпись события (Signature)" };
  const id = field(f, "pbx_call_id");
  if (!id) return { ok: false, status: 400, why: "Zadarma: в событии нет pbx_call_id" };
  const internal = field(f, "internal");
  const operator = isExtension(internal) ? internal : undefined;
  const answered = field(f, "disposition")?.toLowerCase() === "answered";
  const duration = seconds(field(f, "duration"));
  const ev = (e: Omit<CallEvent, "externalId">): CallEvent => ({ externalId: id, ...e });
  const ok = (events: CallEvent[]): WebhookResult => ({ ok: true, events, reply: textReply() });
  switch (event) {
    case "NOTIFY_START":
      return ok([ev({ event: "ringing", direction: "in", from: field(f, "caller_id"), to: field(f, "called_did") })]);
    case "NOTIFY_INTERNAL":
      return ok([ev({ event: "ringing", direction: "in", from: field(f, "caller_id"), to: field(f, "called_did"), operator })]);
    case "NOTIFY_ANSWER":
      return ok([ev({ event: "answered", operator: operator ?? (isExtension(field(f, "destination")) ? field(f, "destination") : undefined) })]);
    case "NOTIFY_END":
      return ok([ev({ event: answered ? "ended" : "missed", direction: "in", from: field(f, "caller_id"), to: field(f, "called_did"), operator, duration: answered ? duration : 0 })]);
    case "NOTIFY_OUT_START":
      return ok([ev({ event: "ringing", direction: "out", from: field(f, "caller_id"), to: field(f, "destination"), operator })]);
    case "NOTIFY_OUT_END":
      return ok([ev({ event: answered ? "ended" : "missed", direction: "out", from: field(f, "caller_id"), to: field(f, "destination"), operator, duration: answered ? duration : 0 })]);
    case "NOTIFY_RECORD": {
      const rec = field(f, "call_id_with_rec");
      if (!rec) return ok([]);
      return { ok: true, events: [], recording: { externalId: id, ref: { kind: "id", id: rec } }, reply: textReply() };
    }
    default:
      return ok([]);
  }
}

export const zadarma: PbxAdapter = {
  provider: "zadarma",
  parseWebhook,
  async dial(creds, _session, extension, phone) {
    // Zadarma сначала звонит на from (внутренний номер сотрудника), затем соединяет с to.
    await api(creds, "/v1/request/callback/", { from: extension, to: phone });
    return {};
  },
  async recordingUrl(creds, _session, ref) {
    if (ref.kind === "url") return ref.url;
    const body = await api(creds, "/v1/pbx/record/request/", { call_id: ref.id });
    const link = str(body, "link") ?? (Array.isArray(body.links) && typeof body.links[0] === "string" ? body.links[0] : undefined);
    if (!link) throw new ProviderError("Zadarma: ссылка на запись не выдана");
    return link;
  },
  async check(creds) {
    await api(creds, "/v1/info/balance/", {});
    return "Zadarma отвечает, ключи верные";
  },
};
