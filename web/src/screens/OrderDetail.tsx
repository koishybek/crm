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
  RotateCcw,
  Search,
  Star,
  UserPlus,
  UserRound,
  Wallet,
  ChartNoAxesColumn,
  BadgeCheck,
  CircleDollarSign,
  CircleCheck,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ORDER_STATUS, STAFF_TRANSITIONS, TRANSITION_LABEL, URGENCY, categoryById, serviceById } from "../data/catalog";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useMe, useNow, useTeam } from "../data/hooks";
import { EXEC_STATE, debt, executorState, historyLine, isOverdue, netMargin, paidAmount, payout, payoutFor, paymentState, rankExecutors, refundedAmount, revenueOf, type Load } from "../data/logic";
import { closeProblems, isPayoutDue, netReceived, OWNER_MONEY_STATUSES, PAYMENT_BLOCKED, REFUNDABLE_STATUSES, settledStatus, TERMS_WATCH_STATUSES } from "../data/money";
import { useFileQuery } from "../data/files";
import { assignExecutor, changeStatus, toast, updateFinance, updateOrderInfo } from "../data/store";
import type { Actor, Executor, HistoryEvent, HistoryKind, Order, OrderStatus, Payment, Urgency, User } from "../data/types";
import { CloseModal, MoneyLedger, OrderPayoutModal, PaymentModal, RefundModal, VoidModal } from "../components/OrderMoney";
import { OrderDocuments } from "../components/OrderDocuments";
import { OrderPayLinks } from "../components/OrderPayLinks";
import { PbxCallButton } from "../components/PbxCallButton";
import { OrderChat } from "../components/OrderChat";
import { OrderReview } from "../components/OrderReview";
import { ExecutorRating } from "../components/Rating";
import { ratingValue } from "../data/reviews";
import { Source, ServiceGlyph } from "../components/icons";
import { SkillChips, SkillPicker } from "../components/SkillChips";
import { hasSkill } from "../data/skills";
import { Avatar, BackLink, Badge, Button, Card, DotBadge, EmptyState, FormRow, IconTile, Input, Loading, Menu, MenuItem, Modal, Segmented, Select, Textarea } from "../components/ui";
import { CitySelect, ServiceSelect } from "./drawers";
import { DistrictField } from "../components/DistrictSelect";
import { AiMatchPanel } from "../components/AiMatchPanel";
import { cn, date, dateTime, digits, money, num, phone, shortName, toLocalInput } from "../lib/format";

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
  const d = useFileQuery(api.orders.detail, { id: id as Id<"orders"> });
  const db = useMemo<Detail | null>(
    () => (d ? { orders: d.load, executors: d.executors, history: d.history, users: team.users, clientName: d.client?.name ?? "Клиент" } : null),
    [d, team.users],
  );
  const now = useNow();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const o = d?.order;
  const [modal, setModal] = useState<null | "assign" | "info" | "finance" | "payment" | "cancel" | "refund" | "payout" | "close">(null);
  const [voiding, setVoiding] = useState<Payment | null>(null);

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
  const isOwner = me.role === "owner";
  // «Возврат» — не переход статуса, а запись с суммой: пункт «Оформить возврат» владельца.
  const transitions = STAFF_TRANSITIONS[o.status].filter((t) => t !== "refund");
  const canRefund = isOwner && REFUNDABLE_STATUSES.includes(o.status) && netReceived(o) > 0;
  // Деньги оплаченного, закрытого и возвращённого заказа правит только владелец (аудит L-4) — так же проверяет сервер.
  const moneyEditable = isOwner || !OWNER_MONEY_STATUSES.includes(o.status);
  const canPay = !PAYMENT_BLOCKED[o.status] && moneyEditable && paidAmount(o) < o.clientPrice;
  const canAssign = ["new", "awaiting_executor", "assigned", "accepted"].includes(o.status);

  const go = async (to: OrderStatus) => {
    if (to === "cancelled") return setModal("cancel");
    // Как на сервере: «Оплачен» — только когда оплачено всё; закрыть с долгом или без выплаты — владелец с причиной.
    if (to === "paid" && paidAmount(o) < o.clientPrice) {
      toast(`Сначала внесите оплату: не хватает ${money(o.clientPrice - paidAmount(o))}`, "bad");
      return setModal("payment");
    }
    if (to === "closed" && isOwner && closeProblems(o).length) return setModal("close");
    const r = await changeStatus(o.id, to);
    if (!r.ok) {
      toast(r.error, "bad");
      if (to === "awaiting_executor") setModal("finance");
      return;
    }
    const notified = r.value?.notified;
    // «Выполнен» сразу уходит дальше по деньгам — показываем, куда.
    if (to === "done") return toast(`Работа сдана: ${paidAmount(o) >= o.clientPrice ? "заказ оплачен" : `ждём оплату ${money(o.clientPrice - paidAmount(o))}`}`);
    if (to !== "awaiting_executor") return toast(`Статус: ${ORDER_STATUS[to].label}`);
    if (notified) return toast(`Заказ №${o.number} в ленте — уведомили подходящих исполнителей: ${notified}`);
    toast(`Заказ №${o.number} в ленте, но подходящих исполнителей сейчас нет — назначьте вручную или ослабьте требования`, "info");
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
            <PbxCallButton phone={client.phone} orderId={o.id} clientId={client.id} className="ml-3 align-middle" />
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
              <Button size="lg" icon={Pencil} iconRight={ChevronDown} className="h-[50px] text-[15px]" onClick={toggle} disabled={!transitions.length && !canRefund}>
                Изменить статус
              </Button>
            )}
          >
            {(close) => (
              <>
                <div className="px-3 pt-1.5 pb-1 text-[12px] font-semibold tracking-wide text-faint uppercase">Следующий шаг</div>
                {transitions.map((t) => (
                  <MenuItem key={t} danger={t === "cancelled"} onClick={() => (close(), void go(t))}>
                    <span className="flex items-center gap-2">
                      {t !== "cancelled" && <span className={cn("h-2 w-2 rounded-full", DOT[ORDER_STATUS[t].tone])} />}
                      {TRANSITION_LABEL[t] ?? ORDER_STATUS[t].label}
                    </span>
                  </MenuItem>
                ))}
                {canRefund && (
                  <MenuItem danger icon={RotateCcw} hint="Сумма, способ и причина — запись в финансах" onClick={() => (close(), setModal("refund"))}>
                    {TRANSITION_LABEL.refund}
                  </MenuItem>
                )}
              </>
            )}
          </Menu>
        </div>
      </div>

      <NextStep o={o} isOwner={isOwner} onFinance={() => setModal("finance")} onAssign={() => setModal("assign")} onPay={() => setModal("payment")} onPayout={() => setModal("payout")} go={go} />

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
              <InfoRow icon={<Wrench size={20} className="text-muted" />} label="Нужные навыки">
                <SkillChips skills={o.requiredSkills} variant="outline" className="pt-0.5" empty={<span className="font-normal text-muted">не требуются — хватит специализации и города</span>} />
              </InfoRow>
              <InfoRow icon={<AlignLeft size={20} className="text-muted" />} label="Описание">
                <span className="font-normal text-ink-2">{o.description}</span>
              </InfoRow>
              <InfoRow icon={<MapPin size={20} className="text-muted" />} label="Адрес">
                {o.address || <span className="text-warn-ink">не указан</span>}
              </InfoRow>
              <InfoRow icon={<Building2 size={20} className="text-muted" />} label="Город">
                {o.city}
                {o.district && <span className="font-normal text-ink-2"> · район {o.district}</span>}
              </InfoRow>
              <InfoRow icon={<CalendarDays size={20} className="text-muted" />} label="Дедлайн">
                <span className={cn(overdue && "text-bad")}>{dateTime(o.deadline)}</span>
              </InfoRow>
              <InfoRow icon={<CircleAlert size={20} className="text-bad" />} label="Приоритет">
                <PriorityBadge p={o.priority} />
              </InfoRow>
              <InfoRow icon={<Link2 size={20} className="text-muted" />} label="Источник">
                <Source source={o.source} className="font-medium" />
                {o.campaign && <span className="font-normal text-muted"> · кампания «{o.campaign}»</span>}
              </InfoRow>
            </dl>
          </Card>

          <Card title="Комментарии и файлы" titleExtra={o.files.length > 0 && <span className="inline-flex items-center gap-1 text-[13px] font-normal text-muted"><Paperclip size={14} />{o.files.length}</span>}>
            <OrderChat orderId={o.id} messages={d!.messages} me={me} nameOf={nameOf} executorName={ex ? shortName(ex.name) : undefined} />
          </Card>
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Card
            title="Финансы"
            action={
              moneyEditable ? (
                <button onClick={() => setModal("finance")} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink hover:text-brand-deep">
                  <Pencil size={16} /> Редактировать
                </button>
              ) : undefined
            }
          >
            <FinanceTiles o={o} />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-[12px] bg-[#f8f6f1] px-4 py-3 text-[13.5px]">
              <div className="text-ink-2">
                Оплачено <b className="text-ink tabular-nums">{money(paidAmount(o))}</b> из {money(o.clientPrice)}
                {refundedAmount(o) > 0 && (
                  <>
                    {" "}
                    · возвращено <b className="text-bad-ink tabular-nums">{money(refundedAmount(o))}</b>
                  </>
                )}
                {debt(o) > 0 && (
                  <>
                    {" "}
                    · долг <b className="text-bad-ink tabular-nums">{money(debt(o))}</b>
                  </>
                )}
                <span className="mx-2 text-line-strong">|</span>
                Исполнителю: <b className={o.payoutPaid ? "text-ok-ink" : "text-ink"}>{o.payoutPaid ? `выплачено${o.payoutPaidAt ? ` ${date(o.payoutPaidAt)}` : ""}` : "не выплачено"}</b>
              </div>
              <div className="flex flex-wrap gap-2">
                {canPay && (
                  <Button size="sm" variant="secondary" icon={Plus} onClick={() => setModal("payment")}>
                    Внести оплату
                  </Button>
                )}
                {isOwner && isPayoutDue(o) && (
                  <Button size="sm" variant="secondary" icon={Wallet} onClick={() => setModal("payout")}>
                    Выплатить исполнителю
                  </Button>
                )}
              </div>
            </div>
            <MoneyLedger o={o} onVoid={isOwner ? setVoiding : undefined} />
            <OrderPayLinks o={o} />
          </Card>

          <OrderDocuments o={o} />

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
                    <div className="mt-1 text-[14px] text-ink-2">
                      <ExecutorRating e={ex} />
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

          <OrderReview o={o} />

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
      {modal === "refund" && <RefundModal o={o} onClose={() => setModal(null)} />}
      {modal === "payout" && <OrderPayoutModal o={o} executorName={ex?.name ?? "Исполнитель"} onClose={() => setModal(null)} />}
      {modal === "close" && <CloseModal o={o} problems={closeProblems(o)} onClose={() => setModal(null)} />}
      {voiding && <VoidModal o={o} payment={voiding} onClose={() => setVoiding(null)} />}
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
  // Маржа — с учётом возвратов: частичный возврат уменьшает выручку заказа (E1).
  const m = netMargin(o);
  const revenue = revenueOf(o);
  const mPct = revenue > 0 ? Math.round((m / revenue) * 1000) / 10 : 0;
  const refunded = refundedAmount(o) > 0;
  const tiles: { icon: LucideIcon; tone: "green" | "blue" | "violet" | "amber"; label: string; value: ReactNode; sub?: ReactNode }[] = [
    { icon: Wallet, tone: "green", label: "Цена клиента", value: o.clientPrice ? money(o.clientPrice) : "—" },
    { icon: UserRound, tone: "blue", label: "Выплата исполнителю", value: o.clientPrice ? money(payout(o)) : "—", sub: o.payoutMode === "percent" ? <span className="text-muted">{o.payoutValue}% от цены</span> : undefined },
    {
      icon: ChartNoAxesColumn,
      tone: "violet",
      label: refunded ? "Маржа после возврата" : "Маржа",
      value: o.clientPrice ? money(m) : "—",
      sub: o.clientPrice ? <span className={cn("font-semibold", mPct >= 20 ? "text-ok" : "text-warn-ink")}>↗ {mPct}%</span> : undefined,
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
function NextStep({
  o,
  isOwner,
  onFinance,
  onAssign,
  onPay,
  onPayout,
  go,
}: {
  o: Order;
  isOwner: boolean;
  onFinance: () => void;
  onAssign: () => void;
  onPay: () => void;
  onPayout: () => void;
  go: (s: OrderStatus) => void | Promise<void>;
}) {
  const db = useDetail();
  // Тот же подбор, что у ленты и уведомлений: на смене, город, специализация, навыки.
  const fits = useMemo(() => rankExecutors(o, db.executors, db.orders).filter((x) => x.fits).length, [o, db.executors, db.orders]);
  let icon: LucideIcon = Rocket;
  let tone: "yellow" | "amber" | "green" | "violet" = "yellow";
  let text: ReactNode = null;
  let action: ReactNode = null;
  if (o.status === "new" && (o.clientPrice <= 0 || payout(o) <= 0)) {
    icon = CircleDollarSign;
    text = <><b>Шаг 1 из 2.</b> Укажите цену для клиента и выплату исполнителю.</>;
    action = <Button size="sm" onClick={onFinance}>Указать цену</Button>;
  } else if (o.status === "new") {
    text = fits ? (
      <><b>Шаг 2 из 2.</b> Опубликуйте заказ в ленту — его увидят подходящие исполнители: {fits}. Или назначьте вручную.</>
    ) : (
      <><b>Шаг 2 из 2.</b> Сейчас заказ никому не подходит — проверьте нужные навыки и город или назначьте исполнителя вручную.</>
    );
    action = (
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" onClick={onAssign}>Назначить</Button>
        <Button size="sm" icon={Rocket} onClick={() => go("awaiting_executor")}>Опубликовать</Button>
      </div>
    );
  } else if (o.status === "awaiting_executor") {
    tone = "violet";
    icon = Search;
    text = fits ? (
      <>Заказ в ленте. Ждём, когда исполнитель возьмёт его (подходят: {fits}). Можно не ждать и назначить вручную.</>
    ) : (
      <>Заказ в ленте, но сейчас он никому не подходит — проверьте нужные навыки и город или назначьте исполнителя вручную.</>
    );
    action = <Button size="sm" variant="secondary" onClick={onAssign}>Назначить вручную</Button>;
  } else if (o.status === "assigned") {
    tone = "amber";
    icon = UserPlus;
    text = <>Исполнитель назначен и должен подтвердить заказ в своём кабинете.</>;
  } else if (o.status === "done" || o.status === "awaiting_payment") {
    tone = "amber";
    icon = CreditCard;
    text = <>Работа выполнена. Осталось получить оплату: {money(Math.max(0, o.clientPrice - paidAmount(o)))}. Когда клиент оплатит всё, заказ сам станет «Оплачен».</>;
    action = <Button size="sm" icon={Plus} onClick={onPay}>Внести оплату</Button>;
  } else if (o.status === "paid") {
    tone = "green";
    icon = BadgeCheck;
    const due = isPayoutDue(o);
    text = due ? (
      isOwner ? (
        <>Оплата получена. Проведите выплату исполнителю ({money(payout(o))}) и закройте заказ.</>
      ) : (
        <>Оплата получена. Выплату исполнителю ({money(payout(o))}) проводит владелец — после неё заказ можно закрыть.</>
      )
    ) : (
      <>Оплата получена, исполнителю выплачено — закройте заказ.</>
    );
    action =
      due && !isOwner ? null : (
        <div className="flex gap-2">
          {due && <Button size="sm" variant="secondary" icon={Wallet} onClick={onPayout}>Выплатить исполнителю</Button>}
          <Button size="sm" variant="success" icon={CircleCheck} onClick={() => go("closed")}>Закрыть заказ</Button>
        </div>
      );
  } else if (o.status === "refund") {
    tone = "amber";
    icon = CircleDollarSign;
    text = <>По заказу оформлен возврат клиенту: {money(refundedAmount(o))}. Заказ не входит в выручку.</>;
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
  const me = useMe();
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState("");
  const [showAll, setShowAll] = useState(false);
  const ranked = rankExecutors(o, db.executors, db.orders);
  const list = ranked.filter((x) => (showAll || x.fits) && (!q || x.e.name.toLowerCase().includes(q.toLowerCase())));
  const noPrice = o.clientPrice <= 0 || payout(o) <= 0;
  // Мастера на выходном назначает только владелец — так же проверяет сервер.
  const canOverrideOff = me?.role === "owner";
  const assign = async (e: Executor) => {
    setBusy(true);
    // Передаём, каким заказ видели на экране: если его только что взял мастер — сервер не даст перебить.
    const r = await assignExecutor(o.id, e.id, o);
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    toast(`${shortName(e.name)} назначен — ждём подтверждения`);
    onClose();
  };
  return (
    <Modal open onClose={onClose} title="Назначить исполнителя" width={640}>
      <p className="-mt-1 mb-3 text-[14px] text-muted">
        {serviceById(o.serviceId).label} · {o.city}
        {o.district ? `, район ${o.district}` : ""}. Сверху — подходящие по специализации, навыкам, городу и району: свободные, с меньшей загрузкой, высоким рейтингом и хорошей историей за 90 дней.
      </p>
      {!!o.requiredSkills?.length && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[13.5px] text-ink-2">
          <span className="font-medium">Нужны навыки:</span>
          <SkillChips skills={o.requiredSkills} variant="outline" />
        </div>
      )}
      {noPrice && <div className="mb-3 rounded-[10px] bg-warn-bg px-3.5 py-2.5 text-[13.5px] text-warn-ink">Сначала укажите цену клиента и выплату — исполнитель должен видеть, сколько получит.</div>}
      <AiMatchPanel
        orderId={o.id}
        disabled={busy || noPrice}
        onPick={(id) => {
          const e = db.executors.find((x) => x.id === id);
          if (e) void assign(e);
        }}
      />
      <Input icon={Search} placeholder="Поиск по имени" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="mt-3 flex flex-col gap-2">
        {list.map(({ e, state, load, fits, reasons }) => (
          <div key={e.id} className={cn("flex items-center gap-3 rounded-[12px] border p-3", o.executorId === e.id ? "border-brand bg-brand-soft/40" : "border-line")}>
            <Avatar name={e.name} size={44} variant="person" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-[15px] font-semibold text-ink">{e.name}</span>
                <Badge tone={EXEC_STATE[state].tone} size="sm">
                  {EXEC_STATE[state].label}
                </Badge>
              </div>
              <div className="mt-0.5 truncate text-[13px] text-muted">
                {e.city} · {e.categories.map((c) => categoryById(c).label).join(", ")} · в работе: {load} ·{" "}
                {ratingValue(e) ? (
                  <>
                    <Star size={12} className="inline -translate-y-px fill-[#ffb547] text-[#ffb547]" /> {ratingValue(e)}
                  </>
                ) : (
                  "нет оценок"
                )}
              </div>
              <div className="mt-0.5 truncate text-[12.5px] text-muted">
                {historyLine(e.stats90) ?? "истории за 90 дней нет"}
                {o.clientPrice > 0 && ` · получит ${money(payoutFor(e.rates, o))}`}
                {e.districts?.length ? ` · районы: ${e.districts.join(", ")}` : ""}
              </div>
              {!fits && (
                <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Почему не подходит">
                  {reasons.map((r) => (
                    <span key={r} className="rounded-[7px] bg-warn-bg px-2 py-[2px] text-[12px] font-semibold text-warn-ink">
                      {r}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <Button
              size="sm"
              variant={o.executorId === e.id ? "soft" : "primary"}
              title={state === "off" && !canOverrideOff ? "Исполнитель на выходном — назначить его может только владелец" : undefined}
              disabled={busy || (state === "off" && !canOverrideOff) || noPrice || o.executorId === e.id}
              onClick={() => void assign(e)}
            >
              {o.executorId === e.id ? "Назначен" : "Назначить"}
            </Button>
          </div>
        ))}
        {list.length === 0 && <div className="py-6 text-center text-[14px] text-muted">{showAll ? "Никого не нашли." : "Подходящих исполнителей нет — покажите всех, чтобы назначить вручную."}</div>}
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
  const [district, setDistrict] = useState(o.district ?? "");
  const [address, setAddress] = useState(o.address);
  const [dl, setDl] = useState(toLocalInput(o.deadline));
  const [priority, setPriority] = useState<Urgency>(o.priority);
  const [skills, setSkills] = useState<string[]>(o.requiredSkills ?? []);
  const category = categoryById(serviceById(serviceId).category);
  const options = category.skills ?? [];
  // Как на сервере: навыки — из справочника направления; уже стоявшие на заказе остаются,
  // пока направление то же; при смене услуги на другое направление навыки старого не переносятся.
  const kept = category.id === o.category ? (o.requiredSkills ?? []) : [];
  const required = skills.filter((s) => hasSkill(options, s) || hasSkill(kept, s));
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
              if (Number.isNaN(Date.parse(dl))) return toast("Укажите дедлайн", "bad");
              const r = await updateOrderInfo(o.id, { serviceId, description, city, district, address, deadline: new Date(dl).toISOString(), priority, requiredSkills: required });
              if (!r.ok) return toast(r.error, "bad");
              toast(r.value.notified ? `Заказ обновлён — он стал подходить ещё исполнителям: ${r.value.notified}, они получили уведомление` : "Заказ обновлён");
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
        <div>
          <div className="mb-1 text-[14px] font-semibold text-ink">Нужные навыки</div>
          <p className="mb-2 text-[12.5px] text-muted">
            {options.length || kept.length
              ? "Заказ увидят и получат уведомление только исполнители с этими навыками. Ничего не выбрано — хватит специализации и города."
              : `Для направления «${category.label}» навыки в справочнике не заданы — их добавляет владелец в «Настройках».`}
          </p>
          <SkillPicker label="Нужные навыки" options={options} value={required} onChange={setSkills} />
        </div>
        <FormRow label="Описание и ТЗ">{(id) => <Textarea id={id} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />}</FormRow>
        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Город">
            {(id) => (
              <CitySelect
                id={id}
                value={city}
                onChange={(c) => {
                  setCity(c);
                  if (c !== city) setDistrict("");
                }}
              />
            )}
          </FormRow>
          <FormRow label="Дедлайн">{(id) => <input id={id} type="datetime-local" className="field" value={dl} onChange={(e) => setDl(e.target.value)} />}</FormRow>
        </div>
        <DistrictField city={city} value={district} onChange={setDistrict} />
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
  const p = Number(digits(price)) || 0;
  const v = Number(value.replace(",", ".")) || 0;
  const pay = payout({ clientPrice: p, payoutMode: mode, payoutValue: v });
  const m = p - pay;
  // Заказ уже за исполнителем: новую выплату он увидит в уведомлении «было → стало» (E7).
  const watched = !!o.executorId && TERMS_WATCH_STATUSES.includes(o.status);
  // Работа сдана: новая цена может перевести «Оплачен» ↔ «Ожидает оплаты» — предупреждаем заранее (E4).
  const nextStatus = settledStatus({ status: o.status, clientPrice: p, payments: o.payments });
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
              const r = await updateFinance(o.id, { clientPrice: p, payoutMode: mode, payoutValue: mode === "fixed" ? Number(digits(value)) || 0 : v });
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
        {o.payoutPaid && <p className="rounded-[10px] bg-ok-bg px-3.5 py-2.5 text-[13px] text-ok-ink">Исполнителю уже выплачено {money(payout(o))} — эта сумма не меняется. Отменить выплату можно в «Выплатах мастерам» в течение суток.</p>}
        {!o.payoutPaid && watched && (
          <p className="rounded-[10px] bg-warn-bg px-3.5 py-2.5 text-[13px] text-warn-ink">
            {o.acceptedPayout !== undefined ? `Исполнитель принял заказ за ${money(o.acceptedPayout)}. ` : ""}
            {pay !== payout(o) ? `Он получит уведомление: выплата ${money(payout(o))} → ${money(pay)}.` : "Если выплата изменится, он сразу получит уведомление."}
          </p>
        )}
        {nextStatus && nextStatus !== o.status && (
          <p className="rounded-[10px] bg-[#f8f6f1] px-3.5 py-2.5 text-[13px] text-ink-2">
            После сохранения заказ станет «{ORDER_STATUS[nextStatus].label}»{nextStatus === "awaiting_payment" ? ` — клиенту нужно доплатить ${money(p - paidAmount(o))}` : " — оплачено всё"}.
          </p>
        )}
        <MoneyLedger o={o} />
        <p className="text-[12.5px] text-muted">Изменения финансов попадают в историю заказа. AI эти поля менять не может. Выплату исполнителю проводит владелец — кнопкой «Выплатить исполнителю» или в «Выплатах мастерам».</p>
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

