// «Принимаю заказы»: плашка в шапке и большой переключатель в профиле (как «На линии» в Яндекс Про).
// Включение — сразу, выключение — через подтверждение: случайно «уйти с линии» дорого. Выключить можно «пока не
// включу», до завтрашнего утра или до даты (ТЗ п.14): в это время приём включится сам. Время — по Алматы.
import { Check, Gauge, Moon, Power } from "lucide-react";
import { useState } from "react";
import { setMyShift } from "../../data/operationsActions";
import { toast } from "../../data/store";
import { almatyDayKey, almatyDayStart, ALMATY_OFFSET_MS, DAY_MS, whenLabel } from "../../data/workerTime";
import { cn, plural } from "../../lib/format";
import { MUTED, WButton, useBusy, busyLabel } from "./kit";
import { useNet } from "./net";
import { Sheet } from "./Sheet";

type Until = "manual" | "tomorrow" | "date";
const HOUR_MS = 3600_000;
/** Возвращение на смену — в 9:00 по Алматы выбранного дня. */
const nineAm = (dayStart: number) => new Date(dayStart + 9 * HOUR_MS).toISOString();
/** «2026-10-20» (поле даты) → полночь этого дня по Алматы, UTC-мс. */
const dayFromKey = (key: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - ALMATY_OFFSET_MS : null;
};

/** «Не принимаю до 20 окт., 09:00» и т. п. */
const untilText = (until: string) => whenLabel(until).replace(/^./, (c) => c.toLowerCase());

/** Переключение приёма: включить сразу, выключить — после «Перестать принимать заказы?» с выбором срока. */
export function useAvailability(available: boolean) {
  const [asking, setAsking] = useState(false);
  const [mode, setMode] = useState<Until>("manual");
  const [date, setDate] = useState(() => almatyDayKey(Date.now() + 2 * DAY_MS));
  const { busy, slow, run } = useBusy();
  const offline = useNet((s) => s.offline);

  const set = async (on: boolean) => {
    let until: string | undefined;
    if (!on && mode === "tomorrow") until = nineAm(almatyDayStart(Date.now()) + DAY_MS);
    if (!on && mode === "date") {
      const day = dayFromKey(date);
      if (day === null || day <= almatyDayStart(Date.now())) return toast("Выберите дату не раньше завтрашней", "bad");
      until = nineAm(day);
    }
    const r = await run(() => setMyShift({ available: on, until }));
    if (!r.ok) return toast(offline ? "Нет связи с сервером — проверьте интернет" : r.error, "bad");
    setAsking(false);
    toast(on ? "Вы принимаете заказы" : until ? `Приём выключен до ${untilText(until)}` : "Приём заказов выключен", on ? "ok" : "info");
  };

  const toggle = () => {
    if (busy) return;
    if (offline) return toast("Нет связи с сервером — проверьте интернет", "bad");
    if (available) {
      setMode("manual");
      setAsking(true);
    } else void set(true);
  };

  const option = (value: Until, label: string, hint?: string) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === value}
      onClick={() => setMode(value)}
      className={cn("flex min-h-14 w-full items-center justify-between gap-3 rounded-[12px] px-3 text-left text-[16px]", mode === value ? "bg-[#faf8f3] font-semibold text-ink" : "text-ink-2")}
    >
      <span className="min-w-0">
        {label}
        {hint && <span className={cn("block text-[14px] font-normal", MUTED)}>{hint}</span>}
      </span>
      {mode === value && <Check size={20} className="shrink-0" aria-hidden />}
    </button>
  );

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
      <div className="mt-3 flex flex-col gap-1" role="radiogroup" aria-label="До какого времени">
        {option("manual", "Пока не включу сам")}
        {option("tomorrow", "До завтра, 9:00", "Утром приём включится сам")}
        {option("date", "До даты", "Например, отпуск — в 9:00 этого дня приём включится сам")}
      </div>
      {mode === "date" && (
        <label className="mt-2 block text-[15px] text-ink-2">
          Вернусь
          <input
            type="date"
            value={date}
            min={almatyDayKey(Date.now() + DAY_MS)}
            max={almatyDayKey(Date.now() + 90 * DAY_MS)}
            onChange={(e) => setDate(e.target.value)}
            className="mt-1 block w-full rounded-[12px] border border-[#cfc9bc] bg-white px-3.5 py-3 text-[16px] text-ink focus:border-[#e9b400] focus:outline-none"
          />
        </label>
      )}
    </Sheet>
  );

  return { toggle, busy, sheet };
}

