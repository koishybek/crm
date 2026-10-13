// Карточки «Аналитики» владельца (ТЗ п.17): источники и стоимость привлечения, работа операторов,
// редактор расходов на рекламу. Цифры считает src/data/analytics.ts — те же формулы, что у сервера.
import { useQuery } from "convex/react";
import { Bot, Megaphone } from "lucide-react";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { Source } from "../components/icons";
import { Avatar, Button, Card, FormRow, Input, Loading, Modal, Select } from "../components/ui";
import { durationText, monthLabel, recentMonths, sourceTotals, type AdSpendRow, type OperatorRow, type SourceRow } from "../data/analytics";
import { saveAdSpend } from "../data/analyticsActions";
import { SOURCE_IDS, SOURCES } from "../data/catalog";
import { report } from "../data/store";
import type { SourceId, User } from "../data/types";
import { cn, digits, money, num, shortName } from "../lib/format";

const share = (x: number) => `${Math.round(x * 100)}%`;
const cost = (x: number | null) => (x === null ? <span className="text-muted">—</span> : money(x));
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const TOTAL_ROW = "font-semibold [&>td]:border-t [&>td]:border-b-0 [&>td]:border-line-strong";

function Romi({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted">—</span>;
  const p = Math.round(value * 100);
  return (
    <span className={cn("font-semibold tabular-nums", p >= 0 ? "text-ok-ink" : "text-bad-ink")}>
      {p > 0 ? "+" : ""}
      {p}%
    </span>
  );
}

/** Источники заявок: конверсия, деньги и стоимость привлечения за период (ТЗ п.17 «стоимость заявки и заказа»). */
export function SourceCostsCard({ rows, onSpend }: { rows: SourceRow[]; onSpend: () => void }) {
  const total = sourceTotals(rows);
  return (
    <Card
      title="Источники и стоимость привлечения"
      action={
        <Button size="sm" variant="secondary" icon={Megaphone} onClick={onSpend}>
          Расходы на рекламу
        </Button>
      }
      bodyClass="px-3 pb-3 sm:px-4"
    >
      {rows.length === 0 ? (
        <p className="px-1 py-8 text-center text-[14px] text-muted">За период нет ни заявок, ни выполненных заказов</p>
      ) : (
        <div className="scroll-x">
          <table className="tbl min-w-[940px]">
            <thead>
              <tr>
                <th>Источник</th>
                <th className="text-center">Заявок</th>
                <th className="text-center">Заказов</th>
                <th className="text-center">Конверсия</th>
                <th className="text-right">Средний чек</th>
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
              {rows.map((x) => (
                <tr key={x.source}>
                  <td>
                    <Source source={x.source} className="font-medium text-ink" />
                  </td>
                  <td className="text-center tabular-nums">{x.leads}</td>
                  <td className="text-center tabular-nums">{x.orders}</td>
                  <td className="text-center tabular-nums">{x.leads ? share(x.conversion) : "—"}</td>
                  <td className="text-right tabular-nums">{x.done ? money(x.avg) : "—"}</td>
                  <td className="text-right font-semibold text-ok-ink tabular-nums">{money(x.margin)}</td>
                  <td className="text-right tabular-nums">{x.spend > 0 ? money(x.spend) : <span className="text-muted">—</span>}</td>
                  <td className="text-right tabular-nums">{cost(x.cpl)}</td>
                  <td className="text-right tabular-nums">{cost(x.cpo)}</td>
                  <td className="text-right">
                    <Romi value={x.romi} />
                  </td>
                </tr>
              ))}
            </tbody>
            {rows.length > 1 && (
              <tfoot>
                <tr className={TOTAL_ROW}>
                  <td>Итого</td>
                  <td className="text-center tabular-nums">{total.leads}</td>
                  <td className="text-center tabular-nums">{total.orders}</td>
                  <td className="text-center tabular-nums">{total.leads ? share(total.conversion) : "—"}</td>
                  <td className="text-right tabular-nums">{total.done ? money(total.revenue / total.done) : "—"}</td>
                  <td className="text-right text-ok-ink tabular-nums">{money(total.margin)}</td>
                  <td className="text-right tabular-nums">{total.spend > 0 ? money(total.spend) : "—"}</td>
                  <td className="text-right tabular-nums">{cost(total.cpl)}</td>
                  <td className="text-right tabular-nums">{cost(total.cpo)}</td>
                  <td className="text-right">
                    <Romi value={total.romi} />
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      <p className="px-1 pt-3 text-[12.5px] text-muted">
        {total.spend > 0
          ? "Расходы за месяц делятся по дням — в период попадает его доля. Заказы — из заявок периода, маржа и средний чек — по заказам, выполненным за период; возвраты не считаются."
          : "Внесите расходы на рекламу по месяцам — появятся цена заявки, цена заказа и окупаемость (ROMI). Маржа — по заказам, выполненным за период; возвраты не считаются."}
      </p>
    </Card>
  );
}

function OperatorLine({ who, x }: { who: ReactNode; x: OperatorRow }) {
  return (
    <tr>
      <td>{who}</td>
      <td className="text-center tabular-nums">{x.leads}</td>
      <td className="text-center tabular-nums">{x.converted}</td>
      <td className="text-center font-semibold tabular-nums">{share(x.conversion)}</td>
      <td className="text-right tabular-nums">{money(x.revenue)}</td>
      <td className="text-right font-semibold text-ok-ink tabular-nums">{money(x.margin)}</td>
      <td className="text-right tabular-nums">{x.medianMs === null ? <span className="text-muted">—</span> : durationText(x.medianMs)}</td>
    </tr>
  );
}

/**
 * Работа операторов за период (ТЗ п.17): кто сколько заявок завёл, сколько стали заказом, деньги из них
 * и как быстро. Заявки, которые пришли сами (бот, сайт, API, AI), — отдельной строкой, никому не засчитываются.
 */
export function OperatorsCard({ rows, auto, users }: { rows: OperatorRow[]; auto: OperatorRow | null; users: User[] }) {
  const user = (id?: string) => users.find((u) => u.id === id);
  return (
    <Card title="Операторы" bodyClass="px-3 pb-3 sm:px-4">
      {rows.length === 0 && !auto ? (
        <p className="px-1 py-8 text-center text-[14px] text-muted">За период заявок нет</p>
      ) : (
        <div className="scroll-x">
          <table className="tbl min-w-[700px]">
            <thead>
              <tr>
                <th>Сотрудник</th>
                <th className="text-center">Заявок</th>
                <th className="text-center">В заказ</th>
                <th className="text-center">Конверсия</th>
                <th className="text-right">Выручка</th>
                <th className="text-right">Маржа</th>
                <th className="text-right" title="Медиана: сколько проходит от заявки до заказа">
                  До заказа
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const u = user(x.userId);
                const name = u?.name || "Сотрудник";
                return (
                  <OperatorLine
                    key={x.userId}
                    x={x}
                    who={
                      <span className="flex items-center gap-2.5">
                        <Avatar name={name} size={30} variant="person" />
                        <span className="leading-tight">
                          <span className="block font-medium text-ink">{shortName(name)}</span>
                          {u?.role === "owner" && <span className="text-[12px] text-muted">владелец</span>}
                        </span>
                      </span>
                    }
                  />
                );
              })}
              {auto && (
                <OperatorLine
                  x={auto}
                  who={
                    <span className="flex items-center gap-2.5">
                      <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-slate-bg text-muted">
                        <Bot size={17} aria-hidden />
                      </span>
                      <span className="leading-tight">
                        <span className="block font-medium text-ink">Пришли сами</span>
                        <span className="text-[12px] text-muted">бот, сайт, API, AI</span>
                      </span>
                    </span>
                  }
                />
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="px-1 pt-3 text-[12.5px] text-muted">
        Заявка засчитывается тому, кто её завёл; AI-разбор звонка — тому, кто принял звонок. Выручка и маржа — по выполненным заказам из этих заявок, «До заказа» — медиана.
      </p>
    </Card>
  );
}

/** Редактор расходов на рекламу: месяц и сумма по каждому источнику. Сохранение не закрывает окно — можно внести следующий месяц. */
export function AdSpendModal({ onClose }: { onClose: () => void }) {
  const months = useMemo(() => recentMonths(Date.now(), 13), []);
  const [month, setMonth] = useState(months[0]!);
  const [busy, setBusy] = useState(false);
  const rows = useQuery(api.analytics.adSpendMonth, { month });
  return (
    <Modal
      open
      onClose={onClose}
      title="Расходы на рекламу"
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Закрыть
          </Button>
          <Button type="submit" form="ad-spend" disabled={busy || rows === undefined}>
            Сохранить
          </Button>
        </>
      }
    >
      <p className="-mt-1 mb-4 text-[14px] text-muted">Сколько потратили на рекламу за месяц в каждом источнике. Пусто или 0 — рекламы не было.</p>
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
      {rows === undefined ? <Loading className="py-8" /> : <SpendForm key={month} month={month} rows={rows} setBusy={setBusy} />}
    </Modal>
  );
}

function SpendForm({ month, rows, setBusy }: { month: string; rows: AdSpendRow[]; setBusy: (v: boolean) => void }) {
  const [values, setValues] = useState<Partial<Record<SourceId, string>>>(() => Object.fromEntries(rows.map((r) => [r.source, String(r.amount)])));
  const amount = (s: SourceId) => Number(digits(values[s] ?? "")) || 0;
  const total = SOURCE_IDS.reduce((sum, s) => sum + amount(s), 0);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await saveAdSpend(
      month,
      SOURCE_IDS.map((source) => ({ source, amount: amount(source) })),
    );
    setBusy(false);
    report(r, r.ok ? (r.value.changed ? `Расходы за ${monthLabel(month)} сохранены` : "Изменений нет") : undefined);
  };
  return (
    <form id="ad-spend" onSubmit={submit} className="mt-4 flex flex-col gap-2.5">
      {SOURCE_IDS.map((s) => (
        <div key={s} className="grid grid-cols-[minmax(0,1fr)_150px] items-center gap-3">
          <Source source={s} className="font-medium text-ink" />
          <Input
            inputMode="numeric"
            aria-label={`Расходы ${SOURCES[s].label} за ${monthLabel(month)}, ₸`}
            placeholder="0 ₸"
            value={values[s] ? num(Number(digits(values[s]!))) : ""}
            onChange={(e) => setValues((v) => ({ ...v, [s]: digits(e.target.value).slice(0, 10) }))}
            className="[&_input]:text-right"
          />
        </div>
      ))}
      <div className="mt-1 flex items-center justify-between border-t border-line pt-3 text-[14.5px]">
        <span className="text-ink-2">Итого за месяц</span>
        <b className="text-ink tabular-nums">{money(total)}</b>
      </div>
      <p className="text-[12.5px] text-muted">В аналитике месячная сумма делится поровну по дням месяца — в период попадает доля за его дни. Изменения попадают в журнал действий.</p>
    </form>
  );
}
