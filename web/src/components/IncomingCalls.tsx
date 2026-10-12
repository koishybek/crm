import { useQuery } from "convex/react";
import { FileText, PhoneCall, PhoneIncoming, UserRound, X } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { ORDER_STATUS, serviceById } from "../data/catalog";
import { useNow, useUi } from "../data/hooks";
import { phone } from "../lib/format";

const HIDDEN_KEY = "sp.hiddenCalls";
function loadHidden(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const since = (iso: string, now: number) => {
  const s = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Входящий звонок от АТС: кто звонит, что у него в работе — и сразу «Новая заявка». */
export function IncomingCalls() {
  const now = useNow(1000);
  // Аргумент меняется раз в минуту — подписка не пересоздаётся каждую секунду.
  const live = useQuery(api.calls.live, { now: Math.floor(now / 60_000) * 60_000 });
  const nav = useNavigate();
  const ui = useUi();
  const [hidden, setHidden] = useState(loadHidden);

  const hide = (id: string) => {
    const next = [...hidden, id].slice(-50);
    setHidden(next);
    try {
      localStorage.setItem(HIDDEN_KEY, JSON.stringify(next));
    } catch {
      /* приватный режим — скрываем только до перезагрузки */
    }
  };

  const items = (live ?? []).filter((x) => !hidden.includes(x.call.id)).slice(-3);
  if (!items.length) return null;

  return (
    <div className="fixed right-4 bottom-24 z-40 flex w-[min(380px,calc(100vw-32px))] flex-col gap-3 md:right-6 md:bottom-6" aria-live="polite">
      {items.map(({ call, client, lastOrder }) => {
        const num = call.direction === "in" ? call.from : call.to;
        const ringing = call.status === "ringing";
        return (
          <section key={call.id} className="anim-pop overflow-hidden rounded-[18px] bg-side text-white shadow-[0_18px_44px_-12px_rgba(0,0,0,0.55)]" aria-label="Входящий звонок">
            <div className="flex items-center gap-3 px-4 pt-4">
              <span className="relative inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-brand text-on-brand">
                {ringing && <span className="absolute inset-0 animate-ping rounded-full bg-brand/60" aria-hidden />}
                {ringing ? <PhoneIncoming size={21} className="relative" aria-hidden /> : <PhoneCall size={21} aria-hidden />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-medium text-[#c9c5bb]">
                  {ringing ? "Входящий звонок" : "Идёт разговор"} · <span className="tabular-nums">{since(call.startedAt, now)}</span>
                </div>
                <div className="truncate text-[17px] font-semibold">{client?.name ?? "Новый номер"}</div>
              </div>
              <button onClick={() => hide(call.id)} aria-label="Скрыть карточку звонка" className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[#a9a59c] hover:bg-white/10 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="px-4 pt-1 pb-3 text-[13.5px] text-[#dedbd3]">
              {num ? phone(num) : "номер скрыт"}
              {client && ` · ${client.city}`}
              {client ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <span className="rounded-[7px] bg-white/10 px-2 py-0.5 text-[12px]">заказов: {client.ordersCount ?? 0}</span>
                  {(client.activeCount ?? 0) > 0 && <span className="rounded-[7px] bg-brand/20 px-2 py-0.5 text-[12px] text-brand">в работе: {client.activeCount}</span>}
                  {client.tags.slice(0, 2).map((t) => (
                    <span key={t} className="rounded-[7px] bg-white/10 px-2 py-0.5 text-[12px]">
                      {t}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="mt-1 text-[12.5px] text-[#a9a59c]">Клиента с таким номером в базе нет</div>
              )}
              {lastOrder && (
                <button onClick={() => nav(`/orders/${lastOrder.id}`)} className="mt-2 block w-full truncate rounded-[10px] bg-white/[0.06] px-3 py-2 text-left text-[12.5px] hover:bg-white/10">
                  Последний заказ №{lastOrder.number} · {serviceById(lastOrder.serviceId).label} · <span className="text-brand">{ORDER_STATUS[lastOrder.status].label}</span>
                </button>
              )}
            </div>
            <div className="flex gap-2 border-t border-white/10 px-4 py-3">
              {client && (
                <button onClick={() => nav(`/clients/${client.id}`)} className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-white/10 text-[13.5px] font-semibold hover:bg-white/15">
                  <UserRound size={16} aria-hidden /> Карточка
                </button>
              )}
              <button
                onClick={() => ui.openLead({ callId: call.id, phone: num, clientId: client?.id })}
                className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-brand text-[13.5px] font-semibold text-on-brand hover:bg-brand-hover"
              >
                <FileText size={16} aria-hidden /> Новая заявка
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
