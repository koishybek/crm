// «Принимаю заказы»: плашка в шапке и большой переключатель в профиле (как «На линии» в Яндекс Про).
// Включение — сразу, выключение — через подтверждение: случайно «уйти с линии» дорого.
import { Moon, Power } from "lucide-react";
import { useState } from "react";
import { setMyAvailability, toast } from "../../data/store";
import { cn } from "../../lib/format";
import { MUTED, WButton, useBusy, busyLabel } from "./kit";
import { useNet } from "./net";
import { Sheet } from "./Sheet";

/** Переключение приёма: включить сразу, выключить — после «Перестать принимать заказы?». */
export function useAvailability(available: boolean) {
  const [asking, setAsking] = useState(false);
  const { busy, slow, run } = useBusy();
  const offline = useNet((s) => s.offline);

  const set = async (on: boolean) => {
    const r = await run(() => setMyAvailability(on));
    if (!r.ok) return toast(offline ? "Нет связи с сервером — проверьте интернет" : r.error, "bad");
    setAsking(false);
    toast(on ? "Вы принимаете заказы" : "Приём заказов выключен", on ? "ok" : "info");
  };

  const toggle = () => {
    if (busy) return;
    if (offline) return toast("Нет связи с сервером — проверьте интернет", "bad");
    if (available) setAsking(true);
    else void set(true);
  };

  const sheet = (
    <Sheet
      open={asking}
      onClose={() => setAsking(false)}
      locked={busy}
      title="Перестать принимать заказы?"
      footer={
        <>
          <WButton variant="ghost" full onClick={() => setAsking(false)} disabled={busy}>
            Отмена
          </WButton>
          <WButton size="lg" full busy={busy} busyText={busyLabel(slow, "Выключаем…")} onClick={() => void set(false)}>
            Не принимать заказы
          </WButton>
        </>
      }
    >
      <p className="text-[15.5px] text-ink-2">Новые заказы перестанут приходить сюда и в Telegram. Заказы, которые уже у вас, останутся.</p>
    </Sheet>
  );

  return { toggle, busy, sheet };
}

/** Плашка в шапке: зелёная «Принимаю заказы» или серая «Не принимаю». Цель нажатия — 48 px. */
export function AvailabilityPill({ available }: { available: boolean }) {
  const a = useAvailability(available);
  return (
    <>
      <button
        type="button"
        onClick={a.toggle}
        aria-pressed={available}
        aria-label={available ? "Принимаю заказы. Нажмите, чтобы выключить приём" : "Не принимаю заказы. Нажмите, чтобы включить приём"}
        className="inline-flex h-12 items-center"
      >
        <span
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-full border px-3.5 text-[14px] font-semibold whitespace-nowrap",
            available ? "border-transparent bg-ok-bg text-[#067a46]" : "border-[#8f897e] bg-slate-bg text-[#6b675f]",
            a.busy && "opacity-70",
          )}
        >
          <span className={cn("h-2.5 w-2.5 rounded-full", available ? "bg-[#067a46]" : "border-2 border-[#8f897e]")} aria-hidden />
          {available ? "Принимаю заказы" : "Не принимаю"}
        </span>
      </button>
      {a.sheet}
    </>
  );
}

/** Большой переключатель в профиле: вся строка — одна кнопка role="switch". */
export function AvailabilitySwitch({ available }: { available: boolean }) {
  const a = useAvailability(available);
  return (
    <>
      <button type="button" role="switch" aria-checked={available} onClick={a.toggle} className="card flex min-h-[76px] w-full items-center gap-3.5 p-4 text-left active:bg-[#faf8f3]">
        <span className={cn("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full", available ? "bg-ok-bg text-[#067a46]" : "bg-slate-bg text-[#6b675f]")}>
          <Power size={22} strokeWidth={2.2} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold text-ink">{available ? "Принимаю заказы" : "Не принимаю заказы"}</span>
          <span className={cn("block text-[14px]", MUTED)}>{available ? "Новые заказы приходят сюда и в Telegram" : "Новые заказы не приходят. Текущие остаются у вас"}</span>
        </span>
        <span className={cn("relative h-8 w-14 shrink-0 rounded-full border-2 transition-colors", available ? "border-[#067a46] bg-[#067a46]" : "border-[#8f897e] bg-white")} aria-hidden>
          <span
            className={cn(
              "absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full shadow transition-transform motion-reduce:transition-none",
              available ? "translate-x-[26px] bg-white" : "translate-x-[2px] bg-[#8f897e]",
            )}
          />
        </span>
      </button>
      {a.sheet}
    </>
  );
}

/** Тёмная карточка над лентой, пока приём выключен. */
export function OffShiftCard() {
  const a = useAvailability(false);
  return (
    <section className="rounded-[16px] bg-side p-4 text-white">
      <div className="flex items-start gap-3">
        <Moon size={24} className="mt-0.5 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold">Вы не принимаете заказы</h2>
          <p className="mt-1 text-[15px] text-[#c9c4b8]">Пока приём выключен, новые заказы не приходят ни сюда, ни в Telegram, а взять заказ нельзя.</p>
        </div>
      </div>
      <WButton size="lg" full className="mt-4" busy={a.busy} busyText="Включаем…" onClick={a.toggle}>
        Начать принимать заказы
      </WButton>
    </section>
  );
}
