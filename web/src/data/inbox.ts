// «Сообщения»: действия оператора → функции Convex (Result для тостов), бейдж непрочитанных и черновик заявки из чата.
import { useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { SOURCES } from "./catalog";
import { convex, run } from "./convex";
import { can } from "./permissions";
import { report } from "./store";
import type { Channel, ConversationDraft, User } from "./types";

const cid = (id: string) => id as Id<"conversations">;

export const CHANNELS: Channel[] = ["telegram", "whatsapp", "olx", "site"];
export const channelLabel = (c: Channel): string => SOURCES[c].label;

/** «Сообщения» видят владелец и операторы; руководитель направления и мастера — нет. */
/** Сообщения клиентов — по праву «Сообщения клиентов» (ТЗ п.5.12; по умолчанию владелец и операторы). */
export const canUseInbox = (u: Pick<User, "role" | "permissions"> | null | undefined): boolean => can(u, "inbox.view");

/** Сколько диалогов ждут ответа — бейдж в меню. У остальных ролей запрос не отправляется. */
export function useInboxUnread(me: User | null | undefined): number {
  return useQuery(api.inbox.unreadCount, canUseInbox(me) ? {} : "skip") ?? 0;
}

export const markConversationRead = (id: string) => run(convex.mutation(api.inbox.markRead, { id: cid(id) }));
export const sendReply = (id: string, text: string) => run(convex.mutation(api.inbox.reply, { conversationId: cid(id), text }));
export const resendReply = (messageId: string) => run(convex.mutation(api.inbox.resend, { messageId: messageId as Id<"conversationMessages"> }));
export const closeConversation = (id: string) => run(convex.mutation(api.inbox.close, { id: cid(id) }));
export const reopenConversation = (id: string) => run(convex.mutation(api.inbox.reopen, { id: cid(id) }));
export const assignConversation = (id: string, userId?: string) => run(convex.mutation(api.inbox.assign, { id: cid(id), userId: userId as Id<"users"> | undefined }));
export const linkConversationClient = (id: string, clientId: string) => run(convex.mutation(api.inbox.linkClient, { id: cid(id), clientId: clientId as Id<"clients"> }));
export const linkConversationLead = (id: string, leadId: string) => run(convex.mutation(api.inbox.linkLead, { id: cid(id), leadId: leadId as Id<"leads"> }));
export const conversationDraft = (id: string) => run(convex.action(api.inbox.draftFromConversation, { id: cid(id) }));

/**
 * Заявка из «Сообщений»: один раз при открытии формы просим черновик (номер, имя, разбор переписки AI)
 * и отдаём его форме. Возвращает true, пока черновик готовится.
 */
export function useConversationDraft(conversationId: string | undefined, onDraft: (d: ConversationDraft) => void): boolean {
  const [busy, setBusy] = useState(!!conversationId);
  const latest = useRef(onDraft);
  useEffect(() => {
    latest.current = onDraft;
  });
  useEffect(() => {
    if (!conversationId) return;
    let alive = true;
    setBusy(true);
    void conversationDraft(conversationId).then((r) => {
      if (!alive) return;
      setBusy(false);
      if (report(r)) latest.current(r.value);
    });
    return () => {
      alive = false;
    };
  }, [conversationId]);
  return busy;
}

/** Неотправленный текст ответа — по диалогу, пока открыта вкладка (переключились на другой чат и вернулись). */
const drafts = new Map<string, string>();
export const replyDraft = {
  get: (id: string): string => drafts.get(id) ?? "",
  set: (id: string, text: string): void => {
    if (text) drafts.set(id, text);
    else drafts.delete(id);
  },
};
