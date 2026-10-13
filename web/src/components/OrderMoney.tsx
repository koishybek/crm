// Деньги в карточке заказа (ТЗ п.10, п.13): оплаты и возвраты списком, оплата с датой и комментарием, сторно и возврат
// (владелец), выплата исполнителю за этот заказ (владелец), закрытие с долгом или без выплаты — с причиной (владелец).
// Правила — общие с сервером (src/data/money.ts); сервер проверяет всё сам, здесь — подсказки и понятные формы.
import { Ban, CircleCheck, RotateCcw, Wallet } from "lucide-react";
import { useState } from "react";
import { FINISHED_STATUSES, PAYMENT_METHODS } from "../data/catalog";
import { useTeam } from "../data/hooks";
import { paidAmount, payout } from "../data/logic";
import { almatyDateInput, moneyMoment, netReceived } from "../data/money";
import { addPayment, addRefund, createPayout, voidPayment } from "../data/moneyActions";
import { changeStatus, toast } from "../data/store";
import type { Order, Payment, PaymentMethod, Refund } from "../data/types";
import { cn, dateTime, digits, money, num, shortName } from "../lib/format";
import { Badge, Button, FormRow, Input, Modal, Select, Textarea } from "./ui";

const METHODS = Object.keys(PAYMENT_METHODS) as PaymentMethod[];

function MethodSelect({ id, value, onChange }: { id: string; value: PaymentMethod; onChange: (m: PaymentMethod) => void }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value as PaymentMethod)}>
      {METHODS.map((m) => (
        <option key={m} value={m}>
          {PAYMENT_METHODS[m]}
        </option>
      ))}
    </Select>
  );
}

/** Поле даты денежной операции: не раньше дня создания заказа и не позже сегодняшнего (по Алматы). */
function DayInput({ id, value, onChange, min }: { id: string; value: string; onChange: (day: string) => void; min?: string }) {
  return <input id={id} type="date" className="field" value={value} min={min} max={almatyDateInput(Date.now())} onChange={(e) => onChange(e.target.value)} />;
}

const amountOf = (s: string) => Number(digits(s)) || 0;

// ── Список оплат и возвратов ─────────────────────────────────────────────────

type LedgerRow = { kind: "payment"; at: string; payment: Payment } | { kind: "refund"; at: string; refund: Refund };

