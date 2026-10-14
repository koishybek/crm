// Карточка «Кампании» в «Аналитике» владельца (ТЗ п.6.6, п.28.5): заявки, заказы, выручка и стоимость привлечения
// по рекламной кампании (utm_campaign) за период + редактор расходов на кампании. Цифры считает сервер (convex/campaigns.ts)
// по формулам src/data/campaigns.ts.
import { useQuery } from "convex/react";
import { Megaphone, Plus, Target } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { api } from "../../convex/_generated/api";
import { Button, Card, FormRow, Input, Loading, Modal, Select } from "../components/ui";
import { monthLabel, recentMonths } from "../data/analytics";
import { saveCampaignSpend } from "../data/campaignActions";
import { campaignTotals, type CampaignRow } from "../data/campaigns";
import { useNow } from "../data/hooks";
import { rangeOf, type PeriodId } from "../data/metrics";
import { report } from "../data/store";
import { cleanUtmValue } from "../data/utm";
import { cn, digits, money, num } from "../lib/format";

const share = (x: number) => `${Math.round(x * 100)}%`;
const cost = (x: number | null) => (x === null ? <span className="text-muted">—</span> : money(x));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Romi({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">—</span>;
  const p = Math.round(value * 100);
  return <span className={cn("font-semibold tabular-nums", p >= 0 ? "text-ok-ink" : "text-bad-ink")}>{`${p > 0 ? "+" : ""}${p}%`}</span>;
}

function Cells({ r }: { r: Omit<CampaignRow, "campaign"> }) {
  return (
    <>
      <td className="text-center tabular-nums">{num(r.leads)}</td>
      <td className="text-center tabular-nums">{num(r.orders)}</td>
      <td className="text-center tabular-nums">{share(r.conversion)}</td>
      <td className="text-right tabular-nums">{money(r.revenue)}</td>
      <td className="text-right tabular-nums">{money(r.margin)}</td>
      <td className="text-right tabular-nums">{r.spend ? money(r.spend) : <span className="text-muted">—</span>}</td>
      <td className="text-right tabular-nums">{cost(r.cpl)}</td>
      <td className="text-right tabular-nums">{cost(r.cpo)}</td>
      <td className="text-right">
        <Romi value={r.romi} />
      </td>
    </>
  );
}

/** Кампании за период выбранного на экране «Аналитика». */
export function AnalyticsCampaigns({ period }: { period: PeriodId }) {
  const now = useNow(60_000);
  const { cur } = rangeOf(period, now);
  const rows = useQuery(api.campaigns.stats, { from: new Date(cur.from).toISOString(), to: new Date(cur.to).toISOString() });
  const [spendOpen, setSpendOpen] = useState(false);
  const total = rows ? campaignTotals(rows) : null;
  return (
    <Card
      title="Кампании"
      icon={Target}
      action={
        <Button size="sm" variant="secondary" icon={Megaphone} onClick={() => setSpendOpen(true)}>
          Расходы по кампаниям
        </Button>
      }
      bodyClass="px-3 pb-3 sm:px-4"
    >
      {rows === undefined ? (
        <Loading className="py-8" />
      ) : rows.length === 0 ? (
        <p className="px-1 py-8 text-center text-[14px] text-muted">
          За период нет заявок с меткой кампании. Добавьте <code>?utm_campaign=название</code> в ссылки рекламы на форму или передавайте <code>campaign</code> в API.
        </p>
      ) : (
        <div className="scroll-x">
          <table className="tbl min-w-[980px]">
            <thead>
              <tr>
                <th>Кампания</th>
                <th className="text-center">Заявок</th>
                <th className="text-center">Заказов</th>
                <th className="text-center">Конверсия</th>
                <th className="text-right">Выручка</th>
                <th className="text-right">Маржа</th>
                <th className="text-right">Расходы</th>
                <th className="text-right" title="Расходы / заявки (CPL)">
                  Цена заявки
                </th>
                <th className="text-right" title="Расходы / заказы (CPO)">
                  Цена заказа
                </th>
                <th className="text-right" title="(Маржа − расходы) / расходы">
                  ROMI
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.campaign}>
                  <td className="max-w-[240px] truncate font-medium text-ink" title={r.campaign}>
                    {r.campaign}
                  </td>
                  <Cells r={r} />
                </tr>
              ))}
              {total && rows.length > 1 && (
                <tr className="font-semibold [&>td]:border-t [&>td]:border-b-0 [&>td]:border-line-strong">
                  <td>Итого</td>
                  <Cells r={total} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-1 pt-3 text-[12.5px] text-muted">
        Кампания — из метки <code>utm_campaign</code> формы сайта или поля <code>campaign</code> в API; при создании заказа она переходит в заказ. Выручка и маржа — по заказам кампании, выполненным за период; ROMI = (маржа − расходы) / расходы.
      </p>
      {spendOpen && <CampaignSpendModal onClose={() => setSpendOpen(false)} />}
    </Card>
  );
}

function CampaignSpendModal({ onClose }: { onClose: () => void }) {
  const months = useMemo(() => recentMonths(Date.now(), 13), []);
  const [month, setMonth] = useState(months[0]!);
  const [busy, setBusy] = useState(false);
  const data = useQuery(api.campaigns.spendMonth, { month });
  return (
    <Modal
      open
      onClose={onClose}
      title="Расходы по кампаниям"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
          <Button type="submit" form="campaign-spend" disabled={busy || data === undefined}>
            Сохранить
          </Button>
        </>
      }
    >
      <p className="-mt-1 mb-4 text-[14px] text-muted">Сколько потратили на кампанию за месяц. Пусто или 0 — расходов не было. Название — как в utm_campaign.</p>
      <FormRow label="Месяц">
        {(id) => (
          <Select id={id} value={month} onChange={(e) => setMonth(e.target.value)}>
            {months.map((m) => (
              <option key={m} value={m}>
                {capital(monthLabel(m))}
              </option>
            ))}
          </Select>
        )}
      </FormRow>
      {data === undefined ? <Loading className="py-8" /> : <CampaignSpendForm key={month} month={month} data={data} setBusy={setBusy} />}
    </Modal>
  );
}

