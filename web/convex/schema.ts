import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { PERMISSIONS } from "../src/data/permissions";
import { MODULES } from "../src/data/plans";

// Даты — ISO-строки в UTC: сортируются как строки и совпадают с типами фронта (src/data/types.ts).

export const role = v.union(v.literal("owner"), v.literal("operator"), v.literal("manager"), v.literal("executor"));
export const permission = v.union(...PERMISSIONS.map((p) => v.literal(p)));
export const source = v.union(
  v.literal("olx"),
  v.literal("phone"),
  v.literal("whatsapp"),
  v.literal("telegram"),
  v.literal("site"),
  v.literal("instagram"),
  v.literal("referral"),
);
/** Ключ направления — из справочника (таблица categories). */
export const category = v.string();
export const urgency = v.union(v.literal("normal"), v.literal("high"), v.literal("urgent"));
/** Кто завёл заявку: оператор или канал (AI по звонку, Telegram-бот, сайт, API, WhatsApp, OLX) — см. src/data/leadRules.ts. */
export const leadOrigin = v.union(v.literal("operator"), v.literal("ai"), v.literal("bot"), v.literal("site"), v.literal("api"), v.literal("whatsapp"), v.literal("olx"));
export const leadStatus = v.union(v.literal("new"), v.literal("qualifying"), v.literal("waiting"), v.literal("converted"), v.literal("rejected"));
export const orderStatus = v.union(
  v.literal("new"),
  v.literal("awaiting_executor"),
  v.literal("assigned"),
  v.literal("accepted"),
  v.literal("in_progress"),
  v.literal("awaiting_client"),
  v.literal("done"),
  v.literal("awaiting_payment"),
  v.literal("paid"),
  v.literal("closed"),
  v.literal("cancelled"),
  v.literal("refund"),
);
export const paymentMethod = v.union(v.literal("kaspi"), v.literal("cash"), v.literal("card"), v.literal("transfer"));
/**
 * Оплата клиента. at — дата оплаты (можно задним числом), by — кто внёс. Ошибочный платёж не удаляется,
 * а сторнируется владельцем (voidedAt/voidedBy/voidReason) и больше не входит в оплаченную сумму.
 */
export const payment = v.object({
  id: v.string(),
  amount: v.number(),
  method: paymentMethod,
  at: v.string(),
  by: v.optional(v.id("users")),
  note: v.optional(v.string()),
  voidedAt: v.optional(v.string()),
  voidedBy: v.optional(v.id("users")),
  voidReason: v.optional(v.string()),
});
/** Возврат клиенту — запись с суммой, способом, датой и причиной (оформляет владелец). */
export const refund = v.object({ id: v.string(), amount: v.number(), method: paymentMethod, at: v.string(), reason: v.string(), by: v.id("users") });
export const actor = v.union(
  v.object({ type: v.literal("user"), id: v.string() }),
  v.object({ type: v.literal("client"), id: v.string() }),
  v.object({ type: v.literal("system") }),
);
export const attachment = v.object({
  id: v.string(),
  name: v.string(),
  kind: v.union(v.literal("image"), v.literal("file")),
  storageId: v.optional(v.id("_storage")),
  /** Файл заказа виден мастеру (ТЗ п.16, аудит M-6): из переписки с мастером и его фотоотчёт — сразу, остальное — по «Показать мастеру». */
  forExecutor: v.optional(v.boolean()),
});
/**
 * Аудитория сообщения заказа: internal — только сотрудники, client — переписка по клиенту (мастеру не видна),
 * executor — команда ↔ назначенный мастер (единственный канал, который видит и куда пишет мастер).
 */
export const messageChannel = v.union(v.literal("internal"), v.literal("client"), v.literal("executor"));
export const historyKind = v.union(
  v.literal("created"),
  v.literal("status"),
  v.literal("assigned"),
  v.literal("taken"),
  v.literal("comment"),
  v.literal("file"),
  v.literal("finance"),
  v.literal("payment"),
  v.literal("edited"),
  v.literal("published"),
);
export const tone = v.union(v.literal("info"), v.literal("ok"), v.literal("warn"), v.literal("bad"));
/** Каналы переписки с клиентами (единый чат «Сообщения»). */
export const channel = v.union(v.literal("telegram"), v.literal("whatsapp"), v.literal("olx"), v.literal("site"));
/** Тип сообщения в диалоге; system — автоответы бота и служебные отметки. */
export const messageKind = v.union(v.literal("text"), v.literal("image"), v.literal("audio"), v.literal("file"), v.literal("location"), v.literal("system"));
/** Сущности журнала действий; действие пишется как «сущность.что» — «order.status», «user.access». */
export const auditEntity = v.union(
  v.literal("lead"),
  v.literal("order"),
  v.literal("client"),
  v.literal("executor"),
  v.literal("user"),
  v.literal("catalog"),
  v.literal("settings"),
  v.literal("integration"),
  v.literal("call"),
  v.literal("conversation"),
  v.literal("review"),
  v.literal("system"),
  v.literal("export"),
);
/** Рекламные метки обращения (ТЗ п.6.6, п.28.5): utm_* со страницы формы или из API. */
export const utm = v.object({
  source: v.optional(v.string()),
  medium: v.optional(v.string()),
  campaign: v.optional(v.string()),
  content: v.optional(v.string()),
  term: v.optional(v.string()),
});
/** События исходящих вебхуков (convex/webhooks.ts); webhook.test — «Отправить тестовое событие». */
export const webhookEvent = v.union(
  v.literal("lead.created"),
  v.literal("lead.status_changed"),
  v.literal("order.created"),
  v.literal("order.status_changed"),
  v.literal("order.paid"),
  v.literal("review.created"),
  v.literal("webhook.test"),
);
export const aiSummary = v.object({
  summary: v.string(),
  extracted: v.array(v.object({ label: v.string(), value: v.string() })),
  questions: v.array(v.string()),
});
/** Черновик заявки от AI (звонок, переписка, бот): поля формы. when и budget — только для сотрудников. */
export const aiDraft = v.object({
  serviceId: v.optional(v.string()),
  city: v.optional(v.string()),
  address: v.optional(v.string()),
  urgency: v.optional(urgency),
  clientName: v.optional(v.string()),
  description: v.optional(v.string()),
  when: v.optional(v.string()),
  budget: v.optional(v.number()),
  district: v.optional(v.string()),
});
/** Условия выплаты: сумма или процент от цены клиента. */
export const payoutTerms = v.object({ payoutMode: v.union(v.literal("fixed"), v.literal("percent")), payoutValue: v.number() });
const rateOverride = v.object({ percent: v.optional(v.number()), fixed: v.optional(v.number()) });
/** Ставки исполнителя (ТЗ п.14.5): service — ставка услуги, percent — свой процент, fixed — своя сумма; perService — по услугам. */
export const executorRates = v.object({
  mode: v.union(v.literal("service"), v.literal("percent"), v.literal("fixed")),
  percent: v.optional(v.number()),
  fixed: v.optional(v.number()),
  perService: v.optional(v.record(v.string(), rateOverride)),
});
/** История мастера за 90 дней (ТЗ п.12.6) — кеш для подбора, считает convex/executorStats.ts. */
export const executorStats90 = v.object({
  done: v.number(),
  onTime: v.number(),
  cancelled: v.number(),
  refusals: v.number(),
  avgHours: v.optional(v.number()),
  updatedAt: v.string(),
});