/** Оплаты и возвраты по времени. Сторнированный платёж виден зачёркнутым, с причиной. */
export function MoneyLedger({ o, onVoid }: { o: Order; onVoid?: (p: Payment) => void }) {
  const team = useTeam();
  const rows: LedgerRow[] = [
    ...o.payments.map((payment): LedgerRow => ({ kind: "payment", at: payment.at, payment })),
    ...(o.refunds ?? []).map((refund): LedgerRow => ({ kind: "refund", at: refund.at, refund })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  if (!rows.length) return null;
  const who = (id?: string) => (id ? shortName(team.userName(id)) : "");
  return (
    <div className="mt-3">
      <div className="mb-1.5 text-[13px] font-semibold text-ink-2">Оплаты и возвраты</div>
      <ul className="divide-y divide-line rounded-[12px] border border-line">
        {rows.map((x) =>
          x.kind === "payment" ? (
            <li key={x.payment.id} className="flex items-start gap-3 px-3.5 py-2.5 text-[13.5px]">
              <div className="min-w-0 flex-1">
                <div className="text-ink-2">
                  {dateTime(x.payment.at)} · {PAYMENT_METHODS[x.payment.method]}
                  {who(x.payment.by) && <span className="text-muted" title="Кто внёс оплату"> · {who(x.payment.by)}</span>}
                </div>
                {x.payment.note && <div className="text-[12.5px] text-muted">{x.payment.note}</div>}
                {x.payment.voidedAt && (
                  <div className="text-[12.5px] text-bad-ink">
                    Сторно {dateTime(x.payment.voidedAt)}
                    {who(x.payment.voidedBy) && ` (${who(x.payment.voidedBy)})`}: {x.payment.voidReason}
                  </div>
                )}
              </div>
              <b className={cn("shrink-0 tabular-nums", x.payment.voidedAt ? "text-muted line-through" : "text-ok-ink")}>+{money(x.payment.amount)}</b>
              {onVoid && !x.payment.voidedAt && (
                <button type="button" onClick={() => onVoid(x.payment)} className="shrink-0 text-[12.5px] font-medium text-bad-ink hover:underline">
                  Сторно
                </button>
              )}
            </li>
          ) : (
            <li key={x.refund.id} className="flex items-start gap-3 px-3.5 py-2.5 text-[13.5px]">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-ink-2">
                  <Badge tone="red" size="sm">
                    Возврат
                  </Badge>
                  {dateTime(x.refund.at)} · {PAYMENT_METHODS[x.refund.method]}
                </div>
                <div className="text-[12.5px] text-muted">{x.refund.reason}</div>
              </div>
              <b className="shrink-0 text-bad-ink tabular-nums">−{money(x.refund.amount)}</b>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

// ── Оплата ───────────────────────────────────────────────────────────────────

export function PaymentModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const rest = Math.max(0, o.clientPrice - paidAmount(o));
  const [amount, setAmount] = useState(rest ? String(rest) : "");
  const [method, setMethod] = useState<PaymentMethod>("kaspi");
  const [day, setDay] = useState(() => almatyDateInput(Date.now()));
  const [note, setNote] = useState("");
  const [overOk, setOverOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const value = amountOf(amount);
  const over = paidAmount(o) + value - o.clientPrice;
  const submit = async () => {
    const paidAt = moneyMoment(day);
    if (!paidAt) return toast("Укажите дату оплаты", "bad");
    setBusy(true);
    const r = await addPayment(o.id, { amount: value, method, paidAt, note, confirmOverpay: over > 0 && overOk });
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast(`Оплата ${money(value)} внесена`);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Оплата по заказу №${o.number}`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void submit()} disabled={busy || value <= 0 || (over > 0 && !overOk)}>
            Внести {money(value)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormRow label="Сумма, ₸" hint={rest > 0 ? `Осталось оплатить: ${money(rest)}` : "Заказ уже оплачен полностью"}>
          {(id) => <Input id={id} inputMode="numeric" value={amount ? num(value) : ""} onChange={(e) => setAmount(digits(e.target.value))} />}
        </FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Способ оплаты">{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</FormRow>
          <FormRow label="Дата оплаты">{(id) => <DayInput id={id} value={day} onChange={setDay} min={almatyDateInput(Date.parse(o.createdAt))} />}</FormRow>
        </div>
        <FormRow label="Комментарий">{(id) => <Input id={id} value={note} maxLength={300} placeholder="Необязательно: например, «оплатил мастеру наличными»" onChange={(e) => setNote(e.target.value)} />}</FormRow>
        {over > 0 && (
          <label className="flex items-start gap-2.5 rounded-[12px] bg-warn-bg px-3.5 py-3 text-[13.5px] text-warn-ink">
            <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#b07200]" checked={overOk} onChange={(e) => setOverOk(e.target.checked)} />
            <span>
              Это больше цены заказа на <b>{money(over)}</b>. Отметьте, если клиент действительно заплатил больше — переплату потом можно вернуть.
            </span>
          </label>
        )}
      </div>
    </Modal>
  );
}

// ── Сторно ───────────────────────────────────────────────────────────────────

export function VoidModal({ o, payment, onClose }: { o: Order; payment: Payment; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await voidPayment(o.id, payment.id, reason);
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast("Платёж сторнирован — долг и статус пересчитаны", "info");
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Сторно оплаты ${money(payment.amount)}`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Не сторнировать
          </Button>
          <Button variant="danger" icon={Ban} onClick={() => void submit()} disabled={busy || reason.trim().length < 3}>
            Сторнировать
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[14px] text-ink-2">
          Платёж от {dateTime(payment.at)} ({PAYMENT_METHODS[payment.method]}) останется в списке с пометкой «сторно», но в оплаченную сумму входить не будет. Долг клиента и статус заказа пересчитаются.
        </p>
        <FormRow label="Причина" required>
          {(id) => <Textarea id={id} rows={2} maxLength={300} placeholder="Например: внесли дважды по ошибке" value={reason} onChange={(e) => setReason(e.target.value)} />}
        </FormRow>
      </div>
    </Modal>
  );
}

// ── Возврат ──────────────────────────────────────────────────────────────────

export function RefundModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const received = netReceived(o);
  const lastMethod = [...o.payments].reverse().find((p) => !p.voidedAt)?.method ?? "kaspi";
  const [amount, setAmount] = useState(received > 0 ? String(received) : "");
  const [method, setMethod] = useState<PaymentMethod>(lastMethod);
  const [day, setDay] = useState(() => almatyDateInput(Date.now()));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const value = amountOf(amount);
  const full = value === received;
  const finished = FINISHED_STATUSES.includes(o.status);
  const submit = async () => {
    const at = moneyMoment(day);
    if (!at) return toast("Укажите дату возврата", "bad");
    setBusy(true);
    const r = await addRefund(o.id, { amount: value, method, at, reason });
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast(full && finished ? `Возврат ${money(value)} оформлен — заказ в статусе «Возврат»` : `Возврат ${money(value)} оформлен`, "info");
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Возврат по заказу №${o.number}`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="danger" icon={RotateCcw} onClick={() => void submit()} disabled={busy || value <= 0 || value > received || reason.trim().length < 3}>
            Вернуть {money(value)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormRow label="Сумма, ₸" hint={`Получено от клиента: ${money(received)}`}>
          {(id) => <Input id={id} inputMode="numeric" value={amount ? num(value) : ""} onChange={(e) => setAmount(digits(e.target.value))} />}
        </FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Способ возврата">{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</FormRow>
          <FormRow label="Дата возврата">{(id) => <DayInput id={id} value={day} onChange={setDay} min={almatyDateInput(Date.parse(o.createdAt))} />}</FormRow>
        </div>
        <FormRow label="Причина" required>
          {(id) => <Textarea id={id} rows={2} maxLength={300} placeholder="Например: клиент недоволен качеством" value={reason} onChange={(e) => setReason(e.target.value)} />}
        </FormRow>
        <p className="rounded-[12px] bg-[#f8f6f1] px-3.5 py-3 text-[13px] text-ink-2">
          {!finished
            ? "Клиенту вернётся предоплата, заказ останется отменённым."
            : full
              ? "Вы возвращаете всё полученное: заказ перейдёт в «Возврат» и не войдёт в выручку."
              : "Частичный возврат уменьшит выручку и маржу заказа, статус не изменится."}
        </p>
      </div>
    </Modal>
  );
}

// ── Выплата исполнителю за этот заказ ────────────────────────────────────────

export function OrderPayoutModal({ o, executorName, onClose }: { o: Order; executorName: string; onClose: () => void }) {
  const [method, setMethod] = useState<PaymentMethod>("kaspi");
  const [day, setDay] = useState(() => almatyDateInput(Date.now()));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const amount = payout(o);
  const submit = async () => {
    const at = moneyMoment(day);
    if (!at || !o.executorId) return toast("Укажите дату выплаты", "bad");
    setBusy(true);
    const r = await createPayout(o.executorId, [o.id], { method, at, note });
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast(`Выплата ${money(amount)} проведена — исполнитель получил уведомление`);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Выплата исполнителю"
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button icon={Wallet} onClick={() => void submit()} disabled={busy}>
            Выплатить {money(amount)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[14px] text-ink-2">
          {shortName(executorName)} получает <b className="text-ink">{money(amount)}</b> за заказ №{o.number}. Выплата попадёт в реестр «Выплаты мастерам», исполнитель получит уведомление. Ошибку можно отменить в течение суток.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Способ">{(id) => <MethodSelect id={id} value={method} onChange={setMethod} />}</FormRow>
          <FormRow label="Дата выплаты">{(id) => <DayInput id={id} value={day} onChange={setDay} min={almatyDateInput(Date.parse(o.createdAt))} />}</FormRow>
        </div>
        <FormRow label="Комментарий">{(id) => <Input id={id} value={note} maxLength={300} placeholder="Необязательно" onChange={(e) => setNote(e.target.value)} />}</FormRow>
      </div>
    </Modal>
  );
}

// ── Закрытие с замечаниями ───────────────────────────────────────────────────

/** Закрыть заказ с долгом клиента или без выплаты исполнителю — решение владельца, причина остаётся в истории. */
export function CloseModal({ o, problems, onClose }: { o: Order; problems: string[]; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await changeStatus(o.id, "closed", reason.trim());
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast(`Заказ №${o.number} закрыт`, "info");
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Закрыть заказ №${o.number}?`}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Не закрывать
          </Button>
          <Button icon={CircleCheck} onClick={() => void submit()} disabled={busy || reason.trim().length < 3}>
            Закрыть заказ
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[14px] text-ink-2">
          У заказа есть незакрытые деньги: <b className="text-ink">{problems.join(", ")}</b>. Закрыть так может только владелец — причина попадёт в историю заказа и в журнал.
        </p>
        <FormRow label="Причина" required>
          {(id) => <Textarea id={id} rows={2} maxLength={300} placeholder="Например: долг списан по договорённости с клиентом" value={reason} onChange={(e) => setReason(e.target.value)} />}
        </FormRow>
      </div>
    </Modal>
  );
}
