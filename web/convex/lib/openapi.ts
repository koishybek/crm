// Описание публичного API в формате OpenAPI 3.1 (ТЗ п.20.7, п.26.7): GET /api/v1/openapi.json. Пишется руками —
// без генераторов и зависимостей; меняете эндпоинт в publicApi.ts — поправьте и здесь (тест сверяет пути и права).
import { API_SCOPE_LABEL, API_SCOPES } from "../../src/data/apiScopes";
import { LEAD_STATUS, ORDER_STATUS, SOURCE_IDS } from "../../src/data/catalog";
import { SIGNATURE_HEADER, WEBHOOK_EVENT_LABEL, WEBHOOK_EVENTS, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_TOLERANCE_SEC } from "../../src/data/webhookEvents";
import { UTM_KEYS, UTM_MAX } from "../../src/data/utm";

type Schema = Record<string, unknown>;

const str = (description?: string, extra: Schema = {}): Schema => ({ type: "string", ...(description ? { description } : {}), ...extra });
const int = (description?: string): Schema => ({ type: "integer", ...(description ? { description } : {}) });
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const error = (description: string): Schema => ({ description, content: { "application/json": { schema: ref("Error") } } });
const ok = (description: string, schema: Schema): Schema => ({ description, content: { "application/json": { schema } } });

/** Общие ответы-ошибки: ключ, права, лимит. */
const AUTH_ERRORS = {
  "401": error("Нет ключа, ключ неверный или отозван"),
  "403": error("У ключа нет нужного права (scope)"),
  "429": error("Больше 120 запросов в минуту на ключ — повторите через минуту (заголовок Retry-After)"),
};

const scopeNote = (scope: (typeof API_SCOPES)[number]) => `Право ключа: \`${scope}\` — ${API_SCOPE_LABEL[scope].label.toLowerCase()}.`;

const SIGNATURE_DOC = [
  `Каждое событие — POST с JSON { id, type, createdAt, data } на https-адрес подписки (порт 443).`,
  `Заголовок ${SIGNATURE_HEADER}: \`t=<unix-время>,v1=<hex HMAC-SHA256(секрет, "<t>.<тело запроса>")>\`.`,
  `Проверка: посчитайте HMAC от строки «t» + «.» + сырое тело, сравните с v1 за постоянное время и отвергайте t старше ${WEBHOOK_TOLERANCE_SEC} секунд — это защита от повтора.`,
  `id события (и заголовок X-HMS-Event-Id) одинаков во всех попытках — по нему отсекайте дубли.`,
  `Ответ 2xx — доставлено. Иначе до ${WEBHOOK_MAX_ATTEMPTS} попыток с удвоением паузы (1, 2, 4 … 64 минуты); перенаправления не выполняются.`,
].join("\n\n");

