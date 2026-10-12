import {
  AlignLeft,
  Ban,
  Building2,
  CalendarDays,
  ChevronDown,
  CircleAlert,
  CreditCard,
  FileText,
  History,
  Link2,
  MapPin,
  MessageSquareText,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Rocket,
  Search,
  Star,
  UserPlus,
  UserRound,
  Wallet,
  ChartNoAxesColumn,
  BadgeCheck,
  CircleDollarSign,
  CircleCheck,
  type LucideIcon,
} from "lucide-react";
import { useQuery } from "convex/react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ORDER_STATUS, PAYMENT_METHODS, STAFF_TRANSITIONS, TRANSITION_LABEL, URGENCY, categoryById, serviceById } from "../data/catalog";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useMe, useNow, useTeam } from "../data/hooks";
import { EXEC_STATE, debt, executorState, isOverdue, margin, marginPct, paidAmount, payout, paymentState, rankExecutors, type Load } from "../data/logic";
import { addPayment, assignExecutor, changeStatus, toast, updateFinance, updateOrderInfo } from "../data/store";
import type { Actor, Executor, HistoryEvent, HistoryKind, Order, OrderStatus, PaymentMethod, Urgency, User } from "../data/types";
import { OrderChat } from "../components/OrderChat";
import { Source, ServiceGlyph } from "../components/icons";
import { Avatar, BackLink, Badge, Button, Card, DotBadge, EmptyState, FormRow, IconTile, Input, Loading, Menu, MenuItem, Modal, Segmented, Select, Textarea, Toggle } from "../components/ui";
import { CitySelect, ServiceSelect } from "./drawers";
import { cn, dateTime, digits, money, num, phone, shortName, toLocalInput } from "../lib/format";

/** Данные карточки с сервера — для вложенных блоков (подбор, история, подсказка). */
interface Detail {
  orders: Load[];
  executors: Executor[];
  history: HistoryEvent[];
  users: User[];
  clientName: string;
}
const DetailCtx = createContext<Detail | null>(null);
const useDetail = () => useContext(DetailCtx)!;