function CampaignSpendForm({ month, data, setBusy }: { month: string; data: { rows: { campaign: string; amount: number }[]; known: string[] }; setBusy: (v: boolean) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(data.rows.map((r) => [r.campaign, String(r.amount)])));
  const [names, setNames] = useState<string[]>(() => [...new Set([...data.rows.map((r) => r.campaign), ...data.known])]);
  const [extra, setExtra] = useState("");
  const amount = (c: string) => Number(digits(values[c] ?? "")) || 0;
  const add = () => {
    const name = cleanUtmValue(extra);
    if (name && !names.includes(name)) setNames((xs) => [...xs, name]);
    setExtra("");
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    // Сохраняем то, что ввели, и то, что было: стёртая сумма — 0, строка уходит.
    const touched = names.filter((c) => values[c] !== undefined || data.rows.some((r) => r.campaign === c));
    const r = await saveCampaignSpend(
      month,
      touched.map((campaign) => ({ campaign, amount: amount(campaign) })),
    );
    setBusy(false);
    report(r, r.ok ? (r.value.changed ? `Расходы за ${monthLabel(month)} сохранены` : "Изменений нет") : undefined);
  };
  return (
    <form id="campaign-spend" onSubmit={submit} className="mt-4 flex flex-col gap-2.5">
      {names.length === 0 && <p className="text-[13.5px] text-muted">Кампаний в заявках пока нет — добавьте название вручную.</p>}
      {names.map((c) => (
        <div key={c} className="grid grid-cols-[minmax(0,1fr)_150px] items-center gap-3">
          <span className="truncate font-medium text-ink" title={c}>
            {c}
          </span>
          <Input
            inputMode="numeric"
            aria-label={`Расходы на кампанию ${c} за ${monthLabel(month)}, ₸`}
            placeholder="0 ₸"
            value={values[c] ? num(Number(digits(values[c]!))) : ""}
            onChange={(e) => setValues((v) => ({ ...v, [c]: digits(e.target.value).slice(0, 10) }))}
            className="[&_input]:text-right"
          />
        </div>
      ))}
      <div className="flex items-center gap-2 border-t border-line pt-3">
        <Input
          aria-label="Название кампании"
          placeholder="Ещё кампания: ac-oct"
          maxLength={100}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" size="sm" variant="secondary" icon={Plus} disabled={!cleanUtmValue(extra)} onClick={add}>
          Добавить
        </Button>
      </div>
      <p className="text-[12.5px] text-muted">В аналитике месячная сумма делится поровну по дням месяца. Изменения попадают в журнал действий.</p>
    </form>
  );
}
