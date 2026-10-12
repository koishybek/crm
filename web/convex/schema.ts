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
});
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
    payments: v.array(v.object({ id: v.string(), amount: v.number(), method: paymentMethod, at: v.string() })),
    payoutPaid: v.boolean(),
    executorId: v.optional(v.id("executors")),
    assignedAt: v.optional(v.string()),
    createdAt: v.string(),
    createdBy: v.id("users"),
    doneAt: v.optional(v.string()),
    paidAt: v.optional(v.string()),
    closedAt: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
    files: v.array(attachment),
    // Чтобы напоминания о сроке не уходили повторно.
    soonNotified: v.optional(v.boolean()),
    overdueNotified: v.optional(v.boolean()),
  })
    .index("by_status", ["status", "deadline"])
    .index("by_executor", ["executorId", "status"])
    .index("by_client", ["clientId", "createdAt"])
    .index("by_created", ["createdAt"])
    .index("by_done", ["doneAt"])
    .index("by_number", ["number"]),

  messages: defineTable({
    orderId: v.id("orders"),
    author: actor,
    channel: v.union(v.literal("internal"), v.literal("client")),
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
  categories: defineTable({ key: v.string(), label: v.string(), tone: v.string(), order: v.number(), active: v.boolean() }).index("by_key", ["key"]),
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
    .index("by_client", ["clientId", "startedAt"]),

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
});
