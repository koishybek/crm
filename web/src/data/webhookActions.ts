// Исходящие вебхуки (ТЗ п.20.7): подписки владельца, тестовое событие. Секрет подписи приходит один раз — при создании.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run } from "./convex";
import type { WebhookEvent } from "./webhookEvents";

const wid = (id: string) => id as Id<"webhooks">;

export const createWebhook = (url: string, events: WebhookEvent[], description?: string) => run(convex.action(api.webhooks.create, { url, events, description }));
export const setWebhookActive = (id: string, active: boolean) => run(convex.mutation(api.webhooks.update, { id: wid(id), active }));
export const setWebhookEvents = (id: string, events: WebhookEvent[]) => run(convex.mutation(api.webhooks.update, { id: wid(id), events }));
export const removeWebhook = (id: string) => run(convex.mutation(api.webhooks.remove, { id: wid(id) }));
export const sendWebhookTest = (id: string) => run(convex.mutation(api.webhooks.sendTest, { id: wid(id) }));