export default function OrderDetail() {
  const { id } = useParams();
  const me = useMe()!;
  const team = useTeam();
  const d = useQuery(api.orders.detail, { id: id as Id<"orders"> });
  const db = useMemo<Detail | null>(
    () => (d ? { orders: d.load, executors: d.executors, history: d.history, users: team.users, clientName: d.client?.name ?? "Клиент" } : null),
    [d, team.users],
  );
  const now = useNow();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const o = d?.order;
  const [modal, setModal] = useState<null | "assign" | "info" | "finance" | "payment" | "cancel">(null);

  useEffect(() => {
    if (params.get("assign")) setModal("assign");
    if (params.get("cancel")) setModal("cancel");
    if (params.get("assign") || params.get("cancel")) setParams({}, { replace: true });
  }, [params, setParams]);

  if (d === undefined) return <Loading />;
  if (!o || !db)
    return (
      <div className="card">
        <EmptyState icon={FileText} title="Заказ не найден" text="Возможно, его удалили или ссылка устарела." action={<Button onClick={() => nav("/orders")}>К списку заказов</Button>} />
      </div>
    );

  const client = d!.client ?? { id: o.clientId, name: o.clientName, phone: o.clientPhone };
  const ex = db.executors.find((e) => e.id === o.executorId);
  const nameOf = (a: Actor) => (a.type === "client" ? client.name : a.type === "user" ? (team.users.find((u) => u.id === a.id)?.name ?? "Сотрудник") : "Система");
  const overdue = isOverdue(o, now);
  const st = ORDER_STATUS[o.status];
  const transitions = STAFF_TRANSITIONS[o.status];
  const canAssign = ["new", "awaiting_executor", "assigned", "accepted"].includes(o.status);

  const go = async (to: OrderStatus) => {
    if (to === "cancelled") return setModal("cancel");
    const r = await changeStatus(o.id, to);
    if (!r.ok) {
      toast(r.error, "bad");
      if (to === "awaiting_executor") setModal("finance");
      return;
    }
    toast(to === "awaiting_executor" ? `Заказ №${o.number} в ленте — подходящие исполнители получили уведомление` : `Статус: ${ORDER_STATUS[to].label}`);
  };

  return (
    <DetailCtx.Provider value={db}>
      <BackLink to="/orders">Назад к заказам</BackLink>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[28px] font-bold tracking-[-0.025em] text-ink sm:text-[32px]">Заказ №{o.number}</h1>
            <DotBadge tone={overdue ? "red" : st.tone} size="lg">
              {overdue ? `Просрочка · ${st.label}` : st.label}
            </DotBadge>
          </div>
          <div className="mt-1 text-[15px] text-muted">
            Клиент:{" "}
            {me.role === "manager" ? (
              <span className="font-medium text-ink-2">{shortName(client.name)}</span>
            ) : (
              <Link to={`/clients/${client.id}`} className="font-medium text-ink-2 hover:text-brand-ink">
                {shortName(client.name)}
              </Link>
            )}{" "}
            · <a href={`tel:+${client.phone}`} className="hover:text-brand-ink">{phone(client.phone)}</a>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          {canAssign && (
            <Button variant="secondary" size="lg" icon={UserPlus} className="h-[50px] text-[15px]" onClick={() => setModal("assign")}>
              {ex ? "Сменить исполнителя" : "Назначить исполнителя"}
            </Button>
          )}
          <Menu
            width={300}
            trigger={(toggle) => (
              <Button size="lg" icon={Pencil} iconRight={ChevronDown} className="h-[50px] text-[15px]" onClick={toggle} disabled={!transitions.length}>
                Изменить статус
              </Button>
            )}
          >
            {(close) => (
              <>
                <div className="px-3 pt-1.5 pb-1 text-[12px] font-semibold tracking-wide text-faint uppercase">Следующий шаг</div>
                {transitions.map((t) => (
                  <MenuItem key={t} danger={t === "cancelled" || t === "refund"} onClick={() => (close(), void go(t))}>
                    <span className="flex items-center gap-2">
                      {t !== "cancelled" && t !== "refund" && <span className={cn("h-2 w-2 rounded-full", DOT[ORDER_STATUS[t].tone])} />}
                      {TRANSITION_LABEL[t] ?? ORDER_STATUS[t].label}
                    </span>
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
        </div>
      </div>

      <NextStep o={o} onFinance={() => setModal("finance")} onAssign={() => setModal("assign")} onPay={() => setModal("payment")} go={go} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.18fr_1fr]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="Основная информация"
            action={
              <button onClick={() => setModal("info")} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink hover:text-brand-deep">
                <Pencil size={16} /> Редактировать
              </button>
            }
          >
            <dl className="divide-y divide-line">
              <InfoRow icon={<ServiceGlyph serviceId={o.serviceId} />} label="Услуга">
                {serviceById(o.serviceId).label}
              </InfoRow>
              <InfoRow icon={<AlignLeft size={20} className="text-muted" />} label="Описание">
                <span className="font-normal text-ink-2">{o.description}</span>
              </InfoRow>
              <InfoRow icon={<MapPin size={20} className="text-muted" />} label="Адрес">
                {o.address || <span className="text-warn-ink">не указан</span>}
              </InfoRow>
              <InfoRow icon={<Building2 size={20} className="text-muted" />} label="Город">
                {o.city}
              </InfoRow>
              <InfoRow icon={<CalendarDays size={20} className="text-muted" />} label="Дедлайн">
                <span className={cn(overdue && "text-bad")}>{dateTime(o.deadline)}</span>
              </InfoRow>
              <InfoRow icon={<CircleAlert size={20} className="text-bad" />} label="Приоритет">
                <PriorityBadge p={o.priority} />
              </InfoRow>
              <InfoRow icon={<Link2 size={20} className="text-muted" />} label="Источник">
                <Source source={o.source} className="font-medium" />
              </InfoRow>
            </dl>
          </Card>

          <Card title="Комментарии и файлы" titleExtra={o.files.length > 0 && <span className="inline-flex items-center gap-1 text-[13px] font-normal text-muted"><Paperclip size={14} />{o.files.length}</span>}>
            <OrderChat orderId={o.id} messages={d!.messages} me={me} nameOf={nameOf} />
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="Финансы"
            action={
              <button onClick={() => setModal("finance")} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink hover:text-brand-deep">
                <Pencil size={16} /> Редактировать
              </button>
            }
          >
            <FinanceTiles o={o} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-[#f8f6f1] px-4 py-3 text-[13.5px]">
              <div className="text-ink-2">
                Оплачено <b className="text-ink tabular-nums">{money(paidAmount(o))}</b> из {money(o.clientPrice)}
                {debt(o) > 0 && (
                  <>
                    {" "}
                    · долг <b className="text-bad-ink tabular-nums">{money(debt(o))}</b>
                  </>
                )}
                <span className="mx-2 text-line-strong">|</span>
                Исполнителю: <b className={o.payoutPaid ? "text-ok-ink" : "text-ink"}>{o.payoutPaid ? "выплачено" : "не выплачено"}</b>
              </div>
              {o.clientPrice > 0 && paidAmount(o) < o.clientPrice && !["new", "awaiting_executor", "cancelled"].includes(o.status) && (
                <Button size="sm" variant="secondary" icon={Plus} onClick={() => setModal("payment")}>
                  Внести оплату
                </Button>
              )}
            </div>
          </Card>

          <Card
            title="Исполнитель"
            action={
              canAssign && ex ? (
                <button onClick={() => setModal("assign")} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink hover:text-brand-deep">
                  <Pencil size={16} /> Изменить исполнителя
                </button>
              ) : undefined
            }
          >
            {ex ? (
              <div className="flex flex-wrap items-center gap-4">
                <Link to={`/executors/${ex.id}`} className="flex min-w-0 flex-1 items-center gap-4">
                  <Avatar name={ex.name} size={76} variant="person" status={executorState(ex, db.orders) === "off" ? "red" : "green"} />
                  <div className="min-w-0">
                    <div className="truncate text-[18px] font-bold text-ink">{shortName(ex.name)}</div>
                    <div className="mt-0.5 text-[14px] text-muted">
                      Специализация: <span className="text-ink-2">{ex.categories.map((c) => categoryById(c).label).join(", ")}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[14px] text-ink-2">
                      <Star size={16} className="fill-[#ffb547] text-[#ffb547]" />
                      {ex.rating.toFixed(1)} <span className="text-muted">({ex.reviews} отзывов)</span>
                    </div>
                  </div>
                </Link>
                <div className="flex flex-col items-start gap-2 sm:items-end">
                  <DotBadge tone={EXEC_STATE[executorState(ex, db.orders)].tone}>{o.status === "assigned" ? "Ждём подтверждения" : EXEC_STATE[executorState(ex, db.orders)].label}</DotBadge>
                  {o.assignedAt && <span className="text-[13.5px] text-muted">Назначен: {dateTime(o.assignedAt)}</span>}
                  <a href={`tel:+${ex.phone}`} className="inline-flex items-center gap-1.5 text-[13.5px] font-medium text-brand-ink">
                    <Phone size={14} /> {phone(ex.phone)}
                  </a>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-dashed border-line-strong px-4 py-4">
                <div className="flex items-center gap-3">
                  <IconTile icon={UserRound} tone="gray" />
                  <div>
                    <div className="text-[15px] font-semibold text-ink">Исполнитель не назначен</div>
                    <div className="text-[13.5px] text-muted">{o.status === "awaiting_executor" ? "Заказ в ленте — первый подходящий исполнитель заберёт его" : "Опубликуйте в ленту или назначьте вручную"}</div>
                  </div>
                </div>
                {canAssign && (
                  <Button size="sm" variant="secondary" icon={UserPlus} onClick={() => setModal("assign")}>
                    Назначить
                  </Button>
                )}
              </div>
            )}
          </Card>

          <Card title="История действий">
            <HistoryList />
          </Card>
        </div>
      </div>

      {modal === "assign" && <AssignModal o={o} onClose={() => setModal(null)} />}
      {modal === "info" && <InfoModal o={o} onClose={() => setModal(null)} />}
      {modal === "finance" && <FinanceModal o={o} onClose={() => setModal(null)} />}
      {modal === "payment" && <PaymentModal o={o} onClose={() => setModal(null)} />}
      {modal === "cancel" && <CancelModal o={o} onClose={() => setModal(null)} />}
    </DetailCtx.Provider>
  );
}

const DOT: Record<string, string> = { blue: "bg-blue", yellow: "bg-brand", sky: "bg-sky", violet: "bg-violet", amber: "bg-warn", green: "bg-ok", red: "bg-bad", orange: "bg-orange", gray: "bg-faint" };

function InfoRow({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[28px_110px_1fr] items-start gap-3 py-3 sm:grid-cols-[28px_170px_1fr]">
      <span className="flex h-6 items-center">{icon}</span>
      <dt className="text-[14.5px] leading-6 text-ink-2">{label}</dt>
      <dd className="min-w-0 text-[14.5px] leading-6 font-medium text-ink">{children}</dd>
    </div>
  );
}

export function PriorityBadge({ p }: { p: Urgency }) {
  const u = URGENCY[p];
  return (
    <DotBadge tone={u.tone === "gray" ? "blue" : u.tone}>
      {u.label}
    </DotBadge>
  );
}

function FinanceTiles({ o }: { o: Order }) {
  const ps = paymentState(o);
  const tiles: { icon: LucideIcon; tone: "green" | "blue" | "violet" | "amber"; label: string; value: ReactNode; sub?: ReactNode }[] = [
    { icon: Wallet, tone: "green", label: "Цена клиента", value: o.clientPrice ? money(o.clientPrice) : "—" },
    { icon: UserRound, tone: "blue", label: "Выплата исполнителю", value: o.clientPrice ? money(payout(o)) : "—", sub: o.payoutMode === "percent" ? <span className="text-muted">{o.payoutValue}% от цены</span> : undefined },
    {
      icon: ChartNoAxesColumn,
      tone: "violet",
      label: "Маржа",
      value: o.clientPrice ? money(margin(o)) : "—",
      sub: o.clientPrice ? <span className={cn("font-semibold", marginPct(o) >= 20 ? "text-ok" : "text-warn-ink")}>↗ {marginPct(o)}%</span> : undefined,
    },
    { icon: CreditCard, tone: "amber", label: "Статус оплаты", value: <Badge tone={ps.tone} className="mt-1">{ps.label}</Badge> },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 2xl:grid-cols-4">
      {tiles.map((t) => (
        <div key={t.label} className="flex min-w-0 flex-col rounded-[14px] border border-line p-4">
          <IconTile icon={t.icon} tone={t.tone} size={46} />
          <div className="mt-3 text-[13px] leading-tight text-muted">{t.label}</div>
          <div className="mt-auto pt-1 text-[21px] font-bold tracking-[-0.01em] whitespace-nowrap text-ink tabular-nums sm:text-[22px]">{t.value}</div>
          <div className="min-h-[18px] text-[13px]">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

/** Подсказка «что делать дальше» — главный способ сделать CRM простой. */
function NextStep({ o, onFinance, onAssign, onPay, go }: { o: Order; onFinance: () => void; onAssign: () => void; onPay: () => void; go: (s: OrderStatus) => void | Promise<void> }) {
  const db = useDetail();
  const fits = useMemo(() => rankExecutors(o, db.executors, db.orders).filter((x) => x.fits && x.state !== "off").length, [o, db.executors, db.orders]);
  let icon: LucideIcon = Rocket;
  let tone: "yellow" | "amber" | "green" | "violet" = "yellow";
  let text: ReactNode = null;
  let action: ReactNode = null;
  if (o.status === "new" && (o.clientPrice <= 0 || payout(o) <= 0)) {
    icon = CircleDollarSign;
    text = <><b>Шаг 1 из 2.</b> Укажите цену для клиента и выплату исполнителю.</>;
    action = <Button size="sm" onClick={onFinance}>Указать цену</Button>;
  } else if (o.status === "new") {
    text = <><b>Шаг 2 из 2.</b> Опубликуйте заказ в ленту — его увидят {fits} подходящих исполнителей. Или назначьте вручную.</>;
    action = (
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={onAssign}>Назначить</Button>
        <Button size="sm" icon={Rocket} onClick={() => go("awaiting_executor")}>Опубликовать</Button>
      </div>
    );
  } else if (o.status === "awaiting_executor") {
    tone = "violet";
    icon = Search;
    text = <>Заказ в ленте. Ждём, когда исполнитель возьмёт его (подходят: {fits}). Можно не ждать и назначить вручную.</>;
    action = <Button size="sm" variant="secondary" onClick={onAssign}>Назначить вручную</Button>;
  } else if (o.status === "assigned") {
    tone = "amber";
    icon = UserPlus;
    text = <>Исполнитель назначен и должен подтвердить заказ в своём кабинете.</>;
  } else if (o.status === "done" || o.status === "awaiting_payment") {
    tone = "amber";
    icon = CreditCard;
    text = <>Работа выполнена. Осталось получить оплату: {money(Math.max(0, o.clientPrice - paidAmount(o)))}.</>;
    action = <Button size="sm" icon={Plus} onClick={onPay}>Внести оплату</Button>;
  } else if (o.status === "paid") {
    tone = "green";
    icon = BadgeCheck;
    text = <>Оплата получена.{!o.payoutPaid && " Отметьте выплату исполнителю и"} закройте заказ.</>;
    action = (
      <div className="flex gap-2">
        {!o.payoutPaid && <Button size="sm" variant="secondary" onClick={onFinance}>Выплата исполнителю</Button>}
        <Button size="sm" variant="success" icon={CircleCheck} onClick={() => go("closed")}>Закрыть заказ</Button>
      </div>
    );
  } else return null;
  const bg = { yellow: "bg-brand-soft/70 border-[#ffe3a0]", amber: "bg-warn-bg/70 border-[#ffe2b0]", green: "bg-ok-bg/70 border-[#bfeed5]", violet: "bg-violet-bg/70 border-[#dcd1ff]" }[tone];
  return (
    <div className={cn("mb-4 flex flex-wrap items-center gap-3 rounded-[14px] border px-4 py-3", bg)}>
      <IconTile icon={icon} tone={tone} size={38} />
      <div className="min-w-[220px] flex-1 text-[14.5px] text-ink-2">{text}</div>
      {action}
    </div>
  );
}

const HIST_ICON: Record<HistoryKind, { icon: LucideIcon; tone: "green" | "blue" | "amber" | "gray" | "violet" }> = {
  created: { icon: Plus, tone: "green" },
  published: { icon: Rocket, tone: "violet" },
  assigned: { icon: UserPlus, tone: "blue" },
  taken: { icon: UserPlus, tone: "blue" },
  comment: { icon: MessageSquareText, tone: "blue" },
  file: { icon: Paperclip, tone: "gray" },
  status: { icon: History, tone: "amber" },
  finance: { icon: Wallet, tone: "violet" },
  payment: { icon: CreditCard, tone: "green" },
  edited: { icon: Pencil, tone: "gray" },
};

function HistoryList({ limit = 8 }: { limit?: number }) {
  const db = useDetail();
  const [all, setAll] = useState(false);
  const items = db.history;
  const shown = all ? items : items.slice(-limit);
  const actorName = (a: Actor) => (a.type === "client" ? shortName(db.clientName) : a.type === "user" ? shortName(db.users.find((u) => u.id === a.id)?.name ?? "") : "Система");
  return (
    <div>
      {items.length > limit && !all && (
        <button onClick={() => setAll(true)} className="mb-2 text-[13.5px] font-medium text-brand-ink">
          Показать всю историю ({items.length})
        </button>
      )}
      <ol className="relative">
        {shown.map((h, i) => {
          const m = HIST_ICON[h.kind];
          return (
            <li key={h.id} className="relative flex gap-3 pb-3 pl-6 last:pb-0">
              <span className="absolute top-[14px] left-[3px] h-[9px] w-[9px] rounded-full bg-[#d4cec2]" />
              {i < shown.length - 1 && <span className="absolute top-[24px] bottom-0 left-[7px] w-px bg-line-strong" />}
              <IconTile icon={m.icon} tone={m.tone} size={36} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink">{h.text}</div>
                <div className="text-[13px] text-muted">{actorName(h.actor)}</div>
              </div>
              <div className="shrink-0 pt-0.5 text-right text-[12.5px] whitespace-nowrap text-muted">{dateTime(h.at)}</div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ── Модалки ──────────────────────────────────────────────────────────────────

function AssignModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const db = useDetail();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const ranked = rankExecutors(o, db.executors, db.orders);
  const list = ranked.filter((x) => (showAll || x.fits) && (!q || x.e.name.toLowerCase().includes(q.toLowerCase())));
  const noPrice = o.clientPrice <= 0 || payout(o) <= 0;
  return (
    <Modal open onClose={onClose} title="Назначить исполнителя" width={640}>
      <p className="-mt-1 mb-3 text-[14px] text-muted">
        {serviceById(o.serviceId).label} · {o.city}. Сверху — подходящие по специализации и городу, свободные и с высоким рейтингом.
      </p>
      {noPrice && <div className="mb-3 rounded-[10px] bg-warn-bg px-3.5 py-2.5 text-[13.5px] text-warn-ink">Сначала укажите цену клиента и выплату — исполнитель должен видеть, сколько получит.</div>}
      <Input icon={Search} placeholder="Поиск по имени" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-3 flex flex-col gap-2">
        {list.map(({ e, state, load, fits }) => (
          <div key={e.id} className={cn("flex items-center gap-3 rounded-[12px] border p-3", o.executorId === e.id ? "border-brand bg-brand-soft/40" : "border-line")}>
            <Avatar name={e.name} size={44} variant="person" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[15px] font-semibold text-ink">{e.name}</span>
                <Badge tone={EXEC_STATE[state].tone} size="sm">
                  {EXEC_STATE[state].label}
                </Badge>
                {!fits && <Badge tone="gray" size="sm">не профиль</Badge>}
              </div>
              <div className="mt-0.5 truncate text-[13px] text-muted">
                {e.city} · {e.categories.map((c) => categoryById(c).label).join(", ")} · в работе: {load} · <Star size={12} className="inline -translate-y-px fill-[#ffb547] text-[#ffb547]" /> {e.rating}
              </div>
            </div>
            <Button
              size="sm"
              variant={o.executorId === e.id ? "soft" : "primary"}
              disabled={busy || state === "off" || noPrice || o.executorId === e.id}
              onClick={async () => {
                setBusy(true);
                const r = await assignExecutor(o.id, e.id);
                setBusy(false);
                if (!r.ok) return toast(r.error, "bad");
                toast(`${shortName(e.name)} назначен — ждём подтверждения`);
                onClose();
              }}
            >
              {o.executorId === e.id ? "Назначен" : "Назначить"}
            </Button>
          </div>
        ))}
        {list.length === 0 && <div className="py-6 text-center text-[14px] text-muted">Подходящих исполнителей нет.</div>}
      </div>
      {!showAll && (
        <button onClick={() => setShowAll(true)} className="mt-3 text-[14px] font-medium text-brand-ink">
          Показать всех исполнителей
        </button>
      )}
    </Modal>
  );
}

function InfoModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const [serviceId, setServiceId] = useState(o.serviceId);
  const [description, setDescription] = useState(o.description);
  const [city, setCity] = useState(o.city);
  const [address, setAddress] = useState(o.address);
  const [dl, setDl] = useState(toLocalInput(o.deadline));
  const [priority, setPriority] = useState<Urgency>(o.priority);
  return (
    <Modal
      open
      onClose={onClose}
      title="Основная информация"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={async () => {
              const r = await updateOrderInfo(o.id, { serviceId, description, city, address, deadline: new Date(dl).toISOString(), priority });
              if (!r.ok) return toast(r.error, "bad");
              toast("Заказ обновлён");
              onClose();
            }}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormRow label="Услуга">{(id) => <ServiceSelect id={id} value={serviceId} onChange={setServiceId} />}</FormRow>
        <FormRow label="Описание и ТЗ">{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Город">{(id) => <CitySelect id={id} value={city} onChange={setCity} />}</FormRow>
          <FormRow label="Дедлайн">{(id) => <input id={id} type="datetime-local" className="field" value={dl} onChange={(e) => setDl(e.target.value)} />}</FormRow>
        </div>
        <FormRow label="Адрес">{(id) => <Input id={id} icon={MapPin} value={address} onChange={(e) => setAddress(e.target.value)} />}</FormRow>
        <div>
          <div className="mb-2 text-[14px] font-semibold text-ink">Приоритет</div>
          <Segmented
            options={[
              { value: "normal", label: "Обычный" },
              { value: "high", label: "Высокий" },
              { value: "urgent", label: "Срочный" },
            ]}
            value={priority}
            onChange={setPriority}
          />
        </div>
      </div>
    </Modal>
  );
}

function FinanceModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const svc = serviceById(o.serviceId);
  const [price, setPrice] = useState(o.clientPrice ? String(o.clientPrice) : "");
  const [mode, setMode] = useState<Order["payoutMode"]>(o.payoutMode);
  const [value, setValue] = useState(String(o.payoutValue || ""));
  const [paid, setPaid] = useState(o.payoutPaid);
  const p = Number(digits(price)) || 0;
  const v = Number(value.replace(",", ".")) || 0;
  const pay = payout({ clientPrice: p, payoutMode: mode, payoutValue: v });
  const m = p - pay;
  const finished = ["done", "awaiting_payment", "paid", "closed"].includes(o.status);
  return (
    <Modal
      open
      onClose={onClose}
      title="Финансы заказа"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={async () => {
              const r = await updateFinance(o.id, { clientPrice: p, payoutMode: mode, payoutValue: mode === "fixed" ? Number(digits(value)) || 0 : v, payoutPaid: paid });
              if (!r.ok) return toast(r.error, "bad");
              toast("Финансы сохранены");
              onClose();
            }}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormRow label="Цена для клиента, ₸" hint={svc.price[1] > 0 ? `Обычно за «${svc.label}»: ${num(svc.price[0])}–${num(svc.price[1])} ₸` : undefined}>
          {(id) => <Input id={id} inputMode="numeric" value={price ? num(Number(digits(price))) : ""} onChange={(e) => setPrice(digits(e.target.value))} placeholder="28 000" />}
        </FormRow>
        <div>
          <div className="mb-2 text-[14px] font-semibold text-ink">Выплата исполнителю</div>
          <Segmented
            options={[
              { value: "fixed", label: "Фиксированная" },
              { value: "percent", label: "Процент от цены" },
            ]}
            value={mode}
            onChange={(next) => {
              setMode(next);
              setValue(next === "percent" ? String(svc.payoutPct) : String(Math.round((p * svc.payoutPct) / 100 / 500) * 500 || ""));
            }}
          />
          <Input
            className="mt-2"
            inputMode="numeric"
            value={mode === "fixed" ? (value ? num(Number(digits(value))) : "") : value}
            onChange={(e) => setValue(mode === "fixed" ? digits(e.target.value) : e.target.value.replace(/[^\d.,]/g, ""))}
            placeholder={mode === "fixed" ? "20 000" : `${svc.payoutPct}`}
          />
        </div>
        <div className="grid grid-cols-3 gap-2 rounded-[12px] bg-[#f8f6f1] p-3 text-center">
          <div>
            <div className="text-[12px] text-muted">Клиент платит</div>
            <div className="text-[16px] font-bold text-ink tabular-nums">{money(p)}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">Исполнитель получит</div>
            <div className="text-[16px] font-bold text-ink tabular-nums">{money(pay)}</div>
          </div>
          <div>
            <div className="text-[12px] text-muted">Маржа</div>
            <div className={cn("text-[16px] font-bold tabular-nums", m < 0 ? "text-bad" : "text-ok-ink")}>
              {money(m)} {p > 0 && <span className="text-[12px] font-semibold">({Math.round((m / p) * 100)}%)</span>}
            </div>
          </div>
        </div>
        {finished && <Toggle checked={paid} onChange={setPaid} label="Исполнителю выплачено" />}
        <p className="text-[12.5px] text-muted">Изменения финансов попадают в историю заказа. AI эти поля менять не может.</p>
      </div>
    </Modal>
  );
}

function PaymentModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const rest = Math.max(0, o.clientPrice - paidAmount(o));
  const [amount, setAmount] = useState(String(rest));
  const [method, setMethod] = useState<PaymentMethod>("kaspi");
  return (
    <Modal
      open
      onClose={onClose}
      title={`Оплата по заказу №${o.number}`}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            onClick={async () => {
              const r = await addPayment(o.id, Number(digits(amount)) || 0, method);
              if (!r.ok) return toast(r.error, "bad");
              toast("Оплата внесена");
              onClose();
            }}
          >
            Внести {money(Number(digits(amount)) || 0)}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormRow label="Сумма, ₸" hint={`Осталось оплатить: ${money(rest)}`}>
          {(id) => <Input id={id} inputMode="numeric" value={amount ? num(Number(digits(amount))) : ""} onChange={(e) => setAmount(digits(e.target.value))} />}
        </FormRow>
        <FormRow label="Способ оплаты">
          {(id) => (
            <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {(Object.keys(PAYMENT_METHODS) as PaymentMethod[]).map((m) => (
                <option key={m} value={m}>
                  {PAYMENT_METHODS[m]}
                </option>
              ))}
            </Select>
          )}
        </FormRow>
        {o.payments.length > 0 && (
          <div className="rounded-[12px] border border-line p-3 text-[13.5px]">
            <div className="mb-1.5 font-semibold text-ink">Уже оплачено</div>
            {o.payments.map((p) => (
              <div key={p.id} className="flex justify-between py-0.5 text-ink-2">
                <span>
                  {dateTime(p.at)} · {PAYMENT_METHODS[p.method]}
                </span>
                <b className="tabular-nums">{money(p.amount)}</b>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function CancelModal({ o, onClose }: { o: Order; onClose: () => void }) {
  const reasons = ["Клиент передумал", "Не договорились по цене", "Клиент нашёл другого мастера", "Нет свободных исполнителей", "Другое"];
  const [reason, setReason] = useState(reasons[0]!);
  const [other, setOther] = useState("");
  return (
    <Modal
      open
      onClose={onClose}
      title={`Отменить заказ №${o.number}?`}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Не отменять
          </Button>
          <Button
            variant="danger"
            icon={Ban}
            onClick={async () => {
              const r = await changeStatus(o.id, "cancelled", reason === "Другое" ? other.trim() || "Другое" : reason);
              if (!r.ok) return toast(r.error, "bad");
              toast(`Заказ №${o.number} отменён`, "info");
              onClose();
            }}
          >
            Отменить заказ
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-[14px] text-muted">Причина попадёт в историю и в аналитику отказов.{o.executorId && " Исполнитель получит уведомление."}</p>
        <Select value={reason} onChange={(e) => setReason(e.target.value)}>
          {reasons.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
        {reason === "Другое" && <Textarea rows={2} placeholder="Опишите причину" value={other} onChange={(e) => setOther(e.target.value)} />}
      </div>
    </Modal>
  );
}

