// Карточка владельца «Сроки реакции» (ТЗ п.15, п.18): через сколько система зовёт руководителя, владельца
// и операторов, если на заказ, заявку или звонок долго нет реакции. Пороги — convex/escalations.ts.
import { useQuery } from "convex/react";
import { Siren } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { SLA_DEFAULTS, SLA_LABEL, SLA_LIMITS, slaProblem, type SlaKey, type SlaSettings } from "../data/escalations";
import { saveSla } from "../data/operationsActions";
import { report } from "../data/store";
import { Button, Card, Input, Loading } from "../components/ui";

/** Как показывать поле: минуты, часы (хранятся минутами) или час дня. */
const UNIT: Record<SlaKey, { unit: "мин" | "ч" | "час"; factor: number }> = {
  feedMin: { unit: "мин", factor: 1 },
  feedOwnerMin: { unit: "мин", factor: 1 },
  unconfirmedMin: { unit: "мин", factor: 1 },
  overdueOwnerMin: { unit: "ч", factor: 60 },
  leadMin: { unit: "мин", factor: 1 },
  callbackMin: { unit: "мин", factor: 1 },
  dayStart: { unit: "час", factor: 1 },
  dayEnd: { unit: "час", factor: 1 },
};

const GROUPS: { title: string; hint: string; keys: SlaKey[] }[] = [
  { title: "Заказы", hint: "Руководителю — направления заказа; если руководителя нет, владельцу", keys: ["feedMin", "feedOwnerMin", "unconfirmedMin", "overdueOwnerMin"] },
  { title: "Заявки и звонки", hint: "Операторам; время считается только рабочее", keys: ["leadMin", "callbackMin", "dayStart", "dayEnd"] },
];

type Draft = Record<SlaKey, string>;
const toDraft = (s: SlaSettings): Draft => Object.fromEntries((Object.keys(s) as SlaKey[]).map((k) => [k, String(s[k] / UNIT[k].factor)])) as Draft;
const fromDraft = (d: Draft): SlaSettings => Object.fromEntries((Object.keys(d) as SlaKey[]).map((k) => [k, Math.round(Number(d[k]) * UNIT[k].factor)])) as unknown as SlaSettings;
const bounds = (k: SlaKey) => ({ lo: Math.ceil(SLA_LIMITS[k].min / UNIT[k].factor), hi: Math.floor(SLA_LIMITS[k].max / UNIT[k].factor) });

/** Ошибка ввода в единицах экрана (часы — часами); затем общие правила сервера. */
function draftProblem(d: Draft): string | null {
  for (const k of Object.keys(d) as SlaKey[]) {
    const { lo, hi } = bounds(k);
    const x = Number(d[k]);
    if (!/^\d+$/.test(d[k].trim()) || x < lo || x > hi) return `${SLA_LABEL[k]}: целое число от ${lo} до ${hi} ${UNIT[k].unit}`;
  }
  return slaProblem(fromDraft(d));
}

export function EscalationsCard() {
  const s = useQuery(api.escalations.settings);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  if (s === undefined) {
    return (
      <Card icon={Siren} title="Сроки реакции">
        <Loading className="py-6" />
      </Card>
    );
  }
  const d = draft ?? toDraft(s);
  const next = fromDraft(d);
  const problem = draft ? draftProblem(draft) : null;
  const changed = draft !== null && (Object.keys(s) as SlaKey[]).some((k) => s[k] !== next[k]);

  const save = async () => {
    setBusy(true);
    const ok = report(await saveSla(next), "Сроки реакции сохранены");
    setBusy(false);
    if (ok) setDraft(null);
  };

  return (
    <Card icon={Siren} title="Сроки реакции">
      <p className="text-[13.5px] text-muted">
        Если на заказ, заявку или звонок долго нет реакции, система сама сообщит ответственным — в колокольчик и Telegram. Каждое напоминание — один раз, всё записывается в журнал.
      </p>
      {GROUPS.map((g) => (
        <fieldset key={g.title} className="mt-4">
          <legend className="text-[14px] font-semibold text-ink">{g.title}</legend>
          <p className="text-[12.5px] text-muted">{g.hint}</p>
          <div className="mt-2 space-y-2">
            {g.keys.map((k) => (
              <label key={k} className="flex items-center justify-between gap-3 text-[14px] text-ink-2">
                <span className="min-w-0">{SLA_LABEL[k]}</span>
                <span className="flex shrink-0 items-center gap-2">
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={bounds(k).lo}
                    max={bounds(k).hi}
                    value={d[k]}
                    onChange={(e) => setDraft({ ...d, [k]: e.target.value })}
                    className="w-20"
                  />
                  <span className="w-8 text-[13px] text-muted">{UNIT[k].unit}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      {problem && <p className="mt-2 text-[12.5px] text-bad-ink">{problem}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {draft !== null && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(null)}>
            Отменить
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDraft(toDraft(SLA_DEFAULTS))}>
          По умолчанию
        </Button>
        <Button size="sm" disabled={!changed || !!problem || busy} onClick={() => void save()}>
          Сохранить
        </Button>
      </div>
    </Card>
  );
}