/** Ячейка предрасчёта аналитики (src/data/dailyStats.ts → Cell): разрез и счётчики — итоги, по мастерам, по операторам. */
const statCounts = v.record(v.string(), v.number());
export const statCell = {
  category: v.string(),
  source,
  city: v.string(),
  t: statCounts,
  ex: v.array(v.object({ id: v.string(), c: statCounts })),
  op: v.array(v.object({ id: v.string(), c: statCounts, waits: v.array(v.number()) })),
};

/** Тарифы и модули компании (src/data/plans.ts). */
export const plan = v.union(v.literal("free"), v.literal("standard"), v.literal("pro"));
export const tenantModule = v.union(...MODULES.map((m) => v.literal(m)));
/** Комиссия платформы (ТЗ §24.2): процент от цены клиента или фиксированная сумма с выполненного заказа. */
export const platformFee = v.object({ mode: v.union(v.literal("percent"), v.literal("fixed")), value: v.number() });

/** Провайдеры онлайн-оплаты (ТЗ п.19.7): Freedom Pay и CloudPayments — по API, Kaspi — ссылка магазина без уведомлений. */
export const payProvider = v.union(v.literal("freedompay"), v.literal("cloudpayments"), v.literal("kaspi"));
/** Статусы счёта на оплату — переходы в src/data/payIntents.ts. */
export const payIntentStatus = v.union(v.literal("created"), v.literal("paid"), v.literal("failed"), v.literal("cancelled"), v.literal("review"));
/** Виды документов по заказу (ТЗ п.19.9). */
export const documentKind = v.union(v.literal("invoice"), v.literal("act"));
const docParty = v.object({
  name: v.string(),
  bin: v.optional(v.string()),
  address: v.optional(v.string()),
  bank: v.optional(v.string()),
  iik: v.optional(v.string()),
  bik: v.optional(v.string()),
  kbe: v.optional(v.string()),
  director: v.optional(v.string()),
  phone: v.optional(v.string()),
});
/** Снимок документа: печатается ровно так, как выпущен. */
export const documentData = v.object({
  seller: docParty,
  buyer: docParty,
  orderNumber: v.number(),
  lines: v.array(v.object({ name: v.string(), qty: v.number(), unit: v.string(), price: v.number(), sum: v.number() })),
  total: v.number(),
  totalWords: v.string(),
  /** Оплачено на момент выпуска: в счёте «к оплате» = total − paid. */
  paid: v.number(),
  vatNote: v.string(),
  basis: v.optional(v.string()),
});

