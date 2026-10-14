// «Выплаты мастерам» (владелец; ТЗ п.13 «выплата», п.14 «доход», п.17 «выплаты исполнителям»): кому и сколько компания
// должна сейчас за сданные заказы → выбрать заказы → «Выплатить» (способ, дата, комментарий) → строка реестра.
// Реестр выплат — по датам выплат; ошибочную выплату можно отменить в течение суток.
import { useQuery } from "convex/react";
import { Banknote, ChevronDown, ChevronRight, Hourglass, Undo2, Wallet } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { PAYMENT_METHODS, serviceById } from "../data/catalog";
import { almatyDateInput, moneyMoment } from "../data/money";
import { createPayout, undoPayout } from "../data/moneyActions";
import { toast } from "../data/store";
import { useMe } from "../data/hooks";
import { can } from "../data/permissions";
import type { OwedExecutor, PaymentMethod, PayoutEntry } from "../data/types";
import { date, dateTime, money, plural } from "../lib/format";
import { ExportButton } from "../components/ExportButton";
import { Avatar, Badge, Button, Card, EmptyState, FormRow, Input, KpiCard, Loading, Modal, PageHeader, Select } from "../components/ui";

const METHODS = Object.keys(PAYMENT_METHODS) as PaymentMethod[];
const DAY_MS = 86400_000;
const ordersWord = (n: number) => `${n} ${plural(n, "заказ", "заказа", "заказов")}`;

