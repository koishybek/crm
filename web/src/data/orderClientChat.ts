// Переписка с клиентом из карточки заказа (ТЗ п.9.12, п.16.2): сообщение уходит клиенту в его мессенджер, ответы
// клиента видны в заказе. Типы — общие с сервером (convex/orderClientChat.ts); действие — src/data/orderClientActions.ts.
import type { Channel, MessageKind, MessageStatus } from "./types";

/** Написать клиенту некуда: ни Telegram, ни WhatsApp в 24-часовом окне, ни треда OLX. */
export const NO_CHANNEL = "Клиент не на связи в мессенджерах — позвоните";

export interface OrderClientMessage {
  id: string;
  conversationId: string;
  channel: Channel;
  direction: "in" | "out";
  kind: MessageKind;
  text: string;
  at: string;
  /** Кто ответил клиенту (сотрудник); автоматические сообщения — без автора. */
  authorName?: string;
  /** Имя клиента в канале — подпись входящих. */
  contactName?: string;
  status?: MessageStatus;
  error?: string;
  fileUrl?: string;
  fileName?: string;
}

export interface OrderClientThread {
  /** Куда уйдёт сообщение сейчас; null — написать некуда. */
  target: { conversationId: string; channel: Channel } | null;
  /** Почему написать некуда — подсказка под полем ввода. */
  blocked?: string;
  /** Диалог для «Открыть диалог»: куда пишем, иначе последний диалог клиента. */
  dialogId?: string;
  /** Переписка с клиентом за период заказа — старые сверху. */
  messages: OrderClientMessage[];
}

/** sent — сообщение поставлено в отправку клиенту (итог доставки — в ленте); иначе — сохранено заметкой, reason — почему. */
export type OrderClientSend = { sent: true; channel: Channel } | { sent: false; reason: string };
