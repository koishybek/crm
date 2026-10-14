// «Позвонить через АТС» (ТЗ п.19.1) — одна кнопка для карточки клиента, заявки и заказа. АТС подключена и у сотрудника
// есть внутренний номер — АТС звонит ему и соединяет с клиентом; иначе (или если АТС отказала) — обычный звонок tel:.
import { useQuery } from "convex/react";
import { PhoneCall, PhoneOutgoing } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { dialViaPbx, type DialContext } from "../data/adapterActions";
import { useMe } from "../data/hooks";
import { report, toast } from "../data/store";
import { PBX_INFO } from "../data/pbx";
import { cn } from "../lib/format";
import { Button } from "./ui";

interface PbxCallButtonProps extends DialContext {
  phone: string;
  size?: "sm" | "md";
  /** Только иконка (в узких шапках) — с подписью для экранного диктора. */
  compact?: boolean;
  className?: string;
}

export function PbxCallButton({ phone, size = "sm", compact, className, ...context }: PbxCallButtonProps) {
  const me = useMe();
  const staff = me?.role === "owner" || me?.role === "operator";
  const state = useQuery(api.pbx.dialState, staff ? {} : "skip");
  const [busy, setBusy] = useState(false);
  if (!/^7\d{10}$/.test(phone)) return null;
  // Руководителю направления АТС не положена — как раньше, звонок с телефона.
  if (!staff)
    return compact ? (
      <a href={`tel:+${phone}`} aria-label="Позвонить" className={cn("inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-ok-bg text-ok-ink", className)}>
        <PhoneCall size={18} aria-hidden />
      </a>
    ) : null;
  const enabled = !!state?.enabled;
  const label = enabled ? "Позвонить через АТС" : "Позвонить";

  const call = async () => {
    if (!enabled) {
      window.location.assign(`tel:+${phone}`);
      return;
    }
    setBusy(true);
    const r = await dialViaPbx(phone, context);
    setBusy(false);
    if (!report(r)) return;
    if (r.value.mode === "pbx") return toast(`${PBX_INFO[r.value.provider].label}: АТС звонит вам — возьмите трубку, затем соединит с клиентом`, "info");
    toast(r.value.reason, "info");
    window.location.assign(r.value.href);
  };

  if (compact)
    return (
      <button
        type="button"
        onClick={() => void call()}
        disabled={busy}
        aria-label={`${label}: +${phone}`}
        title={enabled ? label : (state?.reason ?? label)}
        className={cn("inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-ok-bg text-ok-ink hover:bg-ok hover:text-white disabled:opacity-50", className)}
      >
        {enabled ? <PhoneOutgoing size={18} aria-hidden /> : <PhoneCall size={18} aria-hidden />}
      </button>
    );
  return (
    <Button size={size} variant="secondary" icon={enabled ? PhoneOutgoing : PhoneCall} disabled={busy} onClick={() => void call()} title={enabled ? undefined : state?.reason} className={className}>
      {busy ? "Соединяем…" : label}
    </Button>
  );
}
