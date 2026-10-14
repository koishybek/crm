// Модель данных прототипа. Повторяет сущности ТЗ и в будущем станет формой ответов REST API.
// tenantId есть на всех сущностях с первого дня — задел под SaaS-мультиаккаунт (ТЗ п.28).

export type Role = "owner" | "operator" | "manager" | "executor";

export type SourceId = "olx" | "phone" | "whatsapp" | "telegram" | "site" | "instagram" | "referral";

/** Ключ направления. Справочник направлений живёт в базе (Настройки → Услуги). */
export type CategoryId = string;

export type Urgency = "normal" | "high" | "urgent";

/** Кто завёл заявку: оператор сам или канал — AI по звонку, Telegram-бот, сайт, API, WhatsApp, OLX. */
export type LeadOrigin = "operator" | "ai" | "bot" | "site" | "api" | "whatsapp" | "olx";

/** Статус заявки, который хранится. Для сконвертированных заявок на экране показывается прогресс заказа. */
export type LeadStatus = "new" | "qualifying" | "waiting" | "converted" | "rejected";

/** Статусы заказа ровно по ТЗ п.10 + «Отменён» и «Возврат». */
export type OrderStatus =
  | "new"
  | "awaiting_executor"
  | "assigned"
  | "accepted"
  | "in_progress"
  | "awaiting_client"
  | "done"
  | "awaiting_payment"
  | "paid"
  | "closed"
  | "cancelled"
  | "refund";

export type PaymentMethod = "kaspi" | "cash" | "card" | "transfer";

export interface User {
  id: string;
  tenantId: string;
  name: string;
  role: Role;
  email: string;
  phone: string;
  executorId?: string;
  /** false — доступ отключён владельцем. */
  active?: boolean;
  /** Подключён ли Telegram для уведомлений. */
  telegram?: boolean;
  /** Направления руководителя (role = manager). */
  categories?: string[];
  /** Дублировать важные уведомления на email. */
  notifyEmail?: boolean;
  /** Вошёл с временным паролем — до смены пароля доступен только экран «Смените пароль». */
  mustChangePassword?: boolean;
}

export interface Client {
  id: string;
  tenantId: string;
  name: string;
  kind: "person" | "company";
  phone: string;
  email?: string;
  city: string;
  address?: string;
  source: SourceId;
  preferredChannel?: SourceId;
  tags: string[];
  notes?: string;
  createdAt: string;
  ordersCount?: number;
  activeCount?: number;
  lastOrderAt?: string;
  /** Данные удалены по запросу клиента: карточка обезличена, телефона нет. */
  anonymizedAt?: string;
}

export interface AiSummary {
  summary: string;
  extracted: { label: string; value: string }[];
  questions: string[];
}

export interface Lead {
  id: string;
  tenantId: string;
  number: number;
  clientId: string;
  /** Копия имени и телефона клиента — чтобы списки не тянули карточки клиентов. */
  clientName: string;
  clientPhone: string;
  source: SourceId;
  serviceId: string;
  city: string;
  description: string;
  urgency: Urgency;
  status: LeadStatus;
  /** Кто ведёт заявку; пустая строка — заявку из канала ещё никто не взял в работу. */
  operatorId: string;
  /** Кто завёл: нет — заявка заведена до учёта источника (считается заведённой оператором). */
  origin?: LeadOrigin;
  /** Первое действие сотрудника по заявке (взял в работу, правка, этап, заказ) — для сроков реакции. */
  firstActionAt?: string;
  createdAt: string;
  orderId?: string;
  comment?: string;
  rejectReason?: string;
  /** AI-разбор звонка или сообщения. */
  ai?: AiSummary;
  callId?: string;
  /** Адрес из обращения — переходит в заказ (мастеру — только после подтверждения). */
  address?: string;
  /** Когда клиенту удобно — как он сказал: «завтра после 18:00». */
  preferredTime?: string;
  /** Бюджет, который назвал клиент, ₸ — только для сотрудников, в цену заказа сам не попадает. */
  budget?: number;
}

export type CallStatus = "ringing" | "answered" | "missed" | "completed";
export type AiStatus = "pending" | "done" | "failed" | "none";

