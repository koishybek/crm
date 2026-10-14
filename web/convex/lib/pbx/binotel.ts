// Binotel (Украина, Казахстан). Документация: https://developers.binotel.ua/ (API 4.0); поля событий сверены
// с описанием вебхука «Звонок завершён» у интеграторов (https://apimonster.ru/connector/trigger/binotel/event/apiCallCompleted/)
// и методами API (https://github.com/toxageek/binotel-laravel — calls/internal-number-to-external-number, stats/call-record).
// API: POST https://api.binotel.com/api/4.0/<модуль>/<метод>.json, JSON-тело с key и secret.
// События: requestType=apiCallSettings (звонок поступил), receivedTheCall / answeredTheCall (PUSH: звонит сотруднику,
// ответил), apiCallCompleted (звонок завершён, поля callDetails[...]) — form-urlencoded.
// Подписи у событий Binotel нет: принимаем только по ключу АТС в адресе (?key=, проверяет http.ts) и, если владелец
// указал номер компании, — только события этой компании (companyID).
import { safeEqual } from "../crypto";
import { field, flatFields, jsonObject, providerFetch, ProviderError, str } from "../providerHttp";
import { isExtension, jsonReply, seconds, unixIso, type CallEvent, type PbxAdapter, type PbxCreds, type WebhookInput, type WebhookResult } from "./types";

export const BINOTEL_API = "https://api.binotel.com/api/4.0/";
const LABEL = "Binotel";

async function api(creds: PbxCreds, method: string, params: Record<string, string | number | boolean>): Promise<Record<string, unknown>> {
  if (!creds.key || !creds.secret) throw new ProviderError("Binotel: не заданы key и secret");
  const r = await providerFetch(`${BINOTEL_API}${method}.json`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...params, key: creds.key, secret: creds.secret }) }, LABEL);
  const body = jsonObject(r, LABEL);
  if (str(body, "status") !== "success") {
    const code = str(body, "code");
    throw new ProviderError(`Binotel: ${str(body, "message")?.slice(0, 160) || "отказ"}${code ? ` (код ${code})` : ""}`);
  }
  return body;
}

/** Номер в событии: внешний (клиент) и номер компании; направление — callType 0 входящий, 1 исходящий. */
function parties(direction: "in" | "out", external: string | undefined, pbx: string | undefined): Pick<CallEvent, "from" | "to"> {
  return direction === "in" ? { from: external, to: pbx } : { from: pbx, to: external };
}

async function parseWebhook(input: WebhookInput, creds: PbxCreds): Promise<WebhookResult> {
  const f = flatFields(input.body, input.contentType);
  if (!f) return { ok: false, status: 400, why: "Binotel прислал событие, которое не удалось прочитать" };
  const type = field(f, "requestType");
  const company = field(f, "companyID", "callDetails[companyID]");
  if (creds.companyId && (!company || !safeEqual(company, creds.companyId))) return { ok: false, status: 403, why: "Binotel: событие другой компании (companyID не совпал)" };
  const reply = jsonReply({ status: "success" });
  if (type === "apiCallCompleted") {
    const d = (k: string) => field(f, `callDetails[${k}]`);
    const id = d("generalCallID");
    if (!id) return { ok: false, status: 400, why: "Binotel: в событии нет generalCallID" };
    const direction = d("callType") === "1" ? "out" : "in";
    const billsec = seconds(d("billsec")) ?? 0;
    const answered = d("disposition")?.toUpperCase() === "ANSWER" && billsec > 0;
    const internal = d("internalNumber");
    const event: CallEvent = {
      event: answered ? "ended" : "missed",
      externalId: id,
      direction,
      ...parties(direction, d("externalNumber"), field(f, "callDetails[pbxNumberData][number]")),
      operator: field(f, "callDetails[employeeData][email]") ?? (isExtension(internal) ? internal : undefined),
      duration: billsec,
    };
    // Запись есть только у состоявшегося разговора; ссылку выдаёт stats/call-record.
    return { ok: true, events: [event], recording: answered ? { externalId: id, ref: { kind: "id", id } } : undefined, reply };
  }
  if (type === "apiCallSettings" || type === "receivedTheCall" || type === "answeredTheCall") {
    const id = field(f, "generalCallID");
    if (!id) return { ok: false, status: 400, why: "Binotel: в событии нет generalCallID" };
    const direction = field(f, "callType") === "1" ? "out" : "in";
    const internal = field(f, "internalNumber");
    return {
      ok: true,
      events: [
        {
          event: type === "answeredTheCall" ? "answered" : "ringing",
          externalId: id,
          direction,
          ...parties(direction, field(f, "externalNumber"), field(f, "didNumber", "pbxNumber")),
          operator: isExtension(internal) ? internal : undefined,
          at: unixIso(field(f, "startTime")),
        },
      ],
      reply,
    };
  }
  // Другие типы (настройки, служебные) — подтверждаем, чтобы Binotel не повторял, но не разбираем.
  return { ok: true, events: [], reply };
}

export const binotel: PbxAdapter = {
  provider: "binotel",
  parseWebhook,
  async dial(creds, _session, extension, phone) {
    const body = await api(creds, "calls/internal-number-to-external-number", { internalNumber: extension, externalNumber: phone });
    return { externalId: str(body, "generalCallID") };
  },
  async recordingUrl(creds, _session, ref) {
    if (ref.kind === "url") return ref.url;
    const body = await api(creds, "stats/call-record", { generalCallID: ref.id });
    const url = str(body, "url");
    if (!url) throw new ProviderError("Binotel: запись разговора ещё не готова");
    return url;
  },
  async check(creds) {
    await api(creds, "stats/online-calls", {});
    return "Binotel отвечает, ключи верные";
  },
};