/** Плашка в шапке: зелёная «Принимаю заказы» или серая «Не принимаю» (с датой возвращения). Цель нажатия — 48 px. */
export function AvailabilityPill({ available, until }: { available: boolean; until?: string }) {
  const a = useAvailability(available);
  const off = until ? `Не принимаю до ${untilText(until)}` : "Не принимаю";
  return (
    <>
      <button
        type="button"
        onClick={a.toggle}
        aria-pressed={available}
        aria-label={available ? "Принимаю заказы. Нажмите, чтобы выключить приём" : `${off}. Нажмите, чтобы включить приём`}
        className="inline-flex h-12 min-w-0 items-center"
      >
        <span
          className={cn(
            "inline-flex h-9 min-w-0 items-center gap-2 rounded-full border px-3.5 text-[14px] font-semibold whitespace-nowrap",
            available ? "border-transparent bg-ok-bg text-[#067a46]" : "border-[#8f897e] bg-slate-bg text-[#6b675f]",
            a.busy && "opacity-70",
          )}
        >
          <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", available ? "bg-[#067a46]" : "border-2 border-[#8f897e]")} aria-hidden />
          <span className="truncate">{available ? "Принимаю заказы" : off}</span>
        </span>
      </button>
      {a.sheet}
    </>
  );
}

/** Большой переключатель в профиле: вся строка — одна кнопка role="switch". */
export function AvailabilitySwitch({ available, until, reason }: { available: boolean; until?: string; reason?: string }) {
  const a = useAvailability(available);
  const offText = until ? `До ${untilText(until)} — потом приём включится сам${reason ? `. ${reason}` : ""}` : "Новые заказы не приходят. Текущие остаются у вас";
  return (
    <>
      <button type="button" role="switch" aria-checked={available} onClick={a.toggle} className="card flex min-h-[76px] w-full items-center gap-3.5 p-4 text-left active:bg-[#faf8f3]">
        <span className={cn("inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full", available ? "bg-ok-bg text-[#067a46]" : "bg-slate-bg text-[#6b675f]")}>
          <Power size={22} strokeWidth={2.2} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold text-ink">{available ? "Принимаю заказы" : "Не принимаю заказы"}</span>
          <span className={cn("block text-[14px]", MUTED)}>{available ? "Новые заказы приходят сюда и в Telegram" : offText}</span>
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

/** Тёмная карточка над лентой, пока приём выключен. Недоступен до даты — когда приём включится сам. */
export function OffShiftCard({ until, reason }: { until?: string; reason?: string }) {
  const a = useAvailability(false);
  return (
    <section className="rounded-[16px] bg-side p-4 text-white">
      <div className="flex items-start gap-3">
        <Moon size={24} className="mt-0.5 shrink-0 text-brand" aria-hidden />
        <div className="min-w-0">
          <h2 className="text-[18px] font-semibold">{until ? `Вы не принимаете заказы до ${untilText(until)}` : "Вы не принимаете заказы"}</h2>
          <p className="mt-1 text-[15px] text-[#c9c4b8]">
            {until ? `Потом приём включится сам.${reason ? ` ${reason}.` : ""} ` : ""}Пока приём выключен, новые заказы не приходят ни сюда, ни в Telegram, а взять заказ нельзя.
          </p>
        </div>
      </div>
      <WButton size="lg" full className="mt-4" busy={a.busy} busyText="Включаем…" onClick={a.toggle}>
        Начать принимать заказы
      </WButton>
    </section>
  );
}

/** Над лентой, когда у мастера столько заказов в работе, сколько можно держать одновременно (ТЗ п.14). */
export function LimitCard({ active, max }: { active: number; max: number }) {
  return (
    <section className="card flex items-start gap-3 border-l-4 border-l-brand p-4">
      <Gauge size={24} className="mt-0.5 shrink-0 text-ink-2" aria-hidden />
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold text-ink">
          У вас {active} {plural(active, "заказ", "заказа", "заказов")} в работе — это ваш лимит
        </h2>
        <p className={cn("mt-1 text-[15px]", MUTED)}>Новые заказы видно, но взять их можно, когда сдадите текущий. Нужно больше — попросите офис увеличить лимит ({max}).</p>
      </div>
    </section>
  );
}