/** Что AI понял из звонка/сообщения — для заполнения заявки. */
export interface AiDraft {
  serviceId?: string;
  city?: string;
  address?: string;
  urgency?: Urgency;
  clientName?: string;
  description?: string;
  /** Когда клиенту удобно — как он сказал. */
  when?: string;
  /** Бюджет клиента, ₸ — только для сотрудников. */
  budget?: number;
}

export interface Call {
  id: string;
  direction: "in" | "out";
  from: string;
  to: string;
  clientId?: string;
  clientName?: string;
  leadId?: string;
  operatorId?: string;
  status: CallStatus;
  startedAt: string;
  endedAt?: string;
  duration?: number;
  hasRecording: boolean;
  recordingSrc?: string;
  transcript?: string;
  ai?: AiSummary;
  draft?: AiDraft;
  aiStatus?: AiStatus;
  aiError?: string;
}

export interface Payment {
  id: string;
  amount: number;
  method: PaymentMethod;
  /** Дата оплаты (может быть задним числом). */
  at: string;
  /** Кто внёс. */
  by?: string;
  note?: string;
  /** Сторно: платёж ошибочный — в оплаченную сумму не входит. */
  voidedAt?: string;
  voidedBy?: string;
  voidReason?: string;
}

/** Возврат денег клиенту. */
export interface Refund {
  id: string;
  amount: number;
  method: PaymentMethod;
  at: string;
  reason: string;
  by: string;
}

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  /** Ссылка на файл: подписанная, живёт 15 минут — экраны получают свежую вместе с данными (src/data/files.ts). */
  src?: string;
  /** Файл заказа виден мастеру: из переписки с ним, его фотоотчёт или отмечен «Показать мастеру». */
  forExecutor?: boolean;
}

export interface Order {
  id: string;
  tenantId: string;
  number: number;
  clientId: string;
  clientName: string;
  clientPhone: string;
  leadId?: string;
  source: SourceId;
  serviceId: string;
  category: CategoryId;
  description: string;
  city: string;
  address: string;
  deadline: string;
  priority: Urgency;
  status: OrderStatus;
  /** Финансы — отдельными полями (ТЗ п.13, п.28). Маржа не хранится, а считается. */
  clientPrice: number;
  payoutMode: "fixed" | "percent";
  payoutValue: number;
  payments: Payment[];
  refunds?: Refund[];
  payoutPaid: boolean;
  /** Выплата проведена по реестру выплат: когда. */
  payoutPaidAt?: string;
  payoutId?: string;
  /** Выплата, на которую исполнитель согласился, когда взял или подтвердил заказ. */
  acceptedPayout?: number;
  executorId?: string;
  assignedAt?: string;
  createdAt: string;
  createdBy: string;
  doneAt?: string;
  paidAt?: string;
  closedAt?: string;
  cancelReason?: string;
  /** Навыки, без которых заказ мастеру не показывается. */
  requiredSkills?: string[];
  files: Attachment[];
}

/** Заказ глазами исполнителя: без цены клиента и маржи; адрес и контакты — после подтверждения. */
export interface WorkerOrder {
  id: string;
  number: number;
  serviceId: string;
  category: CategoryId;
  description: string;
  city: string;
  deadline: string;
  priority: Urgency;
  status: OrderStatus;
  createdAt: string;
  assignedAt?: string;
  doneAt?: string;
  cancelReason?: string;
  payout: number;
  payoutPaid: boolean;
  address?: string;
  clientName?: string;
  clientPhone?: string;
  /** Навыки, которые нужны для заказа (мастер видит заказ, только если они у него есть). */
  requiredSkills?: string[];
  files: Attachment[];
}

export type Actor = { type: "user"; id: string } | { type: "client"; id: string } | { type: "system" };

/** internal — видит только команда, client — переписка по клиенту (мастеру не видна), executor — команда ↔ мастер. */
export type MessageChannel = "internal" | "client" | "executor";

export interface Message {
  id: string;
  orderId: string;
  author: Actor;
  channel: MessageChannel;
  text: string;
  files: Attachment[];
  at: string;
}

export type HistoryKind =
  | "created"
  | "status"
  | "assigned"
  | "taken"
  | "comment"
  | "file"
  | "finance"
  | "payment"
  | "edited"
  | "published";

