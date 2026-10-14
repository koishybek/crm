import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Даты — ISO-строки в UTC: сортируются как строки и совпадают с типами фронта (src/data/types.ts).

export const role = v.union(v.literal("owner"), v.literal("operator"), v.literal("manager"), v.literal("executor"));
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
export const aiSummary = v.object({
  summary: v.string(),
  extracted: v.array(v.object({ label: v.string(), value: v.string() })),
  questions: v.array(v.string()),
});

export default defineSchema({
  ...authTables,

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
  })
    .index("email", ["email"])
    .index("phone", ["phone"])
    .index("by_role", ["role"])
    .index("by_executor", ["executorId"])
    .index("by_telegram_code", ["telegramLinkCode"])
    .index("by_telegram_chat", ["telegramChatId"]),

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
  }).index("by_phone", ["phone"]),

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
    .searchIndex("search_name", { searchField: "name" }),

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
    operatorId: v.id("users"),
    createdAt: v.string(),
    orderId: v.optional(v.id("orders")),
    comment: v.optional(v.string()),
    rejectReason: v.optional(v.string()),
    ai: v.optional(aiSummary),
    /** Звонок, из которого родилась заявка (запись, расшифровка). */
    callId: v.optional(v.id("calls")),
  })
    .index("by_created", ["createdAt"])
    .index("by_status", ["status", "createdAt"])
    .index("by_client", ["clientId", "createdAt"])
    .index("by_number", ["number"]),

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
  })
    .index("by_status", ["status", "deadline"])
    .index("by_executor", ["executorId", "status"])
    .index("by_client", ["clientId", "createdAt"])
    .index("by_created", ["createdAt"])
    .index("by_done", ["doneAt"])
    .index("by_number", ["number"])
    // Долг исполнителям: невыплаченные выполненные заказы без перебора всей истории.
    .index("by_payout", ["payoutPaid", "doneAt"])
    .index("by_money", ["moneyAt"]),

  messages: defineTable({
    orderId: v.id("orders"),
    author: actor,
    channel: messageChannel,
    text: v.string(),
    files: v.array(attachment),
    at: v.string(),
  }).index("by_order", ["orderId", "at"]),

  history: defineTable({
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
    clientId: v.id("clients"),
    kind: v.union(v.literal("lead"), v.literal("call"), v.literal("message")),
    channel: source,
    title: v.string(),
    text: v.string(),
    at: v.string(),
    leadId: v.optional(v.id("leads")),
  }).index("by_client", ["clientId", "at"]),

  clientNotes: defineTable({
    clientId: v.id("clients"),
    authorId: v.id("users"),
    text: v.string(),
    at: v.string(),
  }).index("by_client", ["clientId", "at"]),

  notifications: defineTable({
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
    key: v.string(),
    label: v.string(),
    tone: v.string(),
    order: v.number(),
    active: v.boolean(),
    /** Навыки направления (ТЗ п.12, п.21): из них мастер отмечает свои, оператор — требуемые в заказе. */
    skills: v.optional(v.array(v.string())),
  }).index("by_key", ["key"]),
  services: defineTable({
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
    draft: v.optional(
      v.object({
        serviceId: v.optional(v.string()),
        city: v.optional(v.string()),
        address: v.optional(v.string()),
        urgency: v.optional(v.union(v.literal("normal"), v.literal("high"), v.literal("urgent"))),
        clientName: v.optional(v.string()),
        description: v.optional(v.string()),
      }),
    ),
    aiStatus: v.optional(v.union(v.literal("pending"), v.literal("done"), v.literal("failed"), v.literal("none"))),
    aiError: v.optional(v.string()),
  })
    .index("by_started", ["startedAt"])
    .index("by_external", ["externalId"])
    .index("by_status", ["status", "startedAt"])
    .index("by_client", ["clientId", "startedAt"])
    // Звонки по номеру — при удалении данных клиента по его запросу (ТЗ п.26): звонок мог прийти раньше, чем клиента завели.
    .index("by_from", ["from"])
    .index("by_to", ["to"]),

  /** Настройки компании ключ → значение (секрет вебхука АТС и т.п.). */
  settings: defineTable({ key: v.string(), value: v.string() }).index("by_key", ["key"]),

  /** Диалоги бота с клиентами (не сотрудниками): черновик заявки до получения телефона. */
  botChats: defineTable({
    chatId: v.string(),
    state: v.union(v.literal("idle"), v.literal("awaiting_phone")),
    draft: v.optional(v.string()),
    name: v.optional(v.string()),
    leadId: v.optional(v.id("leads")),
    updatedAt: v.string(),
  }).index("by_chat", ["chatId"]),

  /** Сквозная нумерация заявок и заказов. */
  counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),

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
    .index("by_actor", ["actorId", "at"]),

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
    .index("by_lead", ["leadId"]),

  conversationMessages: defineTable({
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
    key: v.string(),
    clientId: v.id("clients"),
    conversationId: v.id("conversations"),
    messageId: v.id("conversationMessages"),
    at: v.string(),
  }).index("by_key", ["key"]),

  /** Подключённые внешние аккаунты (OLX, WhatsApp, email). Токены отдаются только внутренним функциям. */
  integrations: defineTable({
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
  oauthStates: defineTable({ state: v.string(), provider: v.string(), userId: v.id("users"), createdAt: v.string() }).index("by_state", ["state"]),

  /** Ключи публичного API (ТЗ «API-first»): храним только хэш, сам ключ показываем один раз. */
  apiKeys: defineTable({
    name: v.string(),
    prefix: v.string(),
    hash: v.string(),
    createdAt: v.string(),
    createdBy: v.id("users"),
    lastUsedAt: v.optional(v.string()),
    revokedAt: v.optional(v.string()),
  }).index("by_hash", ["hash"]),

  /** Заявки, созданные через публичный API: ключ идемпотентности (externalId) и «свои» заявки ключа — статус отдаём только по ним. */
  apiLeads: defineTable({ keyId: v.id("apiKeys"), leadId: v.id("leads"), number: v.number(), externalId: v.optional(v.string()), at: v.string() })
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
    .index("by_at", ["at"]),

  /** Ссылка «оцените работу» для клиента: неугадываемый токен, одноразовая, со сроком. */
  reviewRequests: defineTable({ token: v.string(), orderId: v.id("orders"), createdAt: v.string(), expiresAt: v.string(), usedAt: v.optional(v.string()) })
    .index("by_token", ["token"])
    .index("by_order", ["orderId"]),

  /** Расходы на рекламу по источникам за месяц (YYYY-MM) — для стоимости заявки и заказа (ТЗ п.17). */
  adSpend: defineTable({ month: v.string(), source, amount: v.number(), updatedAt: v.string(), updatedBy: v.id("users") }).index("by_month", ["month", "source"]),

  /** Счётчики лимитов (антиспам публичных форм и API): ключ + окно. by_window — для очистки отживших (maintenance.ts). */
  rateLimits: defineTable({ key: v.string(), windowStart: v.number(), count: v.number() }).index("by_key", ["key"]).index("by_window", ["windowStart"]),

  /** update_id принятых обновлений Telegram: повтор доставки вебхука не обрабатываем второй раз (аудит L-3). Живут 2 суток. */
  telegramUpdates: defineTable({ updateId: v.number() }).index("by_update", ["updateId"]),

  /** Состояние подсистем для владельца (ТЗ п.20 «мониторинг»): когда работало, последняя ошибка. */
  systemStatus: defineTable({
    key: v.string(),
    okAt: v.optional(v.string()),
    okNote: v.optional(v.string()),
    errorAt: v.optional(v.string()),
    error: v.optional(v.string()),
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
    .index("by_executor", ["executorId", "at"]),

  /**
   * Выгрузки CSV владельца (ТЗ п.26.9): файл отдаётся только по подписанной ссылке и живёт сутки (expiresAt),
   * потом уборка (exports.cleanup) удаляет и файл, и строку. from/to — период выгрузки.
   */
  exports: defineTable({
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
  backups: defineTable({ at: v.string(), fileId: v.id("_storage"), size: v.number(), docs: v.number(), by: v.optional(v.id("users")) }).index("by_at", ["at"]),

  /**
   * Кто загрузил файл (аудит M-10): прикрепить к заказу или звонку можно только свою подтверждённую загрузку и один раз.
   * usedAt — когда прикрепили; неприкреплённые старше суток уборка удаляет вместе с файлом.
   */
  uploads: defineTable({ storageId: v.id("_storage"), userId: v.id("users"), at: v.string(), usedAt: v.optional(v.string()) })
    .index("by_storage", ["storageId"])
    .index("by_used", ["usedAt", "at"]),
});
