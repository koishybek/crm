// Модель данных прототипа. Повторяет сущности ТЗ и в будущем станет формой ответов REST API.
// tenantId есть на всех сущностях с первого дня — задел под SaaS-мультиаккаунт (ТЗ п.28).

export type Role = "owner" | "operator" | "manager" | "executor";

export type SourceId = "olx" | "phone" | "whatsapp" | "telegram" | "site" | "instagram" | "referral";

/** Ключ направления. Справочник направлений живёт в базе (Настройки → Услуги). */
export type CategoryId = string;

export type Urgency = "normal" | "high" | "urgent";

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
  operatorId: string;
  createdAt: string;
  orderId?: string;
  comment?: string;
  rejectReason?: string;
  /** AI-разбор звонка или сообщения. */
  ai?: AiSummary;
  callId?: string;
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
  at: string;
}

export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  /** Уменьшенное превью (dataURL) для загруженных в прототипе картинок. */
  src?: string;
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
  payoutPaid: boolean;
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
  files: Attachment[];
}

export type Actor = { type: "user"; id: string } | { type: "client"; id: string } | { type: "system" };

export interface Message {
  id: string;
  orderId: string;
  author: Actor;
  /** internal — видит только команда, client — переписка с клиентом. */
  channel: "internal" | "client";
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

export type AuditEntity = "lead" | "order" | "client" | "executor" | "user" | "catalog" | "settings" | "integration" | "call" | "conversation" | "review" | "system";

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