export interface HistoryEvent {
  id: string;
  orderId: string;
  kind: HistoryKind;
  text: string;
  actor: Actor;
  at: string;
  /** Смена статуса: откуда и куда. */
  from?: OrderStatus;
  to?: OrderStatus;
}

export interface Executor {
  id: string;
  tenantId: string;
  name: string;
  phone: string;
  city: string;
  categories: CategoryId[];
  skills: string[];
  /** false — выходной/недоступен. Занятость считается по заказам автоматически. */
  available: boolean;
  /** Недоступен до этого момента — потом снова на смене сам (ТЗ п.14). */
  unavailableUntil?: string;
  unavailableReason?: string;
  /** Сколько заказов в работе одновременно; не задано — по умолчанию (DEFAULT_MAX_ACTIVE). */
  maxActiveOrders?: number;
  rating: number;
  reviews: number;
  cooperation: "freelance" | "staff";
  joinedAt: string;
}

export interface Interaction {
  id: string;
  clientId: string;
  kind: "lead" | "call" | "message";
  channel: SourceId;
  title: string;
  text: string;
  at: string;
  leadId?: string;
}

export interface ClientNote {
  id: string;
  clientId: string;
  authorId: string;
  text: string;
  at: string;
}

export interface Notification {
  id: string;
  userId: string;
  text: string;
  link?: string;
  at: string;
  read: boolean;
  tone: "info" | "ok" | "warn" | "bad";
}

export interface DB {
  version: number;
  anchor: string;
  seq: number;
  users: User[];
  clients: Client[];
  leads: Lead[];
  orders: Order[];
  messages: Message[];
  history: HistoryEvent[];
  executors: Executor[];
  interactions: Interaction[];
  clientNotes: ClientNote[];
  notifications: Notification[];
}

// ── Каналы, журнал действий, отзывы ──────────────────────────────────────────

/** Каналы переписки с клиентами в едином чате «Сообщения». */
export type Channel = "telegram" | "whatsapp" | "olx" | "site";

export type AuditEntity = "lead" | "order" | "client" | "executor" | "user" | "catalog" | "settings" | "integration" | "call" | "conversation" | "review" | "system" | "export";

/** Запись журнала действий. actorName — «Система», «AI», «OLX»… если действовал не человек. */
export interface AuditEntry {
  id: string;
  at: string;
  actorId?: string;
  actorName: string;
  actorRole?: string;
  action: string;
  entity: AuditEntity;
  entityId?: string;
  summary: string;
}

export interface Conversation {
  id: string;
  channel: Channel;
  contactName?: string;
  contactPhone?: string;
  clientId?: string;
  leadId?: string;
  subject?: string;
  subjectUrl?: string;
  lastMessageAt: string;
  lastText: string;
  lastDirection: "in" | "out";
  unread: number;
  status: "open" | "closed";
  assigneeId?: string;
  /** WhatsApp: до какого момента можно ответить свободным текстом (окно 24 часа). */
  replyUntil?: string;
}

export type MessageKind = "text" | "image" | "audio" | "file" | "location" | "system";
export type MessageStatus = "sending" | "sent" | "delivered" | "read" | "failed";

export interface ConversationMessage {
  id: string;
  conversationId: string;
  direction: "in" | "out";
  kind: MessageKind;
  text: string;
  at: string;
  authorId?: string;
  fileUrl?: string;
  fileName?: string;
  status?: MessageStatus;
  error?: string;
}

export type ReviewVia = "operator" | "link" | "telegram" | "whatsapp";

export interface Review {
  id: string;
  orderId: string;
  executorId: string;
  clientId: string;
  rating: number;
  text?: string;
  via: ReviewVia;
  at: string;
}

// ── Единый чат: фильтры и карточка диалога, черновик заявки, ключи API ──────

/** Фильтр списка диалогов: открытые (все, непрочитанные, мои, по каналу) или архив закрытых. */
export type InboxFilter = "all" | "unread" | "mine" | "closed" | Channel;

