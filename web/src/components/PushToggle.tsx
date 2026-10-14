// «Уведомления на телефон» (web push, ТЗ п.23.6): переключатель в меню профиля сотрудника и в профиле мастера.
// Скрыт, пока владелец не задал ключи VAPID (scripts/setup-vapid.mjs).
import { BellRing } from "lucide-react";
import { useState } from "react";
import { disablePush, enablePush, pushAvailability, usePushState, type PushAvailability } from "../data/pushActions";
import { report } from "../data/store";
import { cn } from "../lib/format";

const BLOCKED: Record<Exclude<PushAvailability, "ok">, string> = {
  unsupported: "Этот браузер не умеет уведомления — откройте приложение в Chrome, Safari или Edge",
  "ios-install": "На iPhone — сначала «Поделиться → На экран „Домой“», затем включите здесь",
  denied: "Уведомления запрещены — разрешите их в настройках браузера для этого сайта",
};

export function PushToggle({ variant = "menu" }: { variant?: "menu" | "worker" }) {
  const { state, refresh } = usePushState();
  const [busy, setBusy] = useState(false);
  if (!state?.configured || !state.publicKey) return null;
  const on = state.subscribed;
  const availability = pushAvailability();
  const disabled = busy || (!on && availability !== "ok");
  const hint = !on && availability !== "ok" ? BLOCKED[availability] : on ? "Новые заказы и сообщения — сразу на экран" : "Включить — новые заказы и сообщения придут на экран телефона";
  const toggle = async () => {
    setBusy(true);
    report(on ? await disablePush() : await enablePush(state.publicKey!), on ? "Уведомления на телефон выключены" : "Уведомления на телефон включены");
    refresh();
    setBusy(false);
  };
  const knob = (
    <span aria-hidden className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-ok" : "bg-line-strong")}>
      <span className={cn("absolute top-0.5 left-0 h-4 w-4 rounded-full bg-white shadow transition-transform", on ? "translate-x-[18px]" : "translate-x-0.5")} />
    </span>
  );
  if (variant === "worker") {
    return (
      <button type="button" role="switch" aria-checked={on} disabled={disabled} onClick={() => void toggle()} className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left active:bg-[#faf8f3] disabled:opacity-50">
        <BellRing size={22} className="shrink-0 text-ink-2" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-medium text-ink">Уведомления на телефон</span>
          <span className="block text-[14px] text-[#6b675f]">{hint}</span>
        </span>
        {knob}
      </button>
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => void toggle()}
      className="flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-[14px] font-medium text-ink-2 transition-colors hover:bg-[#f7f4ec] disabled:opacity-45"
    >
      <BellRing size={17} strokeWidth={1.9} aria-hidden className="text-muted" />
      <span className="min-w-0 flex-1">
        Уведомления на телефон
        <span className="block text-[12px] font-normal text-muted">{hint}</span>
      </span>
      {knob}
    </button>
  );
}
