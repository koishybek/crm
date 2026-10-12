import { useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { api } from "../../convex/_generated/api";
import type { Executor, User } from "./types";

/** Текущий пользователь: undefined — ещё грузится, null — не вошёл. */
export function useMe(): User | null | undefined {
  return useQuery(api.users.me);
}

/** Справочник команды для подписей (кто оператор, как зовут исполнителя). */
export function useTeam() {
  const t = useQuery(api.users.team);
  return useMemo(() => {
    const users = t?.users ?? [];
    const executors = t?.executors ?? [];
    return {
      loaded: t !== undefined,
      users,
      executors,
      userName: (id?: string) => users.find((u) => u.id === id)?.name ?? "",
      executor: (id?: string): Executor | undefined => executors.find((e) => e.id === id),
    };
  }, [t]);
}

/** «Сейчас», которое тикает раз в 30 секунд — для «Сегодня 12:24», просрочек и таймеров. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Глобальные дроверы — открываются из шапки, со страниц и из поиска. */
interface UiState {
  /** conversationId — заявка из «Сообщений»: форма заполняется по переписке, заявка связывается с диалогом. */
  lead: { open: boolean; mode: "lead" | "order"; leadId?: string; clientId?: string; callId?: string; phone?: string; conversationId?: string };
  client: { open: boolean; clientId?: string };
  executor: { open: boolean; executorId?: string };
  nav: boolean;
  openLead: (o?: { mode?: "lead" | "order"; leadId?: string; clientId?: string; callId?: string; phone?: string; conversationId?: string }) => void;
  closeLead: () => void;
  openClient: (clientId?: string) => void;
  closeClient: () => void;
  openExecutor: (executorId?: string) => void;
  closeExecutor: () => void;
  setNav: (v: boolean) => void;
}

export const useUi = create<UiState>()((set) => ({
  lead: { open: false, mode: "lead" },
  client: { open: false },
  executor: { open: false },
  nav: false,
  openLead: (o = {}) => set({ lead: { open: true, mode: o.mode ?? "lead", leadId: o.leadId, clientId: o.clientId, callId: o.callId, phone: o.phone, conversationId: o.conversationId } }),
  closeLead: () => set((s) => ({ lead: { ...s.lead, open: false } })),
  openClient: (clientId) => set({ client: { open: true, clientId } }),
  closeClient: () => set((s) => ({ client: { ...s.client, open: false } })),
  openExecutor: (executorId) => set({ executor: { open: true, executorId } }),
  closeExecutor: () => set((s) => ({ executor: { ...s.executor, open: false } })),
  setNav: (nav) => set({ nav }),
}));