export interface ConversationDetail {
  conversation: Conversation;
  /** Последние сообщения, старые — сверху. */
  messages: ConversationMessage[];
  /** Есть сообщения раньше показанных. */
  hasMore: boolean;
  /** Почему нельзя ответить в канал (форма сайта, канал не подключён, окно WhatsApp). Нет — можно. */
  replyBlock?: string;
  lead?: { id: string; number: number; status: LeadStatus; orderId?: string };
  client?: { id: string; name: string; phone: string; city: string };
  /** @username клиента в Telegram — для ссылки t.me. */
  telegramUsername?: string;
}

/** Черновик заявки из переписки: что подставить в форму (AI-разбор, если AI подключён). */
export interface ConversationDraft {
  channel: Channel;
  phone?: string;
  name?: string;
  /** Последние сообщения клиента одним текстом. */
  text: string;
  ai?: AiSummary;
  draft: AiDraft;
}

/** Ключ публичного API в списке владельца. Сам ключ показывается один раз при создании, здесь — только начало. */
export interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  createdBy?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

/** Карточка «WhatsApp» у владельца: что настроено и доходят ли вебхуки. Значений секретов здесь нет — только имена недостающих переменных. */
export interface WhatsAppSettings {
  configured: boolean;
  /** Обязательные переменные окружения Convex, которые не заданы. */
  missing: string[];
  /** Callback URL для Meta: …convex.site/whatsapp/webhook. */
  webhookUrl: string | null;
  /** Verify token: не задан, слишком короткий или задан (тогда — последние 4 символа, чтобы сверить с Meta). */
  verifyToken: { state: "missing" | "short" | "ok"; end?: string };
  graphVersion: string;
  /** Номер компании в WhatsApp — из последнего вебхука. */
  businessPhone?: string;
  lastWebhookAt?: string;
  health?: { okAt?: string; okNote?: string; errorAt?: string; error?: string };
}

/** Карточка «OLX» владельца: настройка, подключение аккаунта, синхронизация. Токены сюда не попадают. */
export interface OlxSettings {
  /** Заданы OLX_CLIENT_ID и OLX_CLIENT_SECRET — можно подключать. */
  configured: boolean;
  /** Переменные окружения Convex, которые не заданы. */
  missing: string[];
  /** Нет (или неверный) ключ шифрования токенов INTEGRATIONS_KEY — подключать нельзя, синхронизация стоит. */
  keyIssue?: string;
  /** Адрес возврата, зарегистрированный в приложении OLX: …convex.site/olx/callback. */
  callbackUrl: string | null;
  /** error — доступ истёк или отозван, нужно подключить заново. */
  status: "disconnected" | "connected" | "error";
  accountId?: string;
  /** Имя и email аккаунта OLX — сверить, что подключён аккаунт компании. */
  accountName?: string;
  connectedAt?: string;
  connectedBy?: string;
  lastSyncAt?: string;
  lastError?: string;
  /** OLX ограничил запросы — синхронизация на паузе до этого времени. */
  pausedUntil?: string;
}

// ── Выплаты исполнителям (реестр) ────────────────────────────────────────────

/** Строка реестра выплат для владельца. */
export interface PayoutEntry {
  id: string;
  executorId: string;
  executorName: string;
  orders: { id: string; number: number }[];
  amount: number;
  method: PaymentMethod;
  /** Дата выплаты. */
  at: string;
  byName: string;
  note?: string;
  /** Когда провели. */
  createdAt: string;
  /** Отменить ещё можно: с проведения прошло меньше суток. */
  canUndo: boolean;
}

/** Выполненный заказ, выплата за который мастеру ещё не проведена. */
export interface OwedOrder {
  id: string;
  number: number;
  serviceId: string;
  status: OrderStatus;
  doneAt?: string;
  payout: number;
  /** Клиент оплатил заказ полностью. */
  clientPaid: boolean;
}

/** Сколько компания должна мастеру и за какие заказы. */
export interface OwedExecutor {
  executorId: string;
  name: string;
  amount: number;
  orders: OwedOrder[];
}

/** Выплата глазами исполнителя: дата, сумма, способ и заказы — без комментариев офиса. */
export interface WorkerPayout {
  id: string;
  at: string;
  amount: number;
  method: PaymentMethod;
  orders: { id: string; number: number }[];
}
