// CloudPayments. Документация: https://developers.cloudpayments.ru/ — «Создание счета для отправки по почте»
// (POST /orders/create: Amount, Currency, Description, InvoiceId…; ответ Model.Url — ссылка на оплату), авторизация HTTP Basic
// (Public ID : пароль для API), «Уведомления» Pay и Fail (POST, поля TransactionId, Amount, Currency, InvoiceId, Status,
// OperationType…) и «Проверка уведомлений»: заголовок Content-HMAC = base64(HMAC-SHA256(тело запроса, пароль для API)).
// Ответ на уведомление — {"code":0}.
import { safeEqual } from "../crypto";
import { hmacBase64 } from "../hmac";
import { bodyFields, jsonObject, providerFetch, ProviderError, str } from "../providerHttp";
import { amountOf, type PayAdapter, type PayCreds } from "./types";
import { CLOUDPAYMENTS_HOSTS } from "../../../src/data/payIntents";

const LABEL = "CloudPayments";

function hostOf(creds: PayCreds): string {
  const host = creds.apiHost || CLOUDPAYMENTS_HOSTS[0];
  if (!(CLOUDPAYMENTS_HOSTS as readonly string[]).includes(host)) throw new ProviderError("CloudPayments: неизвестный адрес API");
  return host;
}

export const cloudpayments: PayAdapter = {
  provider: "cloudpayments",
  async createPaymentLink(creds, input) {
    if (!creds.publicId || !creds.apiSecret) throw new ProviderError("CloudPayments: не заданы Public ID и пароль для API");
    const body = {
      Amount: input.amount,
      Currency: "KZT",
      Description: input.description,
      InvoiceId: input.invoiceId,
      RequireConfirmation: false,
      SendEmail: false,
      CultureName: "ru-RU",
      ...(input.successUrl ? { SuccessRedirectUrl: input.successUrl } : {}),
    };
    const r = await providerFetch(`${hostOf(creds)}/orders/create`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Basic ${btoa(`${creds.publicId}:${creds.apiSecret}`)}` }, body: JSON.stringify(body) }, LABEL);
    if (r.status === 401) throw new ProviderError("CloudPayments: Public ID или пароль для API не подошли");
    const res = jsonObject(r, LABEL);
    const model = res.Model && typeof res.Model === "object" ? (res.Model as Record<string, unknown>) : undefined;
    const url = str(model, "Url");
    if (res.Success !== true || !url) throw new ProviderError(`CloudPayments: ${str(res, "Message")?.slice(0, 160) || "счёт не создан"}`);
    if (!/^https:\/\//.test(url)) throw new ProviderError("CloudPayments: в ответе нет ссылки на оплату");
    return { url, externalId: str(model, "Id") };
  },
  async verifyWebhook(creds, input) {
    if (!creds.apiSecret) return { ok: false, status: 503, why: "CloudPayments: не задан пароль для API — подпись проверить нечем" };
    const given = input.headers.get("content-hmac") ?? "";
    const expected = await hmacBase64("SHA-256", creds.apiSecret, input.body);
    if (!given || !safeEqual(given, expected)) return { ok: false, status: 403, why: "CloudPayments: неверная подпись уведомления (Content-HMAC)" };
    const f = await bodyFields(input.body, input.contentType);
    if (!f) return { ok: false, status: 400, why: "CloudPayments: уведомление не удалось прочитать" };
    const invoiceId = f.get("InvoiceId");
    if (!invoiceId) return { ok: false, status: 400, why: "CloudPayments: в уведомлении нет InvoiceId" };
    const status = f.get("Status") ?? "";
    const operation = f.get("OperationType") ?? "Payment";
    return {
      ok: true,
      notice: {
        invoiceId,
        externalId: f.get("TransactionId"),
        status: operation !== "Payment" ? "pending" : status === "Completed" ? "paid" : status === "Declined" ? "failed" : "pending",
        amount: amountOf(f.get("Amount")),
        currency: f.get("Currency") ?? "",
      },
      reply: () => ({ status: 200, body: JSON.stringify({ code: 0 }), contentType: "application/json" }),
    };
  },
};