export default defineSchema({
  ...authTables,

  /**
   * Компании платформы (ТЗ §2.5, §24): slug — неизменный id компании, он же tenantId во всех таблицах.
   * Тариф и модули задаёт администратор платформы; комиссия платформы — с каждого выполненного заказа (§24.2).
   */
  tenants: defineTable({
    slug: v.string(),
    name: v.string(),
    plan,
    modules: v.array(tenantModule),
    status: v.union(v.literal("active"), v.literal("suspended")),
    createdAt: v.string(),
    ownerUserId: v.optional(v.id("users")),
    platformFee: v.optional(platformFee),
    city: v.optional(v.string()),
    /** Перенос данных до SaaS в компанию закончен (convex/tenants.ts migrate) — документы без tenantId больше не ожидаются. */
    migratedAt: v.optional(v.string()),
    /** Владелец скрыл список «С чего начать». */
    onboardingDoneAt: v.optional(v.string()),
  }).index("by_slug", ["slug"]),

  /** Сотрудники и исполнители. email — логин (email или телефон цифрами), пароль хранит Convex Auth. */
  users: defineTable({
    name: v.optional(v.string()),
    image: v.optional(v.string()),
    email: v.optional(v.string()),
    emailVerificationTime: v.optional(v.number()),
    phone: v.optional(v.string()),
    phoneVerificationTime: v.optional(v.number()),
    isAnonymous: v.optional(v.boolean()),
    tenantId: v.optional(v.string()),
    role: v.optional(role),
    executorId: v.optional(v.id("executors")),
    /** Направления руководителя (role = manager): видит только их. */
    categories: v.optional(v.array(v.string())),
    active: v.optional(v.boolean()),
    telegramChatId: v.optional(v.string()),
    telegramLinkCode: v.optional(v.string()),
    /** До какого момента (мс) действует ссылка привязки Telegram — одноразовая, 30 минут (аудит M-9). */
    telegramLinkExpiresAt: v.optional(v.number()),
    /** Дублировать важные уведомления на email (ТЗ п.18). */
    notifyEmail: v.optional(v.boolean()),
    /** Временный пароль (выдан владельцем или оператором): до смены пароля — только экран «Смените пароль» (аудит M-8). */
    mustChangePassword: v.optional(v.boolean()),
    /** Права сотрудника, заданные владельцем (ТЗ п.5.12); нет — умолчания роли (src/data/permissions.ts). */
    permissions: v.optional(v.array(permission)),
    /** Внутренний номер в облачной АТС (ТЗ п.19.1): звонок из карточки и оператор входящего по событию АТС. */
    pbxExtension: v.optional(v.string()),
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_role", ["role"])
    .index("by_executor", ["executorId"])
    .index("by_telegram_code", ["telegramLinkCode"])
    .index("by_telegram_chat", ["telegramChatId"])
    .index("by_pbx_extension", ["pbxExtension"]),

  executors: defineTable({
    tenantId: v.string(),
    name: v.string(),
    phone: v.string(),
    city: v.string(),
    categories: v.array(category),
    skills: v.array(v.string()),
    available: v.boolean(),
    rating: v.number(),
    reviews: v.number(),
    cooperation: v.union(v.literal("freelance"), v.literal("staff")),
    joinedAt: v.string(),
    /** Недоступен до (ТЗ п.14): пока задано, available = false; в этот момент мастер сам возвращается на смену. */
    unavailableUntil: v.optional(v.string()),
    unavailableReason: v.optional(v.string()),
    /** Заказов в работе одновременно; не задано — DEFAULT_MAX_ACTIVE (src/data/logic.ts). Меняет владелец. */
    maxActiveOrders: v.optional(v.number()),
    /** Районы города, где мастер берёт заказы (ТЗ п.12.3); пусто — весь город. */
    districts: v.optional(v.array(v.string())),
    /** Ставки мастера (ТЗ п.14.5); нет — ставка услуги. Меняет владелец. */
    rates: v.optional(executorRates),
    /** История за 90 дней — кеш для подбора (ТЗ п.12.6). */
    stats90: v.optional(executorStats90),
    /** Когда мастер отказывался от заказа или не подтвердил назначение — за последние 90 дней, для stats90. */
    refusals: v.optional(v.array(v.string())),
    /** Заказов в работе сейчас (назначен … ждёт клиента) — счётчик для подбора без перебора заказов (lib/stats.syncLoad). */
    activeCount: v.optional(v.number()),
  }).index("by_phone", ["phone"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_phone", ["tenantId", "phone"]),

  clients: defineTable({
    tenantId: v.string(),
    name: v.string(),
    kind: v.union(v.literal("person"), v.literal("company")),
    phone: v.string(),
    email: v.optional(v.string()),
    city: v.string(),
    address: v.optional(v.string()),
    source,
    preferredChannel: v.optional(source),
    tags: v.array(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.string(),
    // Денормализация для списка клиентов — обновляется при изменении заказов.
    ordersCount: v.number(),
    activeCount: v.number(),
    lastOrderAt: v.optional(v.string()),
    lastActivityAt: v.string(),
    /** Данные удалены по запросу клиента (ТЗ п.26): карточка обезличена, номера и суммы заказов остались. */
    anonymizedAt: v.optional(v.string()),
  })
    .index("by_phone", ["phone"])
    .index("by_activity", ["lastActivityAt"])
    .searchIndex("search_name", { searchField: "name", filterFields: ["tenantId"] })
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_phone", ["tenantId", "phone"])
    .index("t_by_activity", ["tenantId", "lastActivityAt"]),

  leads: defineTable({
    tenantId: v.string(),
    number: v.number(),
    clientId: v.id("clients"),
    clientName: v.string(),
    clientPhone: v.string(),
    source,
    serviceId: v.string(),
    city: v.string(),
    description: v.string(),
    urgency,
    status: leadStatus,
    /** Кто ведёт заявку. Заявку из канала (бот, сайт, API, WhatsApp, OLX, AI) никто не ведёт, пока её не взяли в работу (E12). */
    operatorId: v.optional(v.id("users")),
    /** Кто завёл; нет — заявка заведена до появления поля (считается заведённой оператором). */
    origin: v.optional(leadOrigin),
    /** Первое действие сотрудника по заявке — для эскалации «заявка без ответа» и аналитики реакции. */
    firstActionAt: v.optional(v.string()),
    createdAt: v.string(),
    orderId: v.optional(v.id("orders")),
    comment: v.optional(v.string()),
    rejectReason: v.optional(v.string()),
    ai: v.optional(aiSummary),
    /** Звонок, из которого родилась заявка (запись, расшифровка). */
    callId: v.optional(v.id("calls")),
    /** Структурные данные обращения (ТЗ п.8): адрес → в заказ, удобное время — подсказка к сроку, бюджет — только сотрудникам. */
    address: v.optional(v.string()),
    preferredTime: v.optional(v.string()),
    budget: v.optional(v.number()),
    /** Район города (ТЗ п.12.3) — переходит в заказ. */
    district: v.optional(v.string()),
    /** Метки рекламы и кампания (ТЗ п.6.6): кампания — из utm_campaign или задана явно; в заказ копируются при конвертации. */
    utm: v.optional(utm),
    campaign: v.optional(v.string()),
  })
    .index("by_created", ["createdAt"])
    .index("by_status", ["status", "createdAt"])
    .index("by_client", ["clientId", "createdAt"])
    .index("by_number", ["number"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_created", ["tenantId", "createdAt"])
    .index("t_by_status", ["tenantId", "status", "createdAt"])
    .index("t_by_client", ["tenantId", "clientId", "createdAt"])
    .index("t_by_number", ["tenantId", "number"]),

  orders: defineTable({
    tenantId: v.string(),
    number: v.number(),
    clientId: v.id("clients"),
    clientName: v.string(),
    clientPhone: v.string(),
    leadId: v.optional(v.id("leads")),
    source,
    serviceId: v.string(),
    category,
    description: v.string(),
    city: v.string(),
    address: v.string(),
    deadline: v.string(),
    priority: urgency,
    status: orderStatus,
    clientPrice: v.number(),
    payoutMode: v.union(v.literal("fixed"), v.literal("percent")),
    payoutValue: v.number(),
    payments: v.array(payment),
    refunds: v.optional(v.array(refund)),
    payoutPaid: v.boolean(),
    /** Выплата проведена по реестру выплат (таблица payouts): когда и какой записью. */
    payoutPaidAt: v.optional(v.string()),
    payoutId: v.optional(v.id("payouts")),
    /** Сколько исполнитель получит — снимок в момент, когда он взял или подтвердил заказ (ТЗ п.13: условия не меняются молча). */
    acceptedPayout: v.optional(v.number()),
    /** Дата последнего движения денег (оплата, возврат) — чтобы «Получено» за период находилось по индексу. */
    moneyAt: v.optional(v.string()),
    executorId: v.optional(v.id("executors")),
    assignedAt: v.optional(v.string()),
    createdAt: v.string(),
    createdBy: v.id("users"),
    doneAt: v.optional(v.string()),
    paidAt: v.optional(v.string()),
    closedAt: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
    /** Навыки, без которых заказ мастеру не показываем (ТЗ п.11). Пусто — хватает направления и города. */
    requiredSkills: v.optional(v.array(v.string())),
    files: v.array(attachment),
    // Чтобы напоминания о сроке не уходили повторно.
    soonNotified: v.optional(v.boolean()),
    overdueNotified: v.optional(v.boolean()),
    // Автораспределение (ТЗ п.23): кому система уже предлагала заказ, когда назначила текущего мастера
    // (совпадает с assignedAt, пока назначение автоматическое) и когда сообщила, что кандидаты кончились.
    autoOffered: v.optional(v.array(v.id("executors"))),
    autoAssignedAt: v.optional(v.string()),
    autoExhaustedAt: v.optional(v.string()),
    /** Район города (ТЗ п.12.3): мастеру с заданными районами заказ подходит, только если район — его. */
    district: v.optional(v.string()),
    /** Условия выплаты до применения ставки мастера (ТЗ п.14.5): с ними заказ возвращается в ленту. */
    payoutBase: v.optional(payoutTerms),
    /** Выплату правили вручную — ставки мастеров к заказу не применяются. */
    payoutManual: v.optional(v.boolean()),
    /** Метки рекламы и кампания — из заявки (ТЗ п.28.5). */
    utm: v.optional(utm),
    campaign: v.optional(v.string()),
    /** Чей счётчик activeCount сейчас включает этот заказ — чтобы при смене мастера пересчитать и прежнего. */
    loadExecutorId: v.optional(v.id("executors")),
    /** Комиссия платформы с этого заказа (ТЗ §24.2) — снимок в момент выполнения; входит в маржу как расход. */
    platformFee: v.optional(v.number()),
  })
    .index("by_status", ["status", "deadline"])
    .index("by_executor", ["executorId", "status"])
    .index("by_client", ["clientId", "createdAt"])
    .index("by_created", ["createdAt"])
    .index("by_done", ["doneAt"])
    .index("by_number", ["number"])
    // Долг исполнителям: невыплаченные выполненные заказы без перебора всей истории.
    .index("by_payout", ["payoutPaid", "doneAt"])
    .index("by_money", ["moneyAt"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_status", ["tenantId", "status", "deadline"])
    .index("t_by_executor", ["tenantId", "executorId", "status"])
    .index("t_by_client", ["tenantId", "clientId", "createdAt"])
    .index("t_by_created", ["tenantId", "createdAt"])
    .index("t_by_done", ["tenantId", "doneAt"])
    .index("t_by_number", ["tenantId", "number"])
    .index("t_by_payout", ["tenantId", "payoutPaid", "doneAt"])
    .index("t_by_money", ["tenantId", "moneyAt"]),

  messages: defineTable({
    tenantId: v.optional(v.string()),
    orderId: v.id("orders"),
    author: actor,
    channel: messageChannel,
    text: v.string(),
    files: v.array(attachment),
    at: v.string(),
  }).index("by_order", ["orderId", "at"]),

  history: defineTable({
    tenantId: v.optional(v.string()),
    orderId: v.id("orders"),
    kind: historyKind,
    text: v.string(),
    actor,
    at: v.string(),
    /** Смена статуса — откуда и куда (структурно, для отчётов и разбора споров). */
    from: v.optional(orderStatus),
    to: v.optional(orderStatus),
  }).index("by_order", ["orderId", "at"]),

  interactions: defineTable({
    tenantId: v.optional(v.string()),
    clientId: v.id("clients"),
    kind: v.union(v.literal("lead"), v.literal("call"), v.literal("message")),
    channel: source,
    title: v.string(),
    text: v.string(),
    at: v.string(),
    leadId: v.optional(v.id("leads")),
  }).index("by_client", ["clientId", "at"]),

  clientNotes: defineTable({
    tenantId: v.optional(v.string()),
    clientId: v.id("clients"),
    authorId: v.id("users"),
    text: v.string(),
    at: v.string(),
  }).index("by_client", ["clientId", "at"]),

  notifications: defineTable({
    tenantId: v.optional(v.string()),
    userId: v.id("users"),
    text: v.string(),
    link: v.optional(v.string()),
    at: v.string(),
    read: v.boolean(),
    tone,
  })
    .index("by_user", ["userId", "at"])
    .index("by_user_read", ["userId", "read"]),

  /** Справочник: направления и услуги с типичными ценами (владелец правит в «Настройках»). */
  categories: defineTable({
    tenantId: v.optional(v.string()),
    key: v.string(),
    label: v.string(),
    tone: v.string(),
    order: v.number(),
    active: v.boolean(),
    /** Навыки направления (ТЗ п.12, п.21): из них мастер отмечает свои, оператор — требуемые в заказе. */
    skills: v.optional(v.array(v.string())),
  }).index("by_key", ["key"]),
  services: defineTable({
    tenantId: v.optional(v.string()),
    key: v.string(),
    category: v.string(),
    label: v.string(),
    icon: v.string(),
    priceMin: v.number(),
    priceMax: v.number(),
    payoutPct: v.number(),
    examples: v.array(v.string()),
    order: v.number(),
    active: v.boolean(),
  }).index("by_key", ["key"]),

  /** Звонки: события от АТС (вебхук) или запись, загруженная вручную; AI расшифровывает и разбирает. */
  calls: defineTable({
    tenantId: v.string(),
    externalId: v.optional(v.string()),
    direction: v.union(v.literal("in"), v.literal("out")),
    from: v.string(),
    to: v.string(),
    clientId: v.optional(v.id("clients")),
    clientName: v.optional(v.string()),
    leadId: v.optional(v.id("leads")),
    operatorId: v.optional(v.id("users")),
    status: v.union(v.literal("ringing"), v.literal("answered"), v.literal("missed"), v.literal("completed")),
    startedAt: v.string(),
    endedAt: v.optional(v.string()),
    duration: v.optional(v.number()),
    recordingUrl: v.optional(v.string()),
    recordingId: v.optional(v.id("_storage")),
    transcript: v.optional(v.string()),
    ai: v.optional(aiSummary),
    /** Что AI понял для заявки — чтобы оператор создал её в один клик. */
    draft: v.optional(aiDraft),
    aiStatus: v.optional(v.union(v.literal("pending"), v.literal("done"), v.literal("failed"), v.literal("none"))),
    aiError: v.optional(v.string()),
  })
    .index("by_started", ["startedAt"])
    .index("by_external", ["externalId"])
    .index("by_status", ["status", "startedAt"])
    .index("by_client", ["clientId", "startedAt"])
    // Звонки по номеру — при удалении данных клиента по его запросу (ТЗ п.26): звонок мог прийти раньше, чем клиента завели.
    .index("by_from", ["from"])
    .index("by_to", ["to"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_started", ["tenantId", "startedAt"])
    .index("t_by_external", ["tenantId", "externalId"])
    .index("t_by_status", ["tenantId", "status", "startedAt"])
    .index("t_by_client", ["tenantId", "clientId", "startedAt"])
    .index("t_by_from", ["tenantId", "from"])
    .index("t_by_to", ["tenantId", "to"]),

  /** Настройки компании ключ → значение (секрет вебхука АТС и т.п.). */
  settings: defineTable({ tenantId: v.optional(v.string()), key: v.string(), value: v.string() }).index("by_key", ["key"]),

  /** Диалоги бота с клиентами (не сотрудниками): черновик заявки до получения телефона. */
  botChats: defineTable({
    tenantId: v.optional(v.string()),
    chatId: v.string(),
    state: v.union(v.literal("idle"), v.literal("awaiting_phone")),
    draft: v.optional(v.string()),
    name: v.optional(v.string()),
    leadId: v.optional(v.id("leads")),
    updatedAt: v.string(),
  }).index("by_chat", ["chatId"]),

  /** Сквозная нумерация заявок и заказов. */
  counters: defineTable({ tenantId: v.optional(v.string()), name: v.string(), value: v.number() }).index("by_name", ["name"]),

  /**
   * Журнал ключевых действий (ТЗ п.20, п.26, п.27). Пишется в той же мутации, что и действие.
   * Имя и роль автора — строкой: журнал читается и после удаления/переименования сотрудника.
   */
  audit: defineTable({
    tenantId: v.string(),
    at: v.string(),
    actorId: v.optional(v.id("users")),
    actorName: v.string(),
    actorRole: v.optional(v.string()),
    action: v.string(),
    entity: auditEntity,
    entityId: v.optional(v.string()),
    summary: v.string(),
    meta: v.optional(v.any()),
  })
    .index("by_at", ["at"])
    .index("by_entity", ["entity", "entityId", "at"])
    .index("by_actor", ["actorId", "at"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_at", ["tenantId", "at"])
    .index("t_by_entity", ["tenantId", "entity", "entityId", "at"])
    .index("t_by_actor", ["tenantId", "actorId", "at"]),

  /** Единый чат с клиентами: один диалог на собеседника в канале (чат Telegram, номер WhatsApp, тред OLX, форма сайта). */
  conversations: defineTable({
    tenantId: v.string(),
    channel,
    externalId: v.string(),
    contactName: v.optional(v.string()),
    contactPhone: v.optional(v.string()),
    clientId: v.optional(v.id("clients")),
    leadId: v.optional(v.id("leads")),
    /** Тема: для OLX — объявление, по которому пишет покупатель. */
    subject: v.optional(v.string()),
    subjectUrl: v.optional(v.string()),
    lastMessageAt: v.string(),
    lastText: v.string(),
    lastDirection: v.union(v.literal("in"), v.literal("out")),
    unread: v.number(),
    status: v.union(v.literal("open"), v.literal("closed")),
    assigneeId: v.optional(v.id("users")),
    /** WhatsApp: до какого момента можно отвечать свободным текстом (окно 24 часа). */
    replyUntil: v.optional(v.string()),
    /**
     * WhatsApp: BSUID собеседника («KZ.…») — есть во всех вебхуках с 04.2026, а номер у клиентов с username может скрыться.
     * Диалог ищем по нему, затем по номеру (externalId).
     */
    waUserId: v.optional(v.string()),
    meta: v.optional(v.any()),
  })
    .index("by_channel_external", ["channel", "externalId"])
    .index("by_wa_user", ["waUserId"])
    .index("by_last", ["lastMessageAt"])
    .index("by_status_last", ["status", "lastMessageAt"])
    .index("by_client", ["clientId", "lastMessageAt"])
    .index("by_lead", ["leadId"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_channel_external", ["tenantId", "channel", "externalId"])
    .index("t_by_wa_user", ["tenantId", "waUserId"])
    .index("t_by_last", ["tenantId", "lastMessageAt"])
    .index("t_by_status_last", ["tenantId", "status", "lastMessageAt"])
    .index("t_by_client", ["tenantId", "clientId", "lastMessageAt"])
    .index("t_by_lead", ["tenantId", "leadId"]),

  conversationMessages: defineTable({
    tenantId: v.optional(v.string()),
    conversationId: v.id("conversations"),
    direction: v.union(v.literal("in"), v.literal("out")),
    kind: messageKind,
    text: v.string(),
    at: v.string(),
    /** Id сообщения во внешнем канале — защита от повторной доставки вебхука. */
    externalId: v.optional(v.string()),
    authorId: v.optional(v.id("users")),
    fileId: v.optional(v.id("_storage")),
    fileName: v.optional(v.string()),
    status: v.optional(v.union(v.literal("sending"), v.literal("sent"), v.literal("delivered"), v.literal("read"), v.literal("failed"))),
    error: v.optional(v.string()),
  })
    .index("by_conversation", ["conversationId", "at"])
    .index("by_external", ["externalId"]),

  /** Автоматические сообщения клиенту (clientNotify.ts): ключ события («order:<id>:done») — чтобы оно не ушло второй раз. */
  clientNotices: defineTable({
    tenantId: v.optional(v.string()),
    key: v.string(),
    clientId: v.id("clients"),
    conversationId: v.id("conversations"),
    messageId: v.id("conversationMessages"),
    at: v.string(),
  }).index("by_key", ["key"]),

  /** Подключённые внешние аккаунты (OLX, WhatsApp, email). Токены отдаются только внутренним функциям. */
  integrations: defineTable({
    tenantId: v.optional(v.string()),
    provider: v.union(v.literal("olx"), v.literal("whatsapp"), v.literal("email")),
    status: v.union(v.literal("disconnected"), v.literal("connected"), v.literal("error")),
    accountId: v.optional(v.string()),
    accountName: v.optional(v.string()),
    accessToken: v.optional(v.string()),
    refreshToken: v.optional(v.string()),
    expiresAt: v.optional(v.string()),
    /** Курсор синхронизации (последнее обработанное сообщение/время). */
    cursor: v.optional(v.string()),
    lastSyncAt: v.optional(v.string()),
    lastError: v.optional(v.string()),
    connectedBy: v.optional(v.id("users")),
    connectedAt: v.optional(v.string()),
    /** OLX: до какого момента запросы на паузе (403 CloudFront — 30 минут, 429 и сбои — по нарастающей); backoffStep — сколько раз подряд. */
    backoffUntil: v.optional(v.string()),
    backoffStep: v.optional(v.number()),
    /** OLX: аренды (мс) — один проход синхронизации и одно обновление токена одновременно. */
    syncLeaseUntil: v.optional(v.number()),
    refreshLeaseUntil: v.optional(v.number()),
  }).index("by_provider", ["provider"]),

  /** Одноразовые state для OAuth (защита от CSRF при подключении OLX). */
  oauthStates: defineTable({ tenantId: v.optional(v.string()), state: v.string(), provider: v.string(), userId: v.id("users"), createdAt: v.string() }).index("by_state", ["state"]),

  /** Ключи публичного API (ТЗ «API-first»): храним только хэш, сам ключ показываем один раз. */
  apiKeys: defineTable({
    tenantId: v.optional(v.string()),
    name: v.string(),
    prefix: v.string(),
    hash: v.string(),
    createdAt: v.string(),
    createdBy: v.id("users"),
    lastUsedAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
    /** Права ключа (src/data/apiScopes.ts); нет поля — ключ создан до прав: leads:write и leads:read. */
    scopes: v.optional(v.array(v.string())),
  }).index("by_hash", ["hash"]),

  /** Заявки, созданные через публичный API: ключ идемпотентности (externalId) и «свои» заявки ключа — статус отдаём только по ним. */
  apiLeads: defineTable({ tenantId: v.optional(v.string()), keyId: v.id("apiKeys"), leadId: v.id("leads"), number: v.number(), externalId: v.optional(v.string()), at: v.string() })
    .index("by_key_external", ["keyId", "externalId"])
    .index("by_key_number", ["keyId", "number"]),

  /** Отзывы клиентов о выполненных заказах (ТЗ п.14, п.29): из них считается рейтинг мастера. */
  reviews: defineTable({
    tenantId: v.string(),
    orderId: v.id("orders"),
    executorId: v.id("executors"),
    clientId: v.id("clients"),
    rating: v.number(),
    text: v.optional(v.string()),
    via: v.union(v.literal("operator"), v.literal("link"), v.literal("telegram"), v.literal("whatsapp")),
    at: v.string(),
    authorId: v.optional(v.id("users")),
  })
    .index("by_order", ["orderId"])
    .index("by_executor", ["executorId", "at"])
    .index("by_at", ["at"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_order", ["tenantId", "orderId"])
    .index("t_by_executor", ["tenantId", "executorId", "at"])
    .index("t_by_at", ["tenantId", "at"]),

  /** Ссылка «оцените работу» для клиента: неугадываемый токен, одноразовая, со сроком. */
  reviewRequests: defineTable({ tenantId: v.optional(v.string()), token: v.string(), orderId: v.id("orders"), createdAt: v.string(), expiresAt: v.string(), usedAt: v.optional(v.string()) })
    .index("by_token", ["token"])
    .index("by_order", ["orderId"]),

  /** Расходы на рекламу по источникам за месяц (YYYY-MM) — для стоимости заявки и заказа (ТЗ п.17). */
  adSpend: defineTable({ tenantId: v.optional(v.string()), month: v.string(), source, amount: v.number(), updatedAt: v.string(), updatedBy: v.id("users") }).index("by_month", ["month", "source"]),

  /** Расходы на рекламную кампанию за месяц (YYYY-MM) — для CPL/CPO/ROMI кампаний (ТЗ п.28.5). campaign — как в utm_campaign. */
  campaignSpend: defineTable({ tenantId: v.optional(v.string()), month: v.string(), campaign: v.string(), amount: v.number(), updatedAt: v.string(), updatedBy: v.id("users") }).index("by_month", ["month", "campaign"]),

  /**
   * Исходящие вебхуки (ТЗ п.20.7, п.26.7): подписка владельца на события. secret — зашифрован (lib/secretBox.ts),
   * им подписывается тело (X-HMS-Signature). failures — неудачных попыток подряд; на пороге подписка отключается.
   */
  webhooks: defineTable({
    tenantId: v.optional(v.string()),
    url: v.string(),
    events: v.array(webhookEvent),
    secret: v.string(),
    description: v.optional(v.string()),
    active: v.boolean(),
    failures: v.number(),
    createdAt: v.string(),
    createdBy: v.id("users"),
    disabledAt: v.optional(v.string()),
    disabledReason: v.optional(v.string()),
    lastDeliveryAt: v.optional(v.string()),
    lastError: v.optional(v.string()),
  }).index("by_active", ["active"]),
  /** Доставки вебхуков: тело, попытки, ответ получателя. pending — ждёт попытки; failed — попытки кончились. */
  webhookDeliveries: defineTable({
    tenantId: v.optional(v.string()),
    webhookId: v.id("webhooks"),
    event: webhookEvent,
    eventId: v.string(),
    body: v.string(),
    status: v.union(v.literal("pending"), v.literal("ok"), v.literal("failed")),
    attempts: v.number(),
    test: v.optional(v.boolean()),
    nextAt: v.optional(v.string()),
    responseCode: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.string(),
    deliveredAt: v.optional(v.string()),
  })
    .index("by_webhook", ["webhookId", "createdAt"])
    .index("by_created", ["createdAt"]),

  /** Счётчики лимитов (антиспам публичных форм и API): ключ + окно. by_window — для очистки отживших (maintenance.ts). */
  rateLimits: defineTable({ key: v.string(), windowStart: v.number(), count: v.number() }).index("by_key", ["key"]).index("by_window", ["windowStart"]),

  /** update_id принятых обновлений Telegram: повтор доставки вебхука не обрабатываем второй раз (аудит L-3). Живут 2 суток. */
  telegramUpdates: defineTable({ tenantId: v.optional(v.string()), updateId: v.number() }).index("by_update", ["updateId"]),

  /** Состояние подсистем для владельца (ТЗ п.20 «мониторинг»): когда работало, последняя ошибка. */
  systemStatus: defineTable({
    tenantId: v.optional(v.string()),
    key: v.string(),
    okAt: v.optional(v.string()),
    okNote: v.optional(v.string()),
    errorAt: v.optional(v.string()),
    error: v.optional(v.string()),
    /** Оповещения владельцу (convex/alerts.ts, ТЗ п.26.5): когда ушло последнее «сбой» и в каком состоянии подсистема для них. */
    alertAt: v.optional(v.string()),
    alertState: v.optional(v.union(v.literal("down"), v.literal("up"))),
  }).index("by_key", ["key"]),

  /**
   * Реестр выплат исполнителям (ТЗ п.13, п.14, п.17): одна выплата — один или несколько выполненных заказов мастера.
   * at — дата выплаты, createdAt — когда провели (отменить можно в течение суток).
   */
  payouts: defineTable({
    tenantId: v.string(),
    executorId: v.id("executors"),
    orderIds: v.array(v.id("orders")),
    /** Номера тех же заказов — для реестра и экрана мастера без чтения каждого заказа. */
    orderNumbers: v.array(v.number()),
    amount: v.number(),
    method: paymentMethod,
    at: v.string(),
    by: v.id("users"),
    note: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("by_at", ["at"])
    .index("by_executor", ["executorId", "at"])
    // Компания первым полем: lib/tenantDb.ts подставляет t_<имя> вместо <имя> (старые индексы — до перехода всех вызовов).
    .index("by_tenant", ["tenantId"])
    .index("t_by_at", ["tenantId", "at"])
    .index("t_by_executor", ["tenantId", "executorId", "at"]),

  /**
   * Выгрузки CSV владельца (ТЗ п.26.9): файл отдаётся только по подписанной ссылке и живёт сутки (expiresAt),
   * потом уборка (exports.cleanup) удаляет и файл, и строку. from/to — период выгрузки.
   */
  exports: defineTable({
    tenantId: v.optional(v.string()),
    kind: v.string(),
    from: v.string(),
    to: v.string(),
    rows: v.number(),
    size: v.number(),
    fileId: v.id("_storage"),
    by: v.id("users"),
    at: v.string(),
    expiresAt: v.string(),
  }).index("by_expires", ["expiresAt"]),

  /** Резервные копии данных (ТЗ п.20, п.26): JSON-снимок в хранилище. */
  backups: defineTable({
    tenantId: v.optional(v.string()),
    at: v.string(),
    fileId: v.id("_storage"),
    size: v.number(),
    docs: v.number(),
    by: v.optional(v.id("users")),
    /** Когда та же копия легла во внешнее хранилище (offsite.ts). */
    offsiteAt: v.optional(v.string()),
  }).index("by_at", ["at"]),

  /** Файлы, уже скопированные во внешнее хранилище (offsite.ts, по настройке владельца): копируются один раз. */
  offsiteFiles: defineTable({ tenantId: v.optional(v.string()), storageId: v.id("_storage"), key: v.string(), size: v.number(), at: v.string() }).index("by_storage", ["storageId"]),

  /** Подписки web push (ТЗ п.23.6): браузер сотрудника или мастера; endpoint и ключи шифрования выдаёт браузер. */
  pushSubscriptions: defineTable({
    tenantId: v.optional(v.string()),
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    createdAt: v.string(),
    lastOkAt: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"]),

  /**
   * Ошибки интерфейса (ТЗ п.26.5): без данных людей — текст ошибки, путь без параметров, версия сборки, роль.
   * Одинаковые за сутки — одна строка со счётчиком; старше двух недель уборка удаляет.
   */
  clientErrors: defineTable({
    tenantId: v.optional(v.string()),
    sig: v.string(),
    message: v.string(),
    path: v.string(),
    build: v.string(),
    kind: v.union(v.literal("error"), v.literal("rejection")),
    role: v.optional(v.string()),
    count: v.number(),
    firstAt: v.string(),
    lastAt: v.string(),
  })
    .index("by_sig", ["sig", "lastAt"])
    .index("by_last", ["lastAt"]),

  /**
   * Кто загрузил файл (аудит M-10): прикрепить к заказу или звонку можно только свою подтверждённую загрузку и один раз.
   * usedAt — когда прикрепили; неприкреплённые старше суток уборка удаляет вместе с файлом.
   */
  uploads: defineTable({ tenantId: v.optional(v.string()), storageId: v.id("_storage"), userId: v.id("users"), at: v.string(), usedAt: v.optional(v.string()) })
    .index("by_storage", ["storageId"])
    .index("by_used", ["usedAt", "at"]),

  /**
   * Эскалации (ТЗ п.15, convex/escalations.ts): какой уровень уже сработал в эпизоде — ни один не повторяется.
   * Эпизод (since): заказ попал в ленту, мастера назначили, срок заказа, заявка создана, звонок пропущен; новый эпизод —
   * уровни заново. Одна строка на сущность и вид; старше 30 дней уборка удаляет.
   */
  escalations: defineTable({
    tenantId: v.optional(v.string()),
    kind: v.union(v.literal("feed"), v.literal("unconfirmed"), v.literal("overdue"), v.literal("lead"), v.literal("callback")),
    entityId: v.string(),
    since: v.string(),
    level: v.number(),
    at: v.string(),
  })
    .index("by_kind_entity", ["kind", "entityId"])
    .index("by_at", ["at"]),

  // ── Предрасчёт аналитики (ТЗ §26.6, convex/stats.ts, правила — src/data/dailyStats.ts) ──
  /** Факты заказа или заявки за один день (по Алматы): из них складываются итоги дня. */
  statsFacts: defineTable({ tenantId: v.optional(v.string()), entity: v.union(v.literal("order"), v.literal("lead")), ref: v.string(), day: v.string(), ...statCell })
    .index("by_entity", ["entity", "ref"])
    .index("by_day", ["day"]),
  /** Итоги дня (YYYY-MM-DD) или месяца (YYYY-MM) по направлению, источнику и городу — их читают «Аналитика» и «Главная». */
  dailyStats: defineTable({ tenantId: v.optional(v.string()), grain: v.union(v.literal("day"), v.literal("month")), period: v.string(), ...statCell }).index("by_period", ["grain", "period"]),
  /** Очередь пересчёта: изменившиеся заказы и заявки, затем их дни и месяцы. */
  statsDirty: defineTable({ tenantId: v.optional(v.string()), kind: v.union(v.literal("order"), v.literal("lead"), v.literal("day"), v.literal("month")), ref: v.string() }).index("by_ref", ["kind", "ref"]),
  /** Состояние предрасчёта: когда собран целиком и как идёт полный пересчёт (одна строка). */
  statsState: defineTable({
    tenantId: v.optional(v.string()),
    builtAt: v.optional(v.string()),
    rebuild: v.optional(
      v.object({
        run: v.string(),
        phase: v.union(v.literal("wipe"), v.literal("leads"), v.literal("orders"), v.literal("stale"), v.literal("days")),
        cursor: v.union(v.string(), v.null()),
        /** Последний шаг: давно не было — пересчёт оборвался, крон запускает его заново. */
        at: v.string(),
        by: v.optional(v.id("users")),
      }),
    ),
  }),

  /**
   * Счета на онлайн-оплату заказа (ТЗ п.19.7, п.23.5): ссылка провайдера → уведомление провайдера → оплата в заказе.
   * invoiceId — наш номер счёта у провайдера (pg_order_id / InvoiceId), externalId — номер у провайдера.
   */
  paymentIntents: defineTable({
    tenantId: v.optional(v.string()),
    orderId: v.id("orders"),
    provider: payProvider,
    invoiceId: v.string(),
    amount: v.number(),
    status: payIntentStatus,
    url: v.optional(v.string()),
    externalId: v.optional(v.string()),
    createdAt: v.string(),
    createdBy: v.id("users"),
    expiresAt: v.string(),
    /** Отправлен клиенту в его канал. */
    sentAt: v.optional(v.string()),
    paidAt: v.optional(v.string()),
    /** Оплата в заказе, которую внесла система по уведомлению провайдера. */
    paymentId: v.optional(v.string()),
    /** Сумма из уведомления, если она не совпала со счётом. */
    reportedAmount: v.optional(v.number()),
    error: v.optional(v.string()),
    updatedAt: v.string(),
  })
    .index("by_order", ["orderId", "createdAt"])
    .index("by_invoice", ["invoiceId"]),

  /**
   * Документы по заказу (ТЗ п.19.9): «Счёт на оплату» и «Акт выполненных работ». data — снимок на момент выпуска:
   * повторная печать совпадает с первой, даже если заказ или реквизиты потом изменились. Ссылка клиенту — только хэш токена и срок.
   */
  documents: defineTable({
    tenantId: v.optional(v.string()),
    orderId: v.id("orders"),
    kind: documentKind,
    number: v.number(),
    /** Номер для печати: префикс владельца + число. */
    label: v.string(),
    date: v.string(),
    total: v.number(),
    data: documentData,
    createdAt: v.string(),
    createdBy: v.id("users"),
    /** Выпущен новый документ того же вида — этот больше не актуален. */
    replacedAt: v.optional(v.string()),
    publicTokenHash: v.optional(v.string()),
    publicExpiresAt: v.optional(v.string()),
    sentAt: v.optional(v.string()),
  })
    .index("by_order", ["orderId", "kind", "createdAt"])
    .index("by_public_token", ["publicTokenHash"]),
});
