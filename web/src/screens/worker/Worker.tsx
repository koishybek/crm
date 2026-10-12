import {
  ArrowRight,
  CalendarDays,
  ChevronRight,
  CircleCheck,
  Clock,
  ExternalLink,
  Filter,
  Hourglass,
  Inbox,
  MapPin,
  Moon,
  Phone,
  Play,
  Star,
  TrendingUp,
  Undo2,
  Wallet,
  ClipboardCheck,
  X,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { APP_NAME, SERVICES, categoryById, serviceById } from "../../data/catalog";
import { useMe, useNow, useTeam } from "../../data/hooks";
import { isFinished, isInWork, isOverdue } from "../../data/logic";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { executorAction, report, setMyAvailability, takeOrder, toast } from "../../data/store";
import type { Actor, WorkerOrder as WOrder } from "../../data/types";
import { OrderChat } from "../../components/OrderChat";
import { ServiceTile, TONE_SOFT } from "../../components/icons";
import { BackLink, Badge, Button, Card, EmptyState, KpiCard, Loading, PageHeader, Select, Tabs, Toggle } from "../../components/ui";
import { cn, date, dayDiff, deadline, money, phone, shortName } from "../../lib/format";

/** Мои заказы с сервера — общий запрос для ленты, «Моих заказов» и «Дохода». */
function useMine() {
  return useQuery(api.worker.mine);
}

/** Статус глазами исполнителя — короче, чем у оператора. */
const workerBadge = (o: WOrder, now: number): { label: string; tone: "blue" | "amber" | "green" | "red" | "orange" | "gray" | "sky" } => {
  if (isOverdue(o, now)) return { label: "Просрочен", tone: "red" };
  switch (o.status) {
    case "assigned":
      return { label: "Назначен", tone: "blue" };
    case "accepted":
      return { label: "Принят", tone: "sky" };
    case "in_progress":
      return { label: "В работе", tone: "amber" };
    case "awaiting_client":
      return { label: "Жду клиента", tone: "orange" };
    case "cancelled":
      return { label: "Отменён", tone: "gray" };
    default:
      return isFinished(o) ? { label: o.payoutPaid ? "Выплачено" : "Сдан", tone: "green" } : { label: "—", tone: "gray" };
  }
};

// ── Лента ────────────────────────────────────────────────────────────────────

export function Feed() {
  const data = useQuery(api.worker.feed);
  const my = useMine();
  const now = useNow();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const q = (params.get("q") ?? "").toLowerCase();
  const [service, setService] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const feed = useMemo(
    () =>
      (data?.feed ?? [])
        .filter((o) => {
          const s = serviceById(o.serviceId);
          if (service && o.serviceId !== service) return false;
          const d = dayDiff(new Date(o.deadline), new Date(now));
          if (due === "today" && d !== 0) return false;
          if (due === "tomorrow" && d !== 1) return false;
          if (due === "week" && d > 6) return false;
          if (q && !`${s.label} ${o.description} ${o.city}`.toLowerCase().includes(q)) return false;
          return true;
        })
        .sort((a, b) => (a.priority === "urgent" ? -1 : 0) - (b.priority === "urgent" ? -1 : 0) || a.deadline.localeCompare(b.deadline)),
    [data, service, due, q, now],
  );
  const mine = (my?.orders ?? []).filter(isInWork).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const ex = data?.executor;
  const myServices = SERVICES.filter((s) => ex?.categories.includes(s.category));

  const take = async (o: WOrder) => {
    setBusy(o.id);
    const r = await takeOrder(o.id);
    setBusy(null);
    if (!r.ok) return toast(r.error, "bad");
    toast(`Заказ №${o.number} ваш! Адрес и контакты клиента — в «Мои заказы»`);
  };

  if (!data || !ex) return <Loading />;

  return (
    <>
      <PageHeader
        title="Доступные заказы"
        subtitle={`Выбирайте подходящие заказы и зарабатывайте вместе с ${APP_NAME}`}
        actions={ex && <Toggle checked={ex.available} onChange={async (v) => void report(await setMyAvailability(v), v ? "Вы на смене — заказы снова приходят" : "Выходной: новые заказы не придут")} label={ex.available ? "На смене" : "Выходной"} />}
      />

      <div className="flex flex-wrap items-center gap-2.5">
        <span className="inline-flex h-11 items-center gap-2 rounded-[11px] border border-line bg-white px-4 text-[14.5px] text-ink-2">
          <MapPin size={17} className="text-muted" /> {ex.city}
        </span>
        <Select icon={Filter} value={service} onChange={(e) => setService(e.target.value)} className="w-[230px] [&_select]:border-line">
          <option value="">Все услуги</option>
          {myServices.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
        <Select icon={CalendarDays} value={due} onChange={(e) => setDue(e.target.value)} className="w-[190px] [&_select]:border-line">
          <option value="">Любой срок</option>
          <option value="today">Сегодня</option>
          <option value="tomorrow">Завтра</option>
          <option value="week">На этой неделе</option>
        </Select>
        {q && (
          <button onClick={() => (params.delete("q"), setParams(params))} className="inline-flex h-11 items-center gap-2 rounded-[11px] bg-brand-soft px-3.5 text-[14px] font-medium text-brand-ink">
            «{q}» <X size={15} />
          </button>
        )}
      </div>

      {!ex.available && (
        <div className="mt-4 flex items-center gap-3 rounded-[14px] border border-[#dcd1ff] bg-violet-bg/60 px-4 py-3 text-[14.5px] text-ink-2">
          <Moon size={20} className="text-violet" /> Вы на выходном — брать заказы нельзя. Включите «На смене», когда будете готовы.
        </div>
      )}

      <div className="mt-4 flex flex-col gap-3">
        {feed.length === 0 ? (
          <div className="card">
            <EmptyState icon={Inbox} title="Подходящих заказов пока нет" text={`Как только появится заказ по вашим услугам в городе ${ex.city}, придёт уведомление.`} />
          </div>
        ) : (
          feed.map((o) => {
            const s = serviceById(o.serviceId);
            const cat = categoryById(s.category);
            const fresh = now - new Date(o.createdAt).getTime() < 3600_000;
            return (
              <article key={o.id} className="card flex flex-col gap-4 p-4 sm:p-5 lg:flex-row lg:items-center lg:gap-6">
                <div className="flex min-w-0 flex-1 items-start gap-4 sm:gap-5">
                  <ServiceTile serviceId={o.serviceId} size={60} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[18px] font-bold tracking-[-0.01em] text-ink">{s.label}</h3>
                      {o.priority === "urgent" && <Badge tone="red" size="sm">Срочно</Badge>}
                      {fresh && <Badge tone="green" size="sm">Новый</Badge>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[15px] text-ink-2">{o.description}</p>
                    <div className="mt-2 flex flex-wrap gap-x-7 gap-y-1 text-[14.5px] text-ink-2">
                      <span className="inline-flex items-center gap-1.5">
                        <MapPin size={17} className="text-muted" /> {o.city}
                      </span>
                      <span className={cn("inline-flex items-center gap-1.5", dayDiff(new Date(o.deadline), new Date(now)) === 0 && "font-medium text-warn-ink")}>
                        <CalendarDays size={17} className="text-muted" /> {deadline(o.deadline, new Date(now))}
                      </span>
                    </div>
                  </div>
                </div>
                <span className={cn("hidden self-center rounded-[10px] px-3 py-1.5 text-[13px] font-medium xl:inline", TONE_SOFT[cat.tone])}>{cat.label}</span>
                <div className="flex items-center justify-between gap-4 border-t border-line pt-3 lg:w-[360px] lg:shrink-0 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
                  <div>
                    <div className="text-[13.5px] text-muted">Оплата исполнителю</div>
                    <div className="text-[26px] font-bold tracking-[-0.02em] text-ink tabular-nums">{money(o.payout)}</div>
                  </div>
                  <Button size="lg" className="min-w-[170px]" disabled={!ex.available || busy === o.id} onClick={() => void take(o)}>
                    Взять заказ
                  </Button>
                </div>
              </article>
            );
          })
        )}
      </div>

      <Card
        className="mt-5"
        title="Мои заказы"
        action={
          <Link to="/w/my" className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink">
            Все мои заказы <ArrowRight size={16} />
          </Link>
        }
        bodyClass="px-2 pb-2 sm:px-3 sm:pb-3"
      >
        {mine.length === 0 ? <div className="py-6 text-center text-[14px] text-muted">Возьмите заказ из ленты — он появится здесь</div> : mine.map((o) => <MyRow key={o.id} o={o} now={now} onOpen={() => nav(`/w/orders/${o.id}`)} />)}
      </Card>
    </>
  );
}

function MyRow({ o, now, onOpen }: { o: WOrder; now: number; onOpen: () => void }) {
  const s = serviceById(o.serviceId);
  const b = workerBadge(o, now);
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-4 rounded-[12px] border-t border-line px-2 py-3 text-left first:border-t-0 hover:bg-[#faf8f3] sm:px-3">
      <ServiceTile serviceId={o.serviceId} size={48} />
      <div className="min-w-0 flex-1 md:w-[32%] md:flex-none">
        <div className="line-clamp-2 text-[15px] leading-snug font-semibold text-ink sm:truncate">{s.label}</div>
        <div className="hidden truncate text-[13.5px] text-muted sm:block">{o.description}</div>
      </div>
      <span className="hidden items-center gap-1.5 text-[14px] text-ink-2 md:inline-flex md:w-[14%]">
        <MapPin size={16} className="text-muted" /> {o.city}
      </span>
      <span className={cn("hidden items-center gap-1.5 text-[14px] md:inline-flex md:w-[18%]", isOverdue(o, now) ? "font-medium text-bad" : "text-ink-2")}>
        <CalendarDays size={16} className="text-muted" /> {deadline(o.deadline, new Date(now))}
      </span>
      <Badge tone={b.tone} className="shrink-0">
        {b.label}
      </Badge>
      <div className="hidden text-right sm:block md:ml-auto">
        <div className="text-[12px] text-muted">Оплата исполнителю</div>
        <div className="text-[16px] font-bold text-ink tabular-nums">{money(o.payout)}</div>
      </div>
      <ChevronRight size={20} className="shrink-0 text-muted" />
    </button>
  );
}

// ── Мои заказы ───────────────────────────────────────────────────────────────

export function MyOrders() {
  const my = useMine();
  const now = useNow();
  const nav = useNavigate();
  const [tab, setTab] = useState<"active" | "done">("active");
  const mine = my?.orders ?? [];
  const active = mine.filter(isInWork).sort((a, b) => a.deadline.localeCompare(b.deadline));
  const done = mine.filter((o) => !isInWork(o)).sort((a, b) => (b.doneAt ?? b.createdAt).localeCompare(a.doneAt ?? a.createdAt));
  const list = tab === "active" ? active : done;
  return (
    <>
      <PageHeader title="Мои заказы" subtitle="Заказы, которые вы взяли или вам назначили" />
      <Tabs
        items={[
          { id: "active", label: "Активные", count: active.length },
          { id: "done", label: "Завершённые", count: done.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="card mt-4 px-2 py-2 sm:px-3">
        {my === undefined ? (
          <Loading />
        ) : list.length === 0 ? (
          <EmptyState icon={Inbox} title={tab === "active" ? "Активных заказов нет" : "Завершённых пока нет"} action={tab === "active" ? <Button onClick={() => nav("/w")}>Открыть ленту</Button> : undefined} />
        ) : (
          list.slice(0, 60).map((o) => <MyRow key={o.id} o={o} now={now} onOpen={() => nav(`/w/orders/${o.id}`)} />)
        )}
      </div>
    </>
  );
}

// ── Заказ глазами исполнителя ────────────────────────────────────────────────

const STEPS = [
  { id: "accepted", label: "Принят" },
  { id: "in_progress", label: "В работе" },
  { id: "done", label: "Сдан" },
  { id: "paid", label: "Выплачено" },
];

export function WorkerOrder() {
  const { id } = useParams();
  const d = useQuery(api.worker.order, { id: id as Id<"orders"> });
  const me = useMe()!;
  const team = useTeam();
  const now = useNow();
  const nav = useNavigate();
  const o = d?.order;
  if (d === undefined) return <Loading />;
  if (!o)
    return (
      <div className="card">
        <EmptyState icon={Inbox} title="Заказ недоступен" text="Возможно, его передали другому исполнителю или отменили." action={<Button onClick={() => nav("/w/my")}>Мои заказы</Button>} />
      </div>
    );
  const s = serviceById(o.serviceId);
  const client = { name: o.clientName ?? "Клиент", phone: o.clientPhone ?? "" };
  const nameOf = (a: Actor) => (a.type === "client" ? client.name : a.type === "user" ? (team.users.find((u) => u.id === a.id)?.name ?? "Сотрудник") : "Система");
  const b = workerBadge(o, now);
  const confirmed = o.status !== "assigned";
  const stepIdx = o.payoutPaid ? 3 : isFinished(o) ? 2 : o.status === "in_progress" || o.status === "awaiting_client" ? 1 : 0;

  const act = async (a: Parameters<typeof executorAction>[1], msg: string) => {
    const r = await executorAction(o.id, a);
    if (!r.ok) return toast(r.error, "bad");
    toast(msg);
    if (a === "decline") nav("/w");
  };

  let panel: ReactNode = null;
  if (o.status === "assigned")
    panel = (
      <>
        <p className="text-[15px] text-ink-2">Оператор назначил вам этот заказ. Подтвердите, что берёте его, — тогда откроются адрес и контакты клиента.</p>
        <div className="mt-3 flex flex-wrap gap-2.5">
          <Button size="lg" icon={CircleCheck} onClick={() => void act("accept", "Заказ подтверждён")}>
            Подтвердить заказ
          </Button>
          <Button size="lg" variant="danger" icon={Undo2} onClick={() => void act("decline", "Вы отказались — заказ вернулся в ленту")}>
            Отказаться
          </Button>
        </div>
      </>
    );
  else if (o.status === "accepted")
    panel = (
      <div className="flex flex-wrap gap-2.5">
        <Button size="lg" icon={Play} onClick={() => void act("start", "Отлично, заказ в работе")}>
          Начать работу
        </Button>
        <Button size="lg" variant="danger" icon={Undo2} onClick={() => void act("decline", "Вы отказались — заказ вернулся в ленту")}>
          Отказаться
        </Button>
      </div>
    );
  else if (o.status === "in_progress")
    panel = (
      <div className="flex flex-wrap gap-2.5">
        <Button size="lg" variant="success" icon={CircleCheck} onClick={() => void act("done", "Работа сдана. Оператор получит оплату от клиента")}>
          Работа выполнена
        </Button>
        <Button size="lg" variant="secondary" icon={Hourglass} onClick={() => void act("wait", "Отметили: ждём клиента")}>
          Жду клиента / деталь
        </Button>
      </div>
    );
  else if (o.status === "awaiting_client")
    panel = (
      <div className="flex flex-wrap gap-2.5">
        <Button size="lg" icon={Play} onClick={() => void act("resume", "Продолжаем работу")}>
          Продолжить работу
        </Button>
        <Button size="lg" variant="success" icon={CircleCheck} onClick={() => void act("done", "Работа сдана")}>
          Работа выполнена
        </Button>
      </div>
    );
  else if (isFinished(o))
    panel = <p className="text-[15px] text-ink-2">{o.payoutPaid ? `Выплата ${money(o.payout)} отправлена. Спасибо за работу!` : `Работа сдана. Выплата ${money(o.payout)} — после оплаты клиентом.`}</p>;
  else if (o.status === "cancelled") panel = <p className="text-[15px] text-ink-2">Заказ отменён{o.cancelReason ? `: ${o.cancelReason.toLowerCase()}` : ""}.</p>;

  return (
    <>
      <BackLink to="/w/my">Мои заказы</BackLink>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <ServiceTile serviceId={o.serviceId} size={60} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[24px] font-bold tracking-[-0.02em] text-ink sm:text-[28px]">{s.label}</h1>
            <Badge tone={b.tone}>{b.label}</Badge>
          </div>
          <div className="text-[14.5px] text-muted">
            Заказ №{o.number} · {categoryById(s.category).label}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[13px] text-muted">Вы получите</div>
          <div className="text-[28px] font-bold tracking-[-0.02em] text-ink tabular-nums">{money(o.payout)}</div>
        </div>
      </div>

      {o.status !== "cancelled" && (
        <ol className="mb-4 grid grid-cols-4 gap-1.5">
          {STEPS.map((st, i) => (
            <li key={st.id} className="min-w-0">
              <div className={cn("h-1.5 rounded-full", i <= stepIdx ? "bg-brand" : "bg-line-strong")} />
              <div className={cn("mt-1.5 truncate text-[12.5px] font-medium", i <= stepIdx ? "text-brand-ink" : "text-muted")}>{st.label}</div>
            </li>
          ))}
        </ol>
      )}

      {panel && <div className="card mb-4 p-4 sm:p-5">{panel}</div>}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.15fr]">
        <Card title="Детали заказа">
          <dl className="divide-y divide-line text-[14.5px]">
            <div className="py-2.5">
              <dt className="text-muted">Что сделать</dt>
              <dd className="mt-0.5 font-medium text-ink">{o.description}</dd>
            </div>
            <div className="flex items-start justify-between gap-3 py-2.5">
              <div>
                <dt className="text-muted">Срок</dt>
                <dd className={cn("mt-0.5 font-medium", isOverdue(o, now) ? "text-bad" : "text-ink")}>{deadline(o.deadline, new Date(now))}</dd>
              </div>
              <Clock size={18} className="mt-1 text-muted" />
            </div>
            <div className="py-2.5">
              <dt className="text-muted">Адрес</dt>
              {confirmed ? (
                <dd className="mt-0.5 flex flex-wrap items-center justify-between gap-2 font-medium text-ink">
                  <span>
                    {o.city}, {o.address}
                  </span>
                  <a href={`https://2gis.kz/search/${encodeURIComponent(`${o.city} ${o.address}`)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[13.5px] font-medium text-brand-ink">
                    Маршрут <ExternalLink size={14} />
                  </a>
                </dd>
              ) : (
                <dd className="mt-0.5 text-muted">{o.city} — точный адрес после подтверждения</dd>
              )}
            </div>
            <div className="py-2.5">
              <dt className="text-muted">Клиент</dt>
              {confirmed ? (
                <dd className="mt-0.5 flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{shortName(client.name)}</span>
                  <a href={`tel:+${client.phone}`} className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-ok-bg px-3.5 text-[14px] font-semibold text-ok-ink">
                    <Phone size={16} /> {phone(client.phone)}
                  </a>
                </dd>
              ) : (
                <dd className="mt-0.5 text-muted">Контакты откроются после подтверждения</dd>
              )}
            </div>
          </dl>
        </Card>
        <Card title="Переписка и фото">
          <OrderChat orderId={o.id} messages={d!.messages} me={me} nameOf={nameOf} compact />
        </Card>
      </div>
    </>
  );
}

// ── Доход ────────────────────────────────────────────────────────────────────

export function Income() {
  const my = useMine();
  const now = useNow();
  const ex = my?.executor;
  const done = (my?.orders ?? []).filter((o) => isFinished(o)).sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  const monthAgo = now - 30 * 86400_000;
  const s = {
    incomeMonth: done.filter((o) => o.doneAt && Date.parse(o.doneAt) > monthAgo).reduce((acc, o) => acc + o.payout, 0),
    toPay: done.filter((o) => !o.payoutPaid).reduce((acc, o) => acc + o.payout, 0),
  };
  const weeks = [...Array(8)].map((_, i) => {
    const to = now - i * 7 * 86400_000;
    const from = to - 7 * 86400_000;
    const sum = done.filter((o) => o.doneAt && new Date(o.doneAt).getTime() > from && new Date(o.doneAt).getTime() <= to).reduce((acc, o) => acc + o.payout, 0);
    return { label: i === 0 ? "Эта неделя" : `${i} нед. назад`, sum };
  }).reverse();
  const max = Math.max(1, ...weeks.map((w) => w.sum));
  const month = done.filter((o) => o.doneAt && now - new Date(o.doneAt).getTime() < 30 * 86400_000).length;

  if (!my || !ex) return <Loading />;

  return (
    <>
      <PageHeader title="Доход" subtitle="Сколько вы заработали и сколько ещё к выплате" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={TrendingUp} tone="green" label="Заработано за 30 дней" value={money(s.incomeMonth)} />
        <KpiCard icon={Wallet} tone="amber" label="К выплате" value={money(s.toPay)} caption="сдано, ещё не выплачено" />
        <KpiCard icon={ClipboardCheck} tone="blue" label="Заказов за 30 дней" value={month} />
        <KpiCard icon={Star} tone="violet" label="Рейтинг" value={ex.rating.toFixed(1)} caption={`${ex.reviews} отзывов`} />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1fr_1.3fr]">
        <Card title="По неделям">
          <div className="flex h-[200px] items-end gap-2">
            {weeks.map((w, i) => (
              <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end">
                <span className="mb-1 text-[11.5px] font-semibold text-ink tabular-nums">{w.sum ? `${Math.round(w.sum / 1000)}K` : ""}</span>
                <div className={cn("w-full rounded-t-[6px]", i === weeks.length - 1 ? "bg-brand" : "bg-[#ffe39a]")} style={{ height: Math.max(4, (w.sum / max) * 150) }} />
                <span className="mt-1.5 w-full truncate text-center text-[11px] text-muted">{w.label}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Выполненные заказы" bodyClass="px-3 pb-3 sm:px-4">
          {done.length === 0 ? (
            <div className="py-6 text-center text-[14px] text-muted">Пока пусто</div>
          ) : (
            <div className="scroll-x">
              <table className="tbl min-w-[480px]">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Услуга</th>
                    <th className="text-right">Сумма</th>
                    <th>Выплата</th>
                  </tr>
                </thead>
                <tbody>
                  {done.slice(0, 15).map((o) => (
                    <tr key={o.id}>
                      <td className="whitespace-nowrap text-ink-2">{o.doneAt ? date(o.doneAt) : "—"}</td>
                      <td className="max-w-[220px] truncate text-ink">{serviceById(o.serviceId).label}</td>
                      <td className="text-right font-semibold tabular-nums">{money(o.payout)}</td>
                      <td>
                        <Badge tone={o.payoutPaid ? "green" : "amber"}>{o.payoutPaid ? "Выплачено" : "Ожидает"}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
