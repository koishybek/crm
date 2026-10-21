// Kcell «Виртуальная АТС» (vats.kcell.kz). Документация API: https://api.vpbx.kcell.kz/#/docs/crmapi/v1/general
// (руководство — https://manual.kcell.kz/rest_api). Тот же протокол «REST API для CRM», что у облачных АТС Beeline.
// АТС → нам: POST form-urlencoded на адрес CRM из личного кабинета ВАТС, в теле — cmd и crm_token (ключ CRM, который
// владелец задаёт там же): event (INCOMING, ACCEPTED, COMPLETED, CANCELLED, OUTGOING, TRANSFERRED), history — итог
// звонка со статусом, длительностью и ссылкой на запись (link), contact — имя клиента по номеру, rating — оценка.
// Отвечаем JSON. Мы → АТС: https://{адрес ВАТС}/crmapi/v1/{метод} с заголовком X-API-KEY (ключ из настроек интеграции):
// makecall (phone, user — короткий номер сотрудника), users — для проверки ключа.
import { safeEqual } from "../crypto";
import { checkPublicUrl } from "../safeFetch";
import { field, flatFields, jsonObject, providerFetch, ProviderError, str } from "../providerHttp";
import { isExtension, jsonReply, seconds, type CallEvent, type PbxAdapter, type PbxCreds, type WebhookInput, type WebhookResult } from "./types";
import { cleanPbxDomain, KCELL_DOMAIN } from "../../../src/data/pbx";

const LABEL = "Kcell ВАТС";

function base(creds: PbxCreds): string {
  const domain = cleanPbxDomain(creds.domain ?? "");
  if (!KCELL_DOMAIN.test(domain)) throw new ProviderError("Kcell ВАТС: адрес АТС указан неверно (нужен вида company.vpbx.kcell.kz)");
  return `https://${domain}/crmapi/v1`;
}

async function api(creds: PbxCreds, method: "GET" | "POST", path: string, body?: Record<string, string>): Promise<Record<string, unknown> | null> {
  if (!creds.apiKey) throw new ProviderError("Kcell ВАТС: не задан ключ для авторизации в АТС");
  const r = await providerFetch(`${base(creds)}/${path}`, { method, headers: { "X-API-KEY": creds.apiKey, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }, LABEL);
  if (r.status === 401 || r.status === 403) throw new ProviderError("Kcell ВАТС: ключ не принят — проверьте «Ключ для авторизации в АТС» и что интеграция с CRM включена");
  if (r.status >= 400) throw new ProviderError(`Kcell ВАТС: отказ (HTTP ${r.status})${r.text ? ` — ${r.text.slice(0, 120)}` : ""}`);
  return r.text.trim().startsWith("{") ? jsonObject(r, LABEL) : null;
}

/** «20170703T121110Z» → ISO. */
function startIso(raw: string | undefined): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : undefined;
}

async function parseWebhook(input: WebhookInput, creds: PbxCreds): Promise<WebhookResult> {
  const f = flatFields(input.body, input.contentType);
  if (!f) return { ok: false, status: 400, why: "Kcell ВАТС прислала событие, которое не удалось прочитать" };
  if (!creds.crmToken) return { ok: false, status: 503, why: "Kcell ВАТС: не задан ключ CRM — проверять события нечем" };
  if (!safeEqual(field(f, "crm_token") ?? "", creds.crmToken)) return { ok: false, status: 403, why: "Kcell ВАТС: неверный ключ CRM (crm_token)" };
  const ok = (events: CallEvent[], recording?: Extract<WebhookResult, { ok: true }>["recording"]): WebhookResult => ({ ok: true, events, recording, reply: jsonReply({}) });
  const cmd = field(f, "cmd");
  const id = field(f, "callid");
  const ext = field(f, "ext");
  const operator = isExtension(ext) ? ext : undefined;
  // Клиент — phone, номер компании — diversion: входящий — от клиента к нам, исходящий — наоборот.
  const sides = (direction: "in" | "out") => (direction === "in" ? { from: field(f, "phone"), to: field(f, "diversion") } : { from: field(f, "diversion"), to: field(f, "phone") });
  if (cmd === "event" && id) {
    const direction = field(f, "direction") === "out" ? "out" : "in";
    const common = { externalId: id, direction, ...sides(direction), operator } as const;
    switch (field(f, "type")) {
      case "INCOMING":
      case "OUTGOING":
        return ok([{ ...common, event: "ringing" }]);
      case "ACCEPTED":
        return ok([{ ...common, event: "answered" }]);
      case "CANCELLED":
        return ok([{ ...common, event: "missed", duration: 0 }]);
      default:
        // COMPLETED — итог с длительностью и записью придёт командой history; TRANSFERRED — тот же звонок.
        return ok([]);
    }
  }
  if (cmd === "history" && id) {
    const direction = field(f, "type") === "out" ? "out" : "in";
    const talked = field(f, "status") === "Success";
    const duration = talked ? (seconds(field(f, "duration")) ?? 0) : 0;
    const event: CallEvent = { externalId: id, direction, ...sides(direction), operator, event: talked ? "ended" : "missed", duration, at: startIso(field(f, "start")) };
    const link = field(f, "link");
    if (!talked || !link || !checkPublicUrl(link).ok) return ok([event]);
    return ok([event], { externalId: id, ref: { kind: "url", url: link } });
  }
  // contact (имя клиента по номеру) — пустой ответ: АТС покажет номер; rating, webhook — подтверждаем.
  return ok([]);
}

export const kcell: PbxAdapter = {
  provider: "kcell",
  parseWebhook,
  async dial(creds, _session, extension, phone) {
    // АТС сначала звонит сотруднику (user — короткий номер), затем соединяет с клиентом.
    const body = await api(creds, "POST", "makecall", { phone, user: extension });
    return { externalId: str(body ?? undefined, "callid") };
  },
  async recordingUrl(_creds, _session, ref) {
    if (ref.kind === "url") return ref.url;
    throw new ProviderError("Kcell ВАТС: ссылки на запись нет — включите запись звонков в АТС");
  },
  async check(creds) {
    await api(creds, "GET", "users?limit=1");
    return "Kcell ВАТС отвечает, ключ верный";
  },
};