export function openApiDoc(base: string): Schema {
  const leadData: Schema = {
    type: "object",
    required: ["number", "status", "source", "serviceId", "city", "createdAt"],
    properties: {
      number: int(),
      status: str(undefined, { enum: Object.keys(LEAD_STATUS) }),
      previousStatus: str("Только в lead.status_changed", { enum: Object.keys(LEAD_STATUS) }),
      source: str(undefined, { enum: SOURCE_IDS }),
      origin: str("Кто завёл: operator, ai, bot, site, api, whatsapp, olx"),
      serviceId: str(),
      city: str(),
      createdAt: str(undefined, { format: "date-time" }),
      orderNumber: int(),
      utm: ref("Utm"),
      campaign: str(),
    },
  };
  const orderData: Schema = {
    type: "object",
    required: ["number", "status", "serviceId", "category", "city", "createdAt", "deadline"],
    properties: {
      number: int(),
      status: str(undefined, { enum: Object.keys(ORDER_STATUS) }),
      previousStatus: str("Только в order.status_changed", { enum: Object.keys(ORDER_STATUS) }),
      serviceId: str(),
      category: str(),
      city: str(),
      createdAt: str(undefined, { format: "date-time" }),
      deadline: str(undefined, { format: "date-time" }),
      doneAt: str(undefined, { format: "date-time" }),
      paidAt: str(undefined, { format: "date-time" }),
      closedAt: str(undefined, { format: "date-time" }),
      leadNumber: int(),
      utm: ref("Utm"),
      campaign: str(),
    },
  };
  const reviewData: Schema = {
    type: "object",
    required: ["orderNumber", "rating", "via", "createdAt"],
    properties: { orderNumber: int(), rating: int("1–5"), via: str(), hasComment: { type: "boolean" }, createdAt: str(undefined, { format: "date-time" }) },
  };
  const dataOf = (e: string): Schema => (e.startsWith("lead.") ? leadData : e.startsWith("order.") ? orderData : reviewData);
  const event = (e: string): Schema => ({
    type: "object",
    required: ["id", "type", "createdAt", "data"],
    properties: { id: str("Id события — одинаков во всех попытках доставки"), type: str(undefined, { const: e }), createdAt: str(undefined, { format: "date-time" }), data: dataOf(e) },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "Home Max Service API",
      version: "1.0.0",
      description:
        "Заявки, статусы заказов и справочник услуг для сайта, рекламных сервисов и партнёров. Ключ — в «Настройках → API и сайт», заголовок `Authorization: Bearer hms_…`. " +
        "Ответы и ошибки — JSON, ошибки — `{ \"error\": \"…\" }`. Персональных данных клиентов и денег API не отдаёт.",
    },
    servers: [{ url: base }],
    security: [{ bearer: [] }],
    paths: {
      "/api/v1/leads": {
        post: {
          summary: "Создать заявку",
          description: `${scopeNote("leads:write")} Повтор с тем же externalId (или заголовком Idempotency-Key) не создаёт дубль — вернётся 200 и тот же номер.`,
          parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: str(undefined, { maxLength: 100 }) }],
          requestBody: { required: true, content: { "application/json": { schema: ref("NewLead") } } },
          responses: {
            "201": ok("Заявка создана", ref("Created")),
            "200": ok("Повтор: заявка уже создана этим ключом", ref("Created")),
            "400": error("Ошибка в полях"),
            ...AUTH_ERRORS,
          },
        },
      },
      "/api/v1/leads/{number}": {
        get: {
          summary: "Статус заявки",
          description: `${scopeNote("leads:read")} Только заявки, созданные этим ключом.`,
          parameters: [{ name: "number", in: "path", required: true, schema: int() }],
          responses: { "200": ok("Статус", ref("LeadStatus")), "404": error("Заявка не найдена"), ...AUTH_ERRORS },
        },
      },
      "/api/v1/orders/{number}": {
        get: {
          summary: "Статус заказа",
          description: `${scopeNote("orders:read")} Без клиента, адреса, описания и денег.`,
          parameters: [{ name: "number", in: "path", required: true, schema: int() }],
          responses: { "200": ok("Статус и даты", ref("OrderStatus")), "404": error("Заказ не найден"), ...AUTH_ERRORS },
        },
      },
      "/api/v1/services": {
        get: {
          summary: "Справочник направлений и услуг",
          description: `${scopeNote("services:read")} Вилка цен (priceMin, priceMax) — только если владелец включил «Цены в API».`,
          responses: { "200": ok("Справочник", ref("Services")), ...AUTH_ERRORS },
        },
      },
      "/api/v1/openapi.json": {
        get: { summary: "Это описание", security: [], responses: { "200": { description: "OpenAPI 3.1", content: { "application/json": {} } } } },
      },
    },
    webhooks: Object.fromEntries(
      WEBHOOK_EVENTS.map((e) => [
        e,
        {
          post: {
            summary: WEBHOOK_EVENT_LABEL[e],
            description: SIGNATURE_DOC,
            parameters: [
              { name: SIGNATURE_HEADER, in: "header", required: true, schema: str("t=<unix>,v1=<hex>") },
              { name: "X-HMS-Event", in: "header", required: true, schema: str(undefined, { const: e }) },
              { name: "X-HMS-Event-Id", in: "header", required: true, schema: str() },
              { name: "X-HMS-Delivery", in: "header", required: true, schema: str() },
              { name: "X-HMS-Attempt", in: "header", required: true, schema: int() },
            ],
            requestBody: { content: { "application/json": { schema: event(e) } } },
            responses: { "200": { description: "Принято — любой ответ 2xx" } },
          },
        },
      ]),
    ),
    components: {
      securitySchemes: { bearer: { type: "http", scheme: "bearer", description: `Ключ API «hms_…». Права: ${API_SCOPES.join(", ")}` } },
      schemas: {
        Error: { type: "object", required: ["error"], properties: { error: str("Текст ошибки по-русски") } },
        Utm: { type: "object", properties: Object.fromEntries(UTM_KEYS.map((k) => [k, str(`utm_${k}`, { maxLength: UTM_MAX })])) },
        NewLead: {
          type: "object",
          required: ["name", "phone", "description"],
          properties: {
            name: str(undefined, { maxLength: 80 }),
            phone: str("Казахстанский номер, например +77011234567", { maxLength: 32 }),
            description: str(undefined, { maxLength: 2000 }),
            serviceId: str("Услуга из /api/v1/services; нет — «уточнить»", { maxLength: 80 }),
            city: str(undefined, { maxLength: 60 }),
            source: str("По умолчанию site", { enum: SOURCE_IDS }),
            externalId: str("Ключ идемпотентности", { maxLength: 100 }),
            utm: ref("Utm"),
            campaign: str("Кампания; нет — берётся utm.campaign", { maxLength: UTM_MAX }),
          },
        },
        Created: { type: "object", required: ["number", "id"], properties: { number: int(), id: str() } },
        LeadStatus: {
          type: "object",
          required: ["number", "status", "statusLabel", "createdAt"],
          properties: {
            number: int(),
            status: str(undefined, { enum: Object.keys(LEAD_STATUS) }),
            statusLabel: str(),
            createdAt: str(undefined, { format: "date-time" }),
            orderNumber: int(),
            orderStatus: str(undefined, { enum: Object.keys(ORDER_STATUS) }),
            orderStatusLabel: str(),
          },
        },
        OrderStatus: {
          type: "object",
          required: ["number", "status", "statusLabel", "serviceId", "service", "category", "city", "createdAt", "deadline"],
          properties: {
            number: int(),
            status: str(undefined, { enum: Object.keys(ORDER_STATUS) }),
            statusLabel: str(),
            serviceId: str(),
            service: str(),
            category: str(),
            city: str(),
            createdAt: str(undefined, { format: "date-time" }),
            deadline: str(undefined, { format: "date-time" }),
            doneAt: str(undefined, { format: "date-time" }),
            paidAt: str(undefined, { format: "date-time" }),
            closedAt: str(undefined, { format: "date-time" }),
          },
        },
        Services: {
          type: "object",
          required: ["categories", "services"],
          properties: {
            categories: { type: "array", items: { type: "object", required: ["id", "label"], properties: { id: str(), label: str() } } },
            services: {
              type: "array",
              items: { type: "object", required: ["id", "label", "category"], properties: { id: str(), label: str(), category: str(), priceMin: int("₸"), priceMax: int("₸") } },
            },
          },
        },
      },
    },
  };
}
