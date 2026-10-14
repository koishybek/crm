// «Выставить счёт на оплату» в блоке денег заказа (ТЗ п.19.7, п.23.5): ссылка провайдера или Kaspi → «Скопировать» /
// «Отправить клиенту». Оплата по ссылке засчитывается сама (уведомление провайдера), Kaspi — кнопкой «Внести оплату».
import { useQuery } from "convex/react";
import { Copy, Link2, Send, X } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { cancelPayLink, createPayLink, sendPayLink } from "../data/adapterActions";
import { useMe, useNow } from "../data/hooks";
import { intentView, PAY_INFO, PAY_INTENT_STATUS, type PayProvider } from "../data/payIntents";
import { report, toast } from "../data/store";
import type { Order } from "../data/types";
import { dateTime, money } from "../lib/format";
import { paidAmount } from "../data/logic";
import { PAYMENT_BLOCKED } from "../data/money";
import { Badge, Button, FormRow, Input, Modal, Select } from "./ui";

const copyText = (text: string) => {
  void navigator.clipboard?.writeText(text);
  toast("Ссылка скопирована", "info");
};

export function OrderPayLinks({ o }: { o: Order }) {
  const me = useMe();
  const staff = me?.role === "owner" || me?.role === "operator";
  const view = useQuery(api.payments.forOrder, staff ? { orderId: o.id as Id<"orders"> } : "skip");
  const now = useNow();
  const [open, setOpen] = useState(false);
  if (!staff || !view) return null;
  const owed = o.clientPrice - paidAmount(o);
  const canIssue = !PAYMENT_BLOCKED[o.status] && owed > 0;
  if (!view.intents.length && !canIssue) return null;

  return (
    <div className="mt-3 rounded-[12px] border border-line px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[14px] font-semibold text-ink">Счета на оплату</div>
        {canIssue &&
          (view.providers.length ? (
            <Button size="sm" variant="secondary" icon={Link2} onClick={() => setOpen(true)}>
              Выставить счёт на оплату
            </Button>
          ) : (
            <span className="text-[12.5px] text-muted">Онлайн-оплата не подключена — «Настройки → Онлайн-оплата»</span>
          ))}
      </div>
      {view.intents.length > 0 && (
        <ul className="mt-2 divide-y divide-line">
          {view.intents.map((x) => {
            const st = intentView(x.status, x.expiresAt, now);
            const active = st === "created" && !!x.url;
            return (
              <li key={x.id} className="flex flex-wrap items-center gap-2 py-2 text-[13.5px]">
                <b className="tabular-nums text-ink">{money(x.amount)}</b>
                <span className="text-muted">{PAY_INFO[x.provider].label}</span>
                <Badge tone={PAY_INTENT_STATUS[st].tone} size="sm">
                  {PAY_INTENT_STATUS[st].label}
                </Badge>
                <span className="text-[12.5px] text-muted">
                  {dateTime(x.paidAt ?? x.createdAt)} · {x.createdByName}
                  {x.sentAt ? " · отправлен клиенту" : ""}
                </span>
                {x.error && <span className="basis-full text-[12.5px] text-bad-ink">{x.error}</span>}
                {active && (
                  <span className="ml-auto flex gap-1.5">
                    <Button size="sm" variant="ghost" icon={Copy} onClick={() => copyText(x.url!)}>
                      Скопировать
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={Send}
                      onClick={async () => {
                        const r = await sendPayLink(x.id);
                        if (report(r)) toast(r.value.sent ? "Ссылка отправлена клиенту" : r.value.reason, r.value.sent ? "ok" : "info");
                      }}
                    >
                      Отправить клиенту
                    </Button>
                    <Button size="sm" variant="ghost" icon={X} onClick={async () => report(await cancelPayLink(x.id), "Счёт отменён")}>
                      Отменить
                    </Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {open && <IssueModal o={o} owed={owed} providers={view.providers} onClose={() => setOpen(false)} />}
    </div>
  );
}

function IssueModal({ o, owed, providers, onClose }: { o: Order; owed: number; providers: PayProvider[]; onClose: () => void }) {
  const [provider, setProvider] = useState<PayProvider>(providers[0]!);
  const [amount, setAmount] = useState(String(owed));
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const value = Number(amount.replace(/\s/g, ""));
    if (!Number.isFinite(value) || value <= 0) return toast("Укажите сумму больше нуля", "bad");
    setBusy(true);
    const r = await createPayLink(o.id, provider, value);
    setBusy(false);
    if (!report(r)) return;
    copyText(r.value.url);
    onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={`Счёт на оплату — заказ №${o.number}`}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button icon={Link2} disabled={busy} onClick={() => void submit()}>
            {busy ? "Создаём ссылку…" : "Создать ссылку"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {providers.length > 1 && (
          <FormRow label="Способ оплаты">
            {(id) => (
              <Select id={id} value={provider} onChange={(e) => setProvider(e.target.value as PayProvider)}>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {PAY_INFO[p].label}
                  </option>
                ))}
              </Select>
            )}
          </FormRow>
        )}
        <FormRow label="Сумма, ₸" hint={`Долг клиента: ${money(owed)}. Можно выставить часть — например, предоплату.`}>
          {(id) => <Input id={id} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value)} />}
        </FormRow>
        <p className="text-[13px] text-muted">
          {provider === "kaspi"
            ? "Ссылка магазина Kaspi: когда деньги придут, отметьте оплату кнопкой «Внести оплату» (способ — Kaspi)."
            : "Ссылка скопируется сразу; её можно отправить клиенту в мессенджер. Оплата по ней сама появится в заказе."}
        </p>
      </div>
    </Modal>
  );
}
