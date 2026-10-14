// Переписка с клиентом в карточке заказа (ТЗ п.9.12, п.16.2): куда уйдёт сообщение, «Открыть диалог» и сообщения
// из мессенджера клиента в ленте заказа со статусом доставки. Только владелец и операторы (orderClientChat.feed).
import { Check, CheckCheck, CircleAlert, Clock3, MessagesSquare, PhoneCall, RotateCcw, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { channelLabel, resendReply } from "../data/inbox";
import type { OrderClientMessage, OrderClientThread } from "../data/orderClientChat";
import { report } from "../data/store";
import type { MessageStatus } from "../data/types";
import { cn, shortName, when } from "../lib/format";
import { Avatar } from "./ui";

const DELIVERY: Record<MessageStatus, { icon: LucideIcon; label: string; tone: string }> = {
  sending: { icon: Clock3, label: "отправляется", tone: "text-muted" },
  sent: { icon: Check, label: "отправлено", tone: "text-muted" },
  delivered: { icon: CheckCheck, label: "доставлено", tone: "text-ok-ink" },
  read: { icon: CheckCheck, label: "прочитано", tone: "text-sky" },
  failed: { icon: CircleAlert, label: "не доставлено", tone: "text-bad" },
};

/** Подсказка над полем во вкладке «Клиенту»: в какой канал уйдёт сообщение или почему писать некуда. */
export function ClientTarget({ thread }: { thread: OrderClientThread | null | undefined }) {
  const nav = useNavigate();
  if (thread === undefined) return <p className="px-3 pt-1.5 text-[12.5px] text-muted">Проверяем, где клиент на связи…</p>;
  if (thread === null) return null;
  const open = thread.dialogId ? (
    <button type="button" onClick={() => nav(`/inbox?c=${thread.dialogId}`)} className="inline-flex items-center gap-1 font-semibold text-brand-ink hover:underline">
      <MessagesSquare size={13} aria-hidden /> Открыть диалог
    </button>
  ) : null;
  return (
    <p className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-1.5 text-[12.5px]", thread.target ? "text-muted" : "text-warn-ink")}>
      {thread.target ? (
        <span>Уйдёт клиенту в {channelLabel(thread.target.channel)}. Файлы клиенту не отправляются — они останутся в заказе.</span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <PhoneCall size={13} aria-hidden /> {thread.blocked}. Сообщение сохранится заметкой в заказе.
        </span>
      )}
      {open}
    </p>
  );
}

/** Сообщение из мессенджера клиента в ленте заказа. */
export function ClientFeedItem({ m }: { m: OrderClientMessage }) {
  const [busy, setBusy] = useState(false);
  const out = m.direction === "out";
  const name = out ? (m.authorName ? shortName(m.authorName) : "Автосообщение") : (m.contactName ?? "Клиент");
  const d = out ? DELIVERY[m.status ?? "sent"] : null;
  const retry = async () => {
    setBusy(true);
    report(await resendReply(m.id), "Отправляем ещё раз");
    setBusy(false);
  };
  return (
    <div className="flex items-start gap-3">
      <Avatar name={name} size={40} variant={out ? "person" : "client"} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2.5">
          <span className="text-[14px] font-semibold text-ink">{name}</span>
          <span className="text-[12.5px] text-muted">{when(m.at)}</span>
          <span className="text-[11.5px] font-semibold text-brand-ink">
            {out ? "клиенту" : "от клиента"} · {channelLabel(m.channel)}
          </span>
        </div>
        {m.text && <div className={cn("mt-1.5 inline-block max-w-full rounded-[12px] px-3.5 py-2 text-[14px] leading-snug whitespace-pre-line text-ink-2", out ? "bg-brand-soft" : "bg-[#eef3f9]")}>{m.text}</div>}
        {m.fileUrl && (
          <a href={m.fileUrl} target="_blank" rel="noreferrer" className="mt-1.5 block text-[13px] font-medium text-brand-ink hover:underline">
            {m.fileName ?? "Вложение"}
          </a>
        )}
        {d && (
          <div className={cn("mt-1 flex flex-wrap items-center gap-1 text-[11.5px]", d.tone)}>
            <d.icon size={12} aria-hidden /> {d.label}
            {m.status === "failed" && m.error && <span className="text-bad">: {m.error}</span>}
            {m.status === "failed" && m.authorName && (
              <button type="button" disabled={busy} onClick={() => void retry()} className="ml-1 inline-flex items-center gap-1 font-semibold text-brand-ink hover:underline disabled:opacity-60">
                <RotateCcw size={11} aria-hidden /> Повторить
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
