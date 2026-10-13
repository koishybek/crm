// Карточка «Смена и загрузка» мастера для сотрудников (ТЗ п.14): на смене / выходной / недоступен до … с причиной
// (в назначенное время мастер сам вернётся на смену) и лимит заказов в работе — его меняет только владелец.
import { CalendarOff, Gauge } from "lucide-react";
import { useState } from "react";
import { useMe } from "../data/hooks";
import { DEFAULT_MAX_ACTIVE, maxActiveOf } from "../data/logic";
import { setExecutorLimit, setExecutorShift } from "../data/operationsActions";
import { report } from "../data/store";
import type { Executor } from "../data/types";
import { dateTime, toLocalInput } from "../lib/format";
import { Badge, Button, Card, FormRow, Input } from "./ui";

/** Завтра в 9:00 по часам браузера — частый ответ «когда вернётся». */
const tomorrowMorning = () => {
  const d = new Date(Date.now() + 86400_000);
  d.setHours(9, 0, 0, 0);
  return toLocalInput(d.toISOString());
};

export function ExecutorShiftCard({ e, className }: { e: Executor; className?: string }) {
  const me = useMe();
  const [editing, setEditing] = useState(false);
  const [until, setUntil] = useState(tomorrowMorning);
  const [reason, setReason] = useState("");
  const [limit, setLimit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = me?.role === "owner";
  const max = maxActiveOf(e);

  const saveShift = async () => {
    const t = Date.parse(until);
    if (Number.isNaN(t)) return report({ ok: false, error: "Укажите дату и время возвращения" });
    setBusy(true);
    const ok = report(await setExecutorShift(e.id, { available: false, until: new Date(t).toISOString(), reason: reason.trim() || undefined }), "Мастер недоступен — вернётся на смену сам");
    setBusy(false);
    if (ok) setEditing(false);
  };
  const backOnShift = async () => {
    setBusy(true);
    report(await setExecutorShift(e.id, { available: true }), "Снова на смене — получает заказы");
    setBusy(false);
  };
  const saveLimit = async () => {
    const n = Number(limit);
    setBusy(true);
    const ok = report(await setExecutorLimit(e.id, limit === "" ? null : n), "Лимит сохранён");
    setBusy(false);
    if (ok) setLimit(null);
  };

  const status = e.available ? (
    <Badge tone="green">На смене — получает заказы</Badge>
  ) : e.unavailableUntil ? (
    <Badge tone="violet">Недоступен до {dateTime(e.unavailableUntil)}</Badge>
  ) : (
    <Badge tone="gray">Выходной — заказы не приходят</Badge>
  );

  return (
    <Card icon={CalendarOff} title="Смена и загрузка" className={className}>
      <div className="flex flex-wrap items-center gap-2 text-[14px] text-ink-2">
        {status}
        {!e.available && e.unavailableReason && <span>{e.unavailableReason}</span>}
        {!e.available && e.unavailableUntil && <span className="text-muted">— вернётся на смену сам</span>}
      </div>
      {editing ? (
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1.3fr_auto] sm:items-end">
          <FormRow label="Недоступен до">{(id) => <Input id={id} type="datetime-local" value={until} onChange={(x) => setUntil(x.target.value)} />}</FormRow>
          <FormRow label="Причина">{(id) => <Input id={id} placeholder="Отпуск, болеет, ремонт машины…" maxLength={120} value={reason} onChange={(x) => setReason(x.target.value)} />}</FormRow>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
              Отмена
            </Button>
            <Button size="sm" onClick={() => void saveShift()} disabled={busy}>
              Сохранить
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" className="bg-white" onClick={() => setEditing(true)} disabled={busy}>
            {e.unavailableUntil ? "Изменить дату" : "Недоступен до…"}
          </Button>
          {!e.available && (
            <Button size="sm" variant="soft" onClick={() => void backOnShift()} disabled={busy}>
              Вернуть на смену сейчас
            </Button>
          )}
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line pt-3 text-[14px] text-ink-2">
        <Gauge size={17} className="text-muted" aria-hidden />
        <span>
          Заказов в работе одновременно: <b className="text-ink">{max}</b>
          {e.maxActiveOrders === undefined && <span className="text-muted"> (по умолчанию)</span>}
        </span>
        {owner &&
          (limit === null ? (
            <button type="button" className="text-[13.5px] font-semibold text-brand-ink hover:underline" onClick={() => setLimit(String(max))}>
              Изменить
            </button>
          ) : (
            <span className="flex items-center gap-2">
              <Input type="number" inputMode="numeric" min={1} max={20} className="w-20" aria-label="Лимит заказов в работе" value={limit} onChange={(x) => setLimit(x.target.value)} />
              <Button size="sm" onClick={() => void saveLimit()} disabled={busy}>
                Сохранить
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setLimit(null)} disabled={busy}>
                Отмена
              </Button>
            </span>
          ))}
      </div>
      <p className="mt-2 text-[12.5px] text-muted">
        На лимите мастер видит ленту, но взять новый заказ не может и не получает «Новый заказ». Пусто — по умолчанию ({DEFAULT_MAX_ACTIVE}).
      </p>
    </Card>
  );
}
