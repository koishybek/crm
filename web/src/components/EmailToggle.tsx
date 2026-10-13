// «Дублировать на email» в меню профиля сотрудника (ТЗ п.18): копии важных уведомлений на email из логина.
import { useQuery } from "convex/react";
import { Mail } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { setNotifyEmail } from "../data/notifyActions";
import { report } from "../data/store";
import { cn } from "../lib/format";

export function EmailToggle() {
  const s = useQuery(api.email.mine);
  const [busy, setBusy] = useState(false);
  if (!s) return null;
  // Выключить можно всегда; включить — когда есть куда и чем отправлять.
  const disabled = busy || (!s.on && (!s.canUse || !s.configured));
  const hint = !s.canUse ? "Вы входите по телефону — письма некуда отправлять" : !s.configured ? "Владелец ещё не настроил отправку писем" : "Только важное: заявки, просрочки, оплаты, оценки";
  const toggle = async () => {
    setBusy(true);
    report(await setNotifyEmail(!s.on), s.on ? "Копии на email выключены" : "Важные уведомления будут приходить и на email");
    setBusy(false);
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={s.on}
      disabled={disabled}
      onClick={() => void toggle()}
      className="flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-[14px] font-medium text-ink-2 transition-colors hover:bg-[#f7f4ec] disabled:opacity-45"
    >
      <Mail size={17} strokeWidth={1.9} aria-hidden className="text-muted" />
      <span className="min-w-0 flex-1">
        Дублировать на email
        <span className="block text-[12px] font-normal text-muted">{hint}</span>
      </span>
      <span aria-hidden className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", s.on ? "bg-ok" : "bg-line-strong")}>
        <span className={cn("absolute top-0.5 left-0 h-4 w-4 rounded-full bg-white shadow transition-transform", s.on ? "translate-x-[18px]" : "translate-x-0.5")} />
      </span>
    </button>
  );
}
