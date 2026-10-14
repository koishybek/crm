// Сообщение клиенту из карточки заказа (ТЗ п.9.12): уходит в его мессенджер или остаётся заметкой, если писать некуда.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run } from "./convex";

export const sendToOrderClient = (orderId: string, text: string) => run(convex.mutation(api.orderClientChat.send, { orderId: orderId as Id<"orders">, text }));