export default function Payouts() {
  // Начало «последних 30 дней» фиксируем при открытии экрана, чтобы запрос не пересоздавался на каждой отрисовке.
  const [since] = useState(() => new Date(Date.now() - 30 * DAY_MS).toISOString());
  const owed = useQuery(api.payouts.owed);
  const history = useQuery(api.payouts.list, {});
  const recent = useQuery(api.analytics.payouts, { from: since });
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [paying, setPaying] = useState<{ x: OwedExecutor; orderIds: string[] } | null>(null);
  const [undoing, setUndoing] = useState<PayoutEntry | null>(null);
  // Провести и отменить выплату — с правом «Менять деньги заказа»; смотреть реестр — с правом на выплаты (ТЗ п.5.12).
  const canPay = can(useMe(), "money.edit");

  if (owed === undefined || history === undefined) return <Loading />;
  const total = owed.reduce((s, x) => s + x.amount, 0);
  const waitingClient = owed.reduce((s, x) => s + x.orders.filter((o) => !o.clientPaid).reduce((a, o) => a + o.payout, 0), 0);
  const ordersCount = owed.reduce((s, x) => s + x.orders.length, 0);

  // По умолчанию отмечены заказы, которые клиент уже оплатил: обычно платят именно за них.
  // Заказ, за который тем временем уже выплатили (другая вкладка), из выбора выпадает сам.
  const selection = (x: OwedExecutor): string[] => (picked[x.executorId] ?? x.orders.filter((o) => o.clientPaid).map((o) => o.id)).filter((id) => x.orders.some((o) => o.id === id));
  const toggle = (x: OwedExecutor, orderId: string) => {
    const cur = selection(x);
    setPicked({ ...picked, [x.executorId]: cur.includes(orderId) ? cur.filter((id) => id !== orderId) : [...cur, orderId] });
  };

  return (
    <>
      <PageHeader title="Выплаты мастерам" subtitle="Сколько компания должна исполнителям за сданные заказы и что уже выплачено" actions={<ExportButton kinds={["payouts", "payments"]} />} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard icon={Wallet} tone="amber" label="К выплате сейчас" value={money(total)} caption={total ? `${ordersWord(ordersCount)}, мастеров: ${owed.length}` : "долгов перед мастерами нет"} />
        <KpiCard icon={Hourglass} tone="violet" label="Из них клиент ещё не оплатил" value={money(waitingClient)} caption="выплатить можно и до оплаты клиента" />
        <KpiCard icon={Banknote} tone="green" label="Выплачено за 30 дней" value={recent ? money(recent.paidOut.amount) : "…"} caption={recent ? `выплат: ${recent.paidOut.count} — по датам выплат` : undefined} />
      </div>

      <Card title="К выплате" className="mt-4" bodyClass="px-3 pb-3 sm:px-4">
        {owed.length === 0 ? (
          <EmptyState icon={Wallet} title="Все выплаты проведены" text="Когда мастер сдаст работу, заказ появится здесь." />
        ) : (
          <ul className="divide-y divide-line">
            {owed.map((x) => {
              const sel = selection(x);
              const sum = x.orders.filter((o) => sel.includes(o.id)).reduce((s, o) => s + o.payout, 0);
              const expanded = open === x.executorId;
              return (
                <li key={x.executorId} className="py-1">
                  <button type="button" onClick={() => setOpen(expanded ? null : x.executorId)} className="flex w-full items-center gap-3 rounded-[12px] px-2 py-2.5 text-left hover:bg-hover" aria-expanded={expanded}>
                    {expanded ? <ChevronDown size={18} className="shrink-0 text-muted" aria-hidden /> : <ChevronRight size={18} className="shrink-0 text-muted" aria-hidden />}
                    <Avatar name={x.name} size={36} variant="person" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-ink">{x.name}</span>
                      <span className="text-[13px] text-muted">{ordersWord(x.orders.length)}</span>
                    </span>
                    <b className="shrink-0 text-[16px] text-ink tabular-nums">{money(x.amount)}</b>
                  </button>
                  {expanded && (
                    <div className="mb-2 ml-2 rounded-[12px] border border-line sm:ml-9">
                      <ul className="divide-y divide-line">
                        {x.orders.map((o) => (
                          <li key={o.id}>
                            <label className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5 text-[14px]">
                              <input type="checkbox" className="h-4 w-4 shrink-0 accent-[#b07200]" checked={sel.includes(o.id)} onChange={() => toggle(x, o.id)} />
                              <span className="min-w-0 flex-1">
                                <Link to={`/orders/${o.id}`} className="font-semibold text-ink hover:text-brand-ink" onClick={(e) => e.stopPropagation()}>
                                  №{o.number}
                                </Link>{" "}
                                <span className="text-ink-2">{serviceById(o.serviceId).label}</span>
                                <span className="block text-[12.5px] text-muted">{o.doneAt ? `сдан ${date(o.doneAt)}` : "сдан"}</span>
                              </span>
                              <Badge tone={o.clientPaid ? "green" : "amber"} size="sm">
                                {o.clientPaid ? "клиент оплатил" : "ждёт оплаты клиента"}
                              </Badge>
                              <b className="w-[96px] shrink-0 text-right tabular-nums">{money(o.payout)}</b>
                            </label>
                          </li>
                        ))}
                      </ul>
                      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-3.5 py-3">
                        <span className="text-[13.5px] text-ink-2">
                          Выбрано: {ordersWord(sel.length)} на <b className="text-ink tabular-nums">{money(sum)}</b>
                        </span>
                        <div className="flex gap-2">
                          <Button size="sm" variant="ghost" onClick={() => setPicked({ ...picked, [x.executorId]: sel.length === x.orders.length ? [] : x.orders.map((o) => o.id) })}>
                            {sel.length === x.orders.length ? "Снять все" : "Выбрать все"}
                          </Button>
                          <Button size="sm" icon={Wallet} disabled={!sel.length || !canPay} onClick={() => setPaying({ x, orderIds: sel })}>
                            Выплатить {money(sum)}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card title="История выплат" className="mt-4" bodyClass="px-3 pb-3 sm:px-4">
        {history.length === 0 ? (
          <EmptyState icon={Banknote} title="Выплат ещё не было" text="Проведённые выплаты появятся здесь — с датой, способом и заказами." />
        ) : (
          <div className="scroll-x">
            <table className="tbl min-w-[720px]">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Исполнитель</th>
                  <th>Заказы</th>
                  <th>Способ</th>
                  <th className="text-right">Сумма</th>
                  <th>Провёл</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {history.map((p) => (
                  <tr key={p.id}>
                    <td className="whitespace-nowrap">{date(p.at)}</td>
                    <td className="font-medium text-ink">{p.executorName}</td>
                    <td className="max-w-[260px]">
                      <span className="flex flex-wrap gap-x-2">
                        {p.orders.map((o) => (
                          <Link key={o.id} to={`/orders/${o.id}`} className="text-brand-ink hover:underline">
                            №{o.number}
                          </Link>
                        ))}
                      </span>
                      {p.note && <span className="block text-[12.5px] text-muted">{p.note}</span>}
                    </td>
                    <td>{PAYMENT_METHODS[p.method]}</td>
                    <td className="text-right font-semibold tabular-nums">{money(p.amount)}</td>
                    <td className="text-ink-2">
                      {p.byName}
                      <span className="block text-[12px] text-muted">{dateTime(p.createdAt)}</span>
                    </td>
                    <td className="text-right">
                      {p.canUndo && canPay && (
                        <Button size="sm" variant="ghost" icon={Undo2} onClick={() => setUndoing(p)}>
                          Отменить
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {paying && (
        <PayModal
          x={paying.x}
          orderIds={paying.orderIds}
          onClose={(done) => {
            if (done) setPicked({ ...picked, [paying.x.executorId]: [] });
            setPaying(null);
          }}
        />
      )}
      {undoing && <UndoModal p={undoing} onClose={() => setUndoing(null)} />}
    </>
  );
}

function PayModal({ x, orderIds, onClose }: { x: OwedExecutor; orderIds: string[]; onClose: (done: boolean) => void }) {
  const [method, setMethod] = useState<PaymentMethod>("kaspi");
  const [day, setDay] = useState(() => almatyDateInput(Date.now()));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const orders = x.orders.filter((o) => orderIds.includes(o.id));
  const amount = orders.reduce((s, o) => s + o.payout, 0);
  const submit = async () => {
    const at = moneyMoment(day);
    if (!at) return toast("Укажите дату выплаты", "bad");
    setBusy(true);
    const r = await createPayout(x.executorId, orderIds, { method, at, note });
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast(`Выплата ${money(r.value.amount)} проведена — ${x.name} получил уведомление`);
    onClose(true);
  };
  return (
    <Modal
      open
      onClose={() => onClose(false)}
      title={`Выплата: ${x.name}`}
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={() => onClose(false)}>
            Отмена
          </Button>
          <Button icon={Wallet} onClick={() => void submit()} disabled={busy || !orders.length}>
            Выплатить {money(amount)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[14px] text-ink-2">
          {ordersWord(orders.length)}: {orders.map((o) => `№${o.number}`).join(", ")}. Заказы отметятся выплаченными, мастер получит уведомление. Ошибку можно отменить в течение суток.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Способ">
            {(id) => (
              <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHODS[m]}
                  </option>
                ))}
              </Select>
            )}
          </FormRow>
          <FormRow label="Дата выплаты">{(id) => <input id={id} type="date" className="field" value={day} max={almatyDateInput(Date.now())} onChange={(e) => setDay(e.target.value)} />}</FormRow>
        </div>
        <FormRow label="Комментарий">{(id) => <Input id={id} value={note} maxLength={300} placeholder="Необязательно: например, «за неделю 6–12 октября»" onChange={(e) => setNote(e.target.value)} />}</FormRow>
      </div>
    </Modal>
  );
}

function UndoModal({ p, onClose }: { p: PayoutEntry; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await undoPayout(p.id);
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast("Выплата отменена — заказы снова к выплате", "info");
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Отменить выплату?"
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Не отменять
          </Button>
          <Button variant="danger" icon={Undo2} onClick={() => void submit()} disabled={busy}>
            Отменить выплату
          </Button>
        </>
      }
    >
      <p className="text-[14px] text-ink-2">
        Выплата {money(p.amount)} ({PAYMENT_METHODS[p.method]}) — {p.executorName}, заказы {p.orders.map((o) => `№${o.number}`).join(", ")}. Заказы снова попадут «к выплате», мастер получит уведомление об отмене.
      </p>
    </Modal>
  );
}
