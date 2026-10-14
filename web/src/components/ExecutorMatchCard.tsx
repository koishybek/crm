// Карточка «Подбор и ставки» мастера для сотрудников: районы (ТЗ п.12.3, меняются в «Редактировать»), история за
// 90 дней, которую учитывает подбор (п.12.6), и ставки (п.14.5) — их меняет только владелец, каждое изменение — в журнал.
import { MapPinned, Percent, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { SERVICES, serviceById } from "../data/catalog";
import { useMe } from "../data/hooks";
import { HISTORY, onTimePct, qualityScore } from "../data/logic";
import { saveExecutorRates } from "../data/matchActions";
import { report } from "../data/store";
import type { Executor, ExecutorRates, RateMode, RateOverride } from "../data/types";
import { dateTime, digits, money } from "../lib/format";
import { Button, Card, FormRow, IconButton, Input, Segmented, Select } from "./ui";

const MODE_LABEL: Record<RateMode, string> = { service: "Ставка услуги", percent: "Свой процент", fixed: "Своя сумма" };

const overrideText = (r: RateOverride) => (r.fixed !== undefined ? money(r.fixed) : `${r.percent}%`);

/** Ставки одной строкой: «Свой процент 45% · Ремонт кондиционера — 15 000 ₸». */
export function ratesSummary(r: ExecutorRates | undefined): string {
  if (!r) return "Ставка услуги из справочника";
  const head = r.mode === "percent" ? `Свой процент ${r.percent}%` : r.mode === "fixed" ? `Своя сумма ${money(r.fixed ?? 0)} за заказ` : "Ставка услуги из справочника";
  const services = Object.entries(r.perService ?? {}).map(([id, x]) => `${serviceById(id).label} — ${overrideText(x)}`);
  return [head, ...services].join(" · ");
}

export function ExecutorMatchCard({ e, className }: { e: Executor; className?: string }) {
  const me = useMe();
  const owner = me?.role === "owner";
  const [editing, setEditing] = useState(false);
  const s = e.stats90;
  const pct = onTimePct(s);
  return (
    <Card className={className} icon={MapPinned} title="Подбор и ставки" bodyClass="px-0 pb-0">
      <div className="grid gap-4 px-5 pb-5 md:grid-cols-3">
        <div>
          <div className="text-[13px] font-semibold text-muted">Районы</div>
          <p className="mt-1 text-[14.5px] text-ink">{e.districts?.length ? e.districts.join(", ") : `Весь город (${e.city})`}</p>
        </div>
        <div>
          <div className="text-[13px] font-semibold text-muted">История за {HISTORY.days} дней</div>
          {s ? (
            <p className="mt-1 text-[14.5px] text-ink">
              Сдано {s.done}
              {pct !== null ? `, вовремя ${pct}%` : ""} · отказов {s.refusals} · отмен {s.cancelled}
              {s.avgHours !== undefined ? ` · в среднем ${s.avgHours} ч` : ""}
              <span className="block text-[12.5px] text-muted">
                Баллы подбора: {qualityScore(e)} · обновлено {dateTime(s.updatedAt)}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-[14.5px] text-muted">Пока нет — появится после первого сданного заказа или отказа</p>
          )}
        </div>
        <div>
          <div className="text-[13px] font-semibold text-muted">Ставки</div>
          <p className="mt-1 text-[14.5px] text-ink">{ratesSummary(e.rates)}</p>
          {owner && !editing && (
            <Button size="sm" variant="secondary" icon={Percent} className="mt-2 bg-white" onClick={() => setEditing(true)}>
              Изменить ставки
            </Button>
          )}
        </div>
      </div>
      {owner && editing && <RatesEditor e={e} onDone={() => setEditing(false)} />}
    </Card>
  );
}

type Row = { serviceId: string; kind: "percent" | "fixed"; value: string };

function RatesEditor({ e, onDone }: { e: Executor; onDone: () => void }) {
  const [mode, setMode] = useState<RateMode>(e.rates?.mode ?? "service");
  const [percent, setPercent] = useState(e.rates?.percent !== undefined ? String(e.rates.percent) : "");
  const [fixed, setFixed] = useState(e.rates?.fixed !== undefined ? String(e.rates.fixed) : "");
  const [rows, setRows] = useState<Row[]>(() =>
    Object.entries(e.rates?.perService ?? {}).map(([serviceId, r]) => ({ serviceId, kind: r.fixed !== undefined ? "fixed" : "percent", value: String(r.fixed ?? r.percent ?? "") })),
  );
  const [busy, setBusy] = useState(false);
  const services = SERVICES.filter((x) => x.active !== false && e.categories.includes(x.category));
  const free = services.filter((x) => !rows.some((r) => r.serviceId === x.id));

  const save = async () => {
    const perService: Record<string, RateOverride> = {};
    for (const r of rows) {
      const n = Number(r.kind === "fixed" ? digits(r.value) : r.value.replace(",", "."));
      if (!r.serviceId || !Number.isFinite(n) || n <= 0) return report({ ok: false, error: `${serviceById(r.serviceId).label}: укажите ставку` });
      perService[r.serviceId] = r.kind === "fixed" ? { fixed: n } : { percent: n };
    }
    const rates: ExecutorRates = {
      mode,
      ...(mode === "percent" ? { percent: Number(percent.replace(",", ".")) } : {}),
      ...(mode === "fixed" ? { fixed: Number(digits(fixed)) } : {}),
      ...(rows.length ? { perService } : {}),
    };
    setBusy(true);
    const ok = report(await saveExecutorRates(e.id, mode === "service" && !rows.length ? null : rates), "Ставки сохранены — действуют на следующие заказы");
    setBusy(false);
    if (ok) onDone();
  };

  return (
    <div className="border-t border-line px-5 py-4">
      <p className="mb-3 text-[13px] text-muted">
        Ставка применяется, когда мастер берёт заказ или его назначают; сумма фиксируется в заказе. Ручная правка выплаты в самом заказе важнее ставки.
      </p>
      <Segmented options={(Object.keys(MODE_LABEL) as RateMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }))} value={mode} onChange={setMode} />
      {mode === "percent" && (
        <div className="mt-3 max-w-[220px]">
          <FormRow label="Процент от цены клиента">{(id) => <Input id={id} inputMode="decimal" value={percent} placeholder="45" onChange={(x) => setPercent(x.target.value.replace(/[^\d.,]/g, ""))} />}</FormRow>
        </div>
      )}
      {mode === "fixed" && (
        <div className="mt-3 max-w-[220px]">
          <FormRow label="Сумма за заказ, ₸">{(id) => <Input id={id} inputMode="numeric" value={fixed} placeholder="15000" onChange={(x) => setFixed(x.target.value.replace(/[^\d\s]/g, ""))} />}</FormRow>
        </div>
      )}
      <div className="mt-4 text-[14px] font-semibold text-ink">Ставки на отдельные услуги</div>
      <p className="mb-2 text-[12.5px] text-muted">Важнее общей ставки. Например, на сложный монтаж — своя сумма.</p>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={r.serviceId || i} className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="Услуга"
              className="min-w-[200px] flex-1"
              value={r.serviceId}
              onChange={(x) => setRows((list) => list.map((y, j) => (j === i ? { ...y, serviceId: x.target.value } : y)))}
            >
              {[serviceById(r.serviceId), ...free].map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </Select>
            <Select aria-label="Вид ставки" className="w-[130px]" value={r.kind} onChange={(x) => setRows((list) => list.map((y, j) => (j === i ? { ...y, kind: x.target.value === "fixed" ? "fixed" : "percent" } : y)))}>
              <option value="percent">процент</option>
              <option value="fixed">сумма, ₸</option>
            </Select>
            <Input aria-label="Ставка" className="w-[120px]" inputMode="decimal" value={r.value} onChange={(x) => setRows((list) => list.map((y, j) => (j === i ? { ...y, value: x.target.value.replace(/[^\d.,\s]/g, "") } : y)))} />
            <IconButton icon={Trash2} label="Убрать ставку" onClick={() => setRows((list) => list.filter((_, j) => j !== i))} />
          </div>
        ))}
        {free.length > 0 && (
          <Button size="sm" variant="secondary" icon={Plus} className="self-start bg-white" onClick={() => setRows((list) => [...list, { serviceId: free[0]!.id, kind: "percent", value: "" }])}>
            Добавить услугу
          </Button>
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Отмена
        </Button>
        <Button disabled={busy} onClick={() => void save()}>
          Сохранить ставки
        </Button>
      </div>
    </div>
  );
}
