// Freedom Pay (бывш. PayBox), Казахстан. Документация: https://docs.freedompay.kz/ — создание платежа
// (https://docs.freedompay.kz/create-payment-11620859e0, init_payment), уведомление о результате на pg_result_url
// (https://docs.freedompay.kz/result-notify-12007677e0), правила подписи (https://freedompay.kz/docs-en/merchant-api/intro):
// pg_sig = md5(имя скрипта ; значения полей по алфавиту имён (с pg_salt) ; секретный ключ). Имя скрипта — часть адреса
// после последнего «/»: «init_payment.php» для запроса, последняя часть нашего адреса уведомления — для уведомления
// и ответа на него. Ответ на уведомление — XML с pg_status ok / rejected (если pg_can_reject=1) и своей подписью.
import { safeEqual, randomToken } from "../crypto";
import { md5Hex } from "../md5";
import { bodyFields, providerFetch, ProviderError } from "../providerHttp";
import { amountOf, type PayAdapter, type PayCreds, type PayReply } from "./types";

export const FREEDOM_API = "https://api.freedompay.kz";
const INIT_SCRIPT = "init_payment.php";
const LABEL = "Freedom Pay";

/** Подпись: имя скрипта, значения полей по алфавиту имён (без pg_sig), секретный ключ — через «;», md5. */
export function freedomSign(script: string, fields: Record<string, string>, secret: string): string {
  const values = Object.keys(fields)
    .filter((k) => k !== "pg_sig")
    .sort()
    .map((k) => fields[k]!);
  return md5Hex([script, ...values, secret].join(";"));
}

/** Плоский XML ответа Freedom Pay (<response><pg_status>ok</pg_status>…) → поля. */
export function xmlFields(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of xml.matchAll(/<(pg_[a-z_]+)>([\s\S]*?)<\/\1>/g)) {
    out[m[1]!] = m[2]!
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .trim();
  }
  return out;
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Имя «скрипта» адреса уведомления: последняя часть пути. */
export const scriptOf = (path: string): string => path.split("?")[0]!.split("/").filter(Boolean).pop() ?? "";

function secretOf(creds: PayCreds): string {
  if (!creds.merchantId || !creds.secretKey) throw new ProviderError("Freedom Pay: не заданы ID магазина и секретный ключ");
  return creds.secretKey;
}

function signedReply(script: string, secret: string, status: "ok" | "rejected", description: string): PayReply {
  const fields: Record<string, string> = { pg_status: status, pg_description: description, pg_salt: randomToken(12) };
  const sig = freedomSign(script, fields, secret);
  const body = `<?xml version="1.0" encoding="utf-8"?>\n<response><pg_status>${status}</pg_status><pg_description>${xmlEscape(description)}</pg_description><pg_salt>${fields.pg_salt}</pg_salt><pg_sig>${sig}</pg_sig></response>`;
  return { status: 200, body, contentType: "application/xml; charset=utf-8" };
}

export const freedompay: PayAdapter = {
  provider: "freedompay",
  async createPaymentLink(creds, input) {
    const secret = secretOf(creds);
    const fields: Record<string, string> = {
      pg_merchant_id: creds.merchantId!,
      pg_order_id: input.invoiceId,
      pg_amount: String(input.amount),
      pg_currency: "KZT",
      pg_description: input.description,
      pg_salt: randomToken(12),
      pg_result_url: input.resultUrl,
      pg_request_method: "POST",
      pg_lifetime: String(input.lifetimeSeconds),
      pg_language: "ru",
      pg_testing_mode: creds.testMode === "1" ? "1" : "0",
      ...(input.successUrl ? { pg_success_url: input.successUrl } : {}),
    };
    fields.pg_sig = freedomSign(INIT_SCRIPT, fields, secret);
    const r = await providerFetch(`${FREEDOM_API}/${INIT_SCRIPT}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }, LABEL);
    const res = xmlFields(r.text);
    if (res.pg_status !== "ok") throw new ProviderError(`Freedom Pay: ${res.pg_error_description?.slice(0, 160) || `счёт не создан (HTTP ${r.status})`}${res.pg_error_code ? ` (код ${res.pg_error_code})` : ""}`);
    // Ответ приходит по TLS с адреса Freedom Pay, зашитого в коде; деньги засчитываются только по подписанному уведомлению.
    const url = res.pg_redirect_url;
    if (!url || !/^https:\/\//.test(url)) throw new ProviderError("Freedom Pay: в ответе нет ссылки на оплату");
    return { url, externalId: res.pg_payment_id };
  },
  async verifyWebhook(creds, input) {
    const secret = secretOf(creds);
    const f = await bodyFields(input.body, input.contentType);
    if (!f) return { ok: false, status: 400, why: "Freedom Pay: уведомление не удалось прочитать" };
    const fields = Object.fromEntries(f);
    const script = scriptOf(input.path);
    if (!fields.pg_sig || !safeEqual(fields.pg_sig, freedomSign(script, fields, secret))) return { ok: false, status: 403, why: "Freedom Pay: неверная подпись уведомления (pg_sig)" };
    if (!fields.pg_order_id) return { ok: false, status: 400, why: "Freedom Pay: в уведомлении нет pg_order_id" };
    const result = fields.pg_result;
    const canReject = fields.pg_can_reject === "1";
    return {
      ok: true,
      notice: { invoiceId: fields.pg_order_id, externalId: fields.pg_payment_id, status: result === "1" ? "paid" : result === "0" ? "failed" : "pending", amount: amountOf(fields.pg_amount), currency: fields.pg_currency ?? "" },
      reply: (accepted) => (accepted || !canReject ? signedReply(script, secret, "ok", "Принято") : signedReply(script, secret, "rejected", "Счёт не может быть оплачен — свяжитесь с компанией")),
    };
  },
};
