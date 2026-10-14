// Карточка клиента (ТЗ п.5 «Клиенты: звонки, оплаты, файлы»): все звонки клиента с записями, оплаты и возвраты по его
// заказам и файлы заказов и переписки. Записи и файлы — по подписанным ссылкам на 15 минут (src/data/files.ts).
import { ArrowUpRight, FileText, Mic, Paperclip, Phone, PhoneIncoming, PhoneMissed, PhoneOutgoing, Wallet, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PAYMENT_METHODS, type Tone } from "../data/catalog";
import { clientPayments, clientPaymentTotals, type ClientFile, type ClientFileGroup, type ClientPaymentRow } from "../data/clientRecords";
import { useFileQuery } from "../data/files";
import { useMe, useTeam } from "../data/hooks";
import { can } from "../data/permissions";
import type { Call, Order } from "../data/types";
import { cn, dateTime, money, plural } from "../lib/format";
import { SignedAudio, SignedImg } from "./SignedMedia";
import { Badge, Card, Loading, Tabs } from "./ui";

type Tab = "calls" | "payments" | "files";

/** Вкладки «Звонки», «Оплаты», «Файлы». orders — заказы клиента из clients.detail (оплаты считаются по ним). */
export function ClientRecords({ clientId, orders, className }: { clientId: string; orders: Order[]; className?: string }) {
  // Вкладки по правам (ТЗ п.5.12): звонки — «Звонки и записи», оплаты — «Цена клиента и оплаты».
  const me = useMe();
  const seesCalls = can(me, "calls.view");
  const seesMoney = can(me, "money.view");
  const [tab, setTab] = useState<Tab>(seesCalls ? "calls" : seesMoney ? "payments" : "files");
  const id = clientId as Id<"clients">;
  const calls = useFileQuery(api.clientRecords.calls, seesCalls ? { clientId: id } : "skip");
  const files = useFileQuery(api.clientRecords.files, { clientId: id });
  const payments = clientPayments(orders);
  const fileCount = files ? files.reduce((s, g) => s + g.files.length, 0) : undefined;
  return (
    <Card className={className}>
      <Tabs
        items={[
          ...(seesCalls ? [{ id: "calls" as const, label: "Звонки", count: calls?.length }] : []),
          ...(seesMoney ? [{ id: "payments" as const, label: "Оплаты", count: payments.length }] : []),
          { id: "files" as const, label: "Файлы", count: fileCount },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="pt-4">
        {tab === "calls" && (calls === undefined ? <Loading className="py-8" /> : <CallList calls={calls ?? []} />)}
        {tab === "payments" && <PaymentList orders={orders} rows={payments} />}
        {tab === "files" && (files === undefined ? <Loading className="py-8" /> : <FileGroups groups={files ?? []} />)}
      </div>
    </Card>
  );
}

const Empty = ({ icon: Icon, text }: { icon: LucideIcon; text: string }) => (
  <div className="flex flex-col items-center gap-2 py-8 text-center text-[14px] text-muted">
    <Icon size={26} strokeWidth={1.6} className="text-faint" aria-hidden />
    {text}
  </div>
);

// ── Звонки ───────────────────────────────────────────────────────────────────

const callKind = (c: Call): { label: string; tone: Tone; icon: LucideIcon } =>
  c.status === "missed"
    ? { label: "Пропущенный", tone: "red", icon: PhoneMissed }
    : c.direction === "out"
      ? { label: "Исходящий", tone: "blue", icon: PhoneOutgoing }
      : { label: "Входящий", tone: "green", icon: PhoneIncoming };
const talk = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

function CallList({ calls }: { calls: Call[] }) {
  const team = useTeam();
  if (!calls.length) return <Empty icon={Phone} text="Звонков с этим клиентом пока нет" />;
  return (
    <ul className="divide-y divide-line">
      {calls.map((c) => {
        const k = callKind(c);
        const op = team.userName(c.operatorId);
        return (
          <li key={c.id} className="py-3 first:pt-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Badge tone={k.tone}>
                <k.icon size={14} aria-hidden /> {k.label}
              </Badge>
              <span className="text-[14px] text-ink-2">{dateTime(c.startedAt)}</span>
              {c.duration !== undefined && <span className="text-[13.5px] text-muted tabular-nums">разговор {talk(c.duration)}</span>}
              {op && <span className="text-[13.5px] text-muted">{op}</span>}
              <Link to={`/calls?open=${c.id}`} className="ml-auto inline-flex items-center gap-1 text-[13.5px] font-medium text-brand-ink">
                Открыть <ArrowUpRight size={15} aria-hidden />
              </Link>
            </div>
            {c.ai?.summary && <p className="mt-1.5 text-[14px] leading-snug text-ink-2">{c.ai.summary}</p>}
            {c.recordingSrc ? (
              <SignedAudio controls preload="none" src={c.recordingSrc} className="mt-2 w-full max-w-[520px]">
                <a href={c.recordingSrc}>Скачать запись</a>
              </SignedAudio>
            ) : (
              c.hasRecording && <p className="mt-1.5 text-[13px] text-muted">Запись есть, но ссылка сейчас недоступна — обновите страницу</p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ── Оплаты ───────────────────────────────────────────────────────────────────

function PaymentList({ orders, rows }: { orders: Order[]; rows: ClientPaymentRow[] }) {
  const team = useTeam();
  const totals = clientPaymentTotals(orders);
  if (!rows.length) return <Empty icon={Wallet} text="Оплат по заказам клиента пока нет" />;
  return (
    <>
      <dl className="mb-3 flex flex-wrap gap-x-8 gap-y-2 text-[14px]">
        <div>
          <dt className="text-muted">Получено</dt>
          <dd className="font-semibold text-ok-ink tabular-nums">{money(totals.received)}</dd>
        </div>
        {totals.refunded > 0 && (
          <div>
            <dt className="text-muted">Возвращено</dt>
            <dd className="font-semibold text-bad-ink tabular-nums">{money(totals.refunded)}</dd>
          </div>
        )}
      </dl>
      <div className="scroll-x">
        <table className="tbl min-w-[720px]">
          <thead>
            <tr>
              <th>Дата</th>
              <th>Заказ</th>
              <th>Операция</th>
              <th>Способ</th>
              <th className="text-right">Сумма</th>
              <th>Комментарий</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const by = team.userName(r.by);
              return (
                <tr key={`${r.kind}:${r.id}`} className={cn(r.voided && "text-muted")}>
                  <td className="whitespace-nowrap">{dateTime(r.at)}</td>
                  <td className="font-semibold text-ink">
                    <Link to={`/orders/${r.orderId}`}>№{r.number}</Link>
                  </td>
                  <td>
                    {r.kind === "refund" ? <Badge tone="red">Возврат</Badge> : r.voided ? <Badge tone="gray">Сторно</Badge> : <Badge tone="green">Оплата</Badge>}
                  </td>
                  <td className="whitespace-nowrap">{PAYMENT_METHODS[r.method]}</td>
                  <td className={cn("text-right font-semibold whitespace-nowrap tabular-nums", r.voided ? "line-through" : r.kind === "refund" ? "text-bad-ink" : "text-ink")}>
                    {r.kind === "refund" ? `−${money(r.amount)}` : money(r.amount)}
                  </td>
                  <td className="max-w-[280px] text-[13.5px]">
                    {r.voided ? `Сторно ${dateTime(r.voided.at)}${r.voided.reason ? `: ${r.voided.reason}` : ""}` : r.note}
                    {by && <span className="block text-[12.5px] text-muted">{r.kind === "refund" ? "оформил" : "внёс"}: {by}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ── Файлы ────────────────────────────────────────────────────────────────────

function FileGroups({ groups }: { groups: ClientFileGroup[] }) {
  if (!groups.length) return <Empty icon={Paperclip} text="Файлов в заказах и переписке клиента пока нет" />;
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <section key={g.key}>
          <h3 className="mb-2 flex flex-wrap items-baseline gap-x-2.5 text-[14.5px]">
            <Link to={g.link} className="font-semibold text-ink hover:text-brand-ink">
              {g.title}
            </Link>
            <span className="text-[13px] text-muted">
              {dateTime(g.at)} · {g.files.length} {plural(g.files.length, "файл", "файла", "файлов")}
            </span>
          </h3>
          <div className="flex flex-wrap items-start gap-2.5">
            {g.files.map((f) => (
              <FileTile key={f.id} f={f} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function FileTile({ f }: { f: ClientFile }) {
  if (f.kind === "image")
    return (
      <a href={f.src} target="_blank" rel="noreferrer" title={f.name} className="block h-[72px] w-[104px] overflow-hidden rounded-[10px] border border-line bg-[linear-gradient(135deg,#f1efe9,#dfe7f1)] hover:border-brand-line">
        <SignedImg src={f.src} alt={f.name} className="h-full w-full object-cover" fallback={<span className="flex h-full items-center justify-center px-2 text-center text-[11.5px] text-muted">{f.name}</span>} />
      </a>
    );
  if (f.kind === "audio")
    return (
      <div className="flex min-w-[260px] flex-col gap-1 rounded-[10px] border border-line bg-white px-3 py-2">
        <span className="inline-flex items-center gap-1.5 text-[13px] text-ink-2">
          <Mic size={14} className="text-brand-ink" aria-hidden /> {f.name}
          {f.at && <span className="text-muted">· {dateTime(f.at)}</span>}
        </span>
        {f.src && <SignedAudio controls preload="none" src={f.src} className="h-9 w-full" />}
      </div>
    );
  const inner = (
    <>
      <FileText size={16} className="shrink-0 text-brand-ink" aria-hidden />
      <span className="truncate">{f.name}</span>
    </>
  );
  const cls = "inline-flex max-w-[240px] items-center gap-2 rounded-[10px] border border-line bg-white px-3 py-2 text-[13px] text-ink-2";
  return f.src ? (
    <a href={f.src} target="_blank" rel="noreferrer" className={cls + " hover:border-brand-line"}>
      {inner}
    </a>
  ) : (
    <span className={cls}>{inner}</span>
  );
}
