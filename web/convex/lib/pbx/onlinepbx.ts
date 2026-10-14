// OnlinePBX. Документация API: https://api.onlinepbx.ru/ (схема https://api.onlinepbx.ru/api-scheme.yaml, сервер
// https://api2.onlinepbx.ru): вход — POST /{домен}/auth.json c auth_key → key_id и key (живут трое суток с последнего
// обращения), дальше заголовок «x-pbx-authentication: key_id:key»; звонок — /{домен}/call/now.json (from, to);
// запись — /{домен}/mongo_history/search.json c uuid и download=1 (в data — ссылка). Тела — form-urlencoded.
// Вебхуки («Интеграция → Вебхуки»): event (call_start, call_user_start, call_answered, call_end), direction (inbound,
// outbound, local), uuid, caller, callee, domain, call_duration, dialog_duration, hangup_cause, download_url —
// поля как в описании коннекторов (https://apimonster.ru/connector/trigger/onlinepbx/event/call-end/).
// Подписи у вебхуков OnlinePBX нет: принимаем только по ключу АТС в адресе (?key=, проверяет http.ts) и только для
// своего домена (поле domain).
import { checkPublicUrl } from "../safeFetch";
import { field, flatFields, jsonObject, providerFetch, ProviderError, str } from "../providerHttp";
import { isExtension, seconds, textReply, unixIso, type CallEvent, type PbxAdapter, type PbxCreds, type PbxSession, type WebhookInput, type WebhookResult } from "./types";
import { ONLINEPBX_DOMAIN } from "../../../src/data/pbx";

export const ONLINEPBX_API = "https://api2.onlinepbx.ru";
const LABEL = "OnlinePBX";

function base(creds: PbxCreds): string {
  const domain = (creds.domain ?? "").toLowerCase();
  if (!ONLINEPBX_DOMAIN.test(domain)) throw new ProviderError("OnlinePBX: домен АТС указан неверно (нужен вида company.onpbx.ru)");
  return `${ONLINEPBX_API}/${domain}`;
}

const form = (params: Record<string, string>) => new URLSearchParams(params).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };

async function login(creds: PbxCreds): Promise<string> {
  if (!creds.apiKey) throw new ProviderError("OnlinePBX: не задан ключ API");
  const r = await providerFetch(`${base(creds)}/auth.json`, { method: "POST", headers: FORM, body: form({ auth_key: creds.apiKey }) }, LABEL);
  const body = jsonObject(r, LABEL);
  const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : undefined;
  const keyId = str(data, "key_id");
  const key = str(data, "key");
  if (str(body, "status") !== "1" || !keyId || !key) throw new ProviderError(`OnlinePBX: вход по ключу API не удался${str(body, "comment") ? ` — ${str(body, "comment")!.slice(0, 120)}` : ""}`);
  return `${keyId}:${key}`;
}

/** Запрос с ключом сессии; сессия устарела (isNotAuth) — один раз входим заново. */
async function api(creds: PbxCreds, session: PbxSession, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    session.value ??= await login(creds);
    const r = await providerFetch(`${base(creds)}/${method}`, { method: "POST", headers: { ...FORM, "x-pbx-authentication": session.value }, body: form(params) }, LABEL);
    const body = jsonObject(r, LABEL);
    if (body.isNotAuth === true || body.isNotAuth === "true") {
      session.value = null;
      continue;
    }
    if (str(body, "status") !== "1") throw new ProviderError(`OnlinePBX: ${str(body, "comment")?.slice(0, 160) || str(body, "errorCode") || "отказ"}`);
    return body;
  }
  throw new ProviderError("OnlinePBX: ключ API не принят");
}

const DIRECTION: Record<string, "in" | "out"> = { inbound: "in", incoming: "in", outbound: "out", outgoing: "out" };

async function parseWebhook(input: WebhookInput, creds: PbxCreds): Promise<WebhookResult> {
  const f = flatFields(input.body, input.contentType);
  if (!f) return { ok: false, status: 400, why: "OnlinePBX прислала событие, которое не удалось прочитать" };
  const domain = field(f, "domain")?.toLowerCase();
  if (domain && creds.domain && domain !== creds.domain.toLowerCase()) return { ok: false, status: 403, why: "OnlinePBX: событие другой АТС (domain не совпал)" };
  const id = field(f, "uuid");
  const type = (field(f, "event") ?? "").toLowerCase().replace(/-/g, "_");
  const direction = DIRECTION[(field(f, "direction") ?? "").toLowerCase()];
  // Внутренние звонки сотрудников друг другу — не звонки клиентов.
  if (!id || !direction) return { ok: true, events: [], reply: textReply() };
  const caller = field(f, "caller");
  const callee = field(f, "callee");
  const staffSide = direction === "in" ? callee : caller;
  const common: Omit<CallEvent, "event"> = { externalId: id, direction, from: caller, to: callee, operator: isExtension(staffSide) ? staffSide : undefined };
  const ok = (events: CallEvent[], recording?: Extract<WebhookResult, { ok: true }>["recording"]): WebhookResult => ({ ok: true, events, recording, reply: textReply() });
  if (type === "call_start" || type === "call_user_start") return ok([{ ...common, event: "ringing", at: unixIso(field(f, "date")) }]);
  if (type === "call_answered") return ok([{ ...common, event: "answered" }]);
  if (type === "call_end" || type === "call_missed") {
    const talk = seconds(field(f, "dialog_duration")) ?? 0;
    const event: CallEvent = { ...common, event: talk > 0 ? "ended" : "missed", duration: talk };
    if (talk <= 0) return ok([event]);
    const link = field(f, "download_url");
    const ref = link && checkPublicUrl(link).ok ? ({ kind: "url", url: link } as const) : ({ kind: "id", id } as const);
    return ok([event], { externalId: id, ref });
  }
  return ok([]);
}

export const onlinepbx: PbxAdapter = {
  provider: "onlinepbx",
  parseWebhook,
  async dial(creds, session, extension, phone) {
    const body = await api(creds, session, "call/now.json", { from: extension, to: phone });
    const data = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : undefined;
    return { externalId: str(data, "uuid") };
  },
  async recordingUrl(creds, session, ref) {
    if (ref.kind === "url") return ref.url;
    const body = await api(creds, session, "mongo_history/search.json", { uuid: ref.id, download: "1" });
    if (typeof body.data !== "string" || !body.data) throw new ProviderError("OnlinePBX: запись разговора ещё не готова");
    return body.data;
  },
  async check(creds, session) {
    session.value = await login(creds);
    return "OnlinePBX отвечает, ключ API верный";
  },
};
