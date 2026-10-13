// «Мои заказы»: активные (первым — тёмная карточка «Следующий заказ» с главной кнопкой) и завершённые по месяцам.
import { useQuery } from "convex/react";
import { CircleCheck, ClipboardList, MapPin, Navigation, Phone } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../../../convex/_generated/api";
import { serviceById } from "../../data/catalog";
import { useNow } from "../../data/hooks";
import type { WorkerOrder } from "../../data/types";
import { telHref } from "../../data/workerLinks";
import { groupByMonth, isActiveWork, isClosedForWorker } from "../../data/workerStats";
import { contactsLocked, isOverdueWork, sortActive } from "../../data/workerStatus";
import { dueLabel, isDueSoon, monthTitle, relLabel } from "../../data/workerTime";
import { cn, money } from "../../lib/format";
import { Segmented } from "../../components/ui";
import { Empty, ListSkeleton, MUTED, ScreenTitle, WButton, busyLabel } from "../../components/worker/kit";
import { useRoute } from "../../components/worker/MapSheet";
import { useNet } from "../../components/worker/net";
import { DoneRow, DueText, StatusBadge } from "../../components/worker/parts";
import { useStep } from "../../components/worker/useStep";
import { DoneSheet } from "../../components/worker/WorkSheets";

const PAGE = 50;

export function MyOrders() {
  const data = useQuery(api.worker.mine);
  const now = useNow();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "done" ? "done" : "active";
  const [limit, setLimit] = useState(PAGE);
  const orders = data?.orders;
  const active = useMemo(() => sortActive((orders ?? []).filter(isActiveWork), now), [orders, now]);
  const closed = useMemo(() => (orders ?? []).filter(isClosedForWorker), [orders]);

  if (data === undefined) return <ListSkeleton />;

  return (
    <div className="mx-auto max-w-[760px]">
      <ScreenTitle title="Мои заказы" />
      <Segmented
        options={[
          { value: "active", label: active.length ? `Активные · ${active.length}` : "Активные" },
          { value: "done", label: "Завершённые" },
        ]}
        value={tab}
        onChange={(v) => setParams(v === "done" ? { tab: "done" } : {}, { replace: true })}
      />

      {tab === "active" ? (
        active.length === 0 ? (
          <div className="mt-4">
            <Empty
              icon={ClipboardList}
              title="Активных заказов нет"
              text="Возьмите заказ в ленте — он появится здесь."
              action={
                <WButton size="lg" full onClick={() => nav("/w")}>
                  Смотреть заказы
                </WButton>
              }
            />
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {/* key — открытая шторка «Сдать работу» не должна перейти на другой заказ, если первый сменился. */}
            <NextUpCard key={active[0]!.id} order={active[0]!} now={now} />
            {active.length > 1 && <h2 className={cn("mt-2 text-[15px] font-semibold", MUTED)}>Ещё заказы</h2>}
            {active.slice(1).map((o) => (
              <MyOrderCard key={o.id} order={o} now={now} />
            ))}
          </div>
        )
      ) : (
        <DoneList orders={closed} now={now} limit={limit} onMore={() => setLimit((n) => n + PAGE)} />
      )}
    </div>
  );
}

/** Тёмная карточка первого активного заказа: что сейчас, когда, где и главная кнопка. */
function NextUpCard({ order: o, now }: { order: WorkerOrder; now: number }) {
  const offline = useNet((s) => s.offline);
  const { busy, slow, step } = useStep();
  const [done, setDone] = useState(false);
  const route = useRoute(o.city, o.address);
  const overdue = isOverdueWork(o, now);
  const label = o.status === "assigned" ? "Ждёт подтверждения" : overdue ? "Просрочен" : o.status === "accepted" ? "Следующий" : "Сейчас";
  const contacts = !contactsLocked(o) && !!o.address;

  const primary =
    o.status === "assigned"
      ? { text: "Подтвердить заказ", run: () => void step(o.id, "accept") }
      : o.status === "accepted"
        ? { text: "Начать работу", run: () => void step(o.id, "start") }
        : { text: "Работа выполнена", run: () => setDone(true) };

  const square = "inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] bg-white/10 text-white active:bg-white/20";
  return (
    <section className="rounded-[16px] bg-side p-4 text-white">
      <Link to={`/w/orders/${o.id}`} className="block">
        <div className={cn("text-[13.5px] font-semibold", overdue ? "text-[#ff8197]" : "text-[#c9c4b8]")}>
          {label} · №{o.number}
        </div>
        <div className="mt-1 text-[18px] leading-snug font-semibold">{serviceById(o.serviceId).label}</div>
        <div className={cn("mt-1.5 text-[16px]", overdue ? "font-semibold text-[#ff8197]" : isDueSoon(o.deadline, now) ? "font-semibold text-[#ffc629]" : "text-white")}>
          {dueLabel(o.deadline, now)} · {relLabel(o.deadline, now)}
        </div>
        <div className="mt-1 flex items-start gap-1.5 text-[15px] text-[#e6e2d9]">
          <MapPin size={17} className="mt-0.5 shrink-0" aria-hidden />
          <span className="line-clamp-2 wrap-anywhere">{contacts ? `${o.city}, ${o.address}` : `${o.city} · адрес после подтверждения`}</span>
        </div>
        <div className="mt-1 text-[15px] font-semibold tabular-nums">Вы получите {money(o.payout)}</div>
      </Link>
      <div className="mt-3.5 flex items-center gap-2">
        <WButton className="flex-1" busy={busy} busyText={busyLabel(slow, "Отправляем…")} disabled={offline} onClick={primary.run}>
          {offline ? "Нет связи" : primary.text}
        </WButton>
        {contacts && o.clientPhone && o.status !== "in_progress" && (
          <a href={telHref(o.clientPhone)} className={square} aria-label="Позвонить клиенту">
            <Phone size={21} aria-hidden />
          </a>
        )}
        {contacts && o.status === "accepted" &&
          (route.href ? (
            <a href={route.href} target="_blank" rel="noopener noreferrer" className={square} aria-label="Построить маршрут">
              <Navigation size={21} aria-hidden />
            </a>
          ) : (
            <button type="button" onClick={route.open} className={square} aria-label="Построить маршрут">
              <Navigation size={21} aria-hidden />
            </button>
          ))}
      </div>
      {route.sheet}
      {done && <DoneSheet order={o} onClose={() => setDone(false)} />}
    </section>
  );
}

/** Остальные активные: вся карточка — ссылка на заказ. */
function MyOrderCard({ order: o, now }: { order: WorkerOrder; now: number }) {
  const contacts = !contactsLocked(o) && !!o.address;
  return (
    <Link to={`/w/orders/${o.id}`} className="card block min-h-24 p-4 active:bg-[#faf8f3]">
      {/* Длинный бейдж и большая сумма на 320 px не помещаются в строку — сумма уходит вниз. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <StatusBadge order={o} now={now} />
        <span className="ml-auto text-[18px] font-bold whitespace-nowrap text-ink tabular-nums">{money(o.payout)}</span>
      </div>
      <div className="mt-1.5 line-clamp-2 text-[16px] leading-snug font-semibold text-ink">{serviceById(o.serviceId).label}</div>
      <DueText deadline={o.deadline} now={now} className="mt-1.5 text-[15px]" />
      <div className="mt-1 flex items-start gap-2 text-[15px] text-ink-2">
        <MapPin size={18} className="mt-0.5 shrink-0" aria-hidden />
        <span className="line-clamp-2 wrap-anywhere">{contacts ? `${o.city}, ${o.address}` : `${o.city} · адрес после подтверждения`}</span>
      </div>
    </Link>
  );
}

/** «Завершённые»: группы по месяцам (Алматы) с суммой без отмен и возвратов. */
function DoneList({ orders, now, limit, onMore }: { orders: WorkerOrder[]; now: number; limit: number; onMore: () => void }) {
  // Первые `limit` заказов, сгруппированные по месяцам (сумма месяца — по всем его заказам).
  const groups = useMemo(() => {
    let left = limit;
    return groupByMonth(orders).flatMap((g) => {
      if (left <= 0) return [];
      const shown = g.orders.slice(0, left);
      left -= shown.length;
      return [{ ...g, orders: shown }];
    });
  }, [orders, limit]);
  if (!orders.length)
    return (
      <div className="mt-4">
        <Empty icon={CircleCheck} title="Здесь будут выполненные заказы" text="Сданные, отменённые и возвращённые заказы появятся в этом списке." />
      </div>
    );
  return (
    <div className="mt-4 flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.month}>
          <h2 className="mb-1.5 px-1 text-[14.5px] font-semibold text-ink">
            {monthTitle(g.month)} · {money(g.total)}
          </h2>
          <div className="card px-3">
            {g.orders.map((o) => (
              <DoneRow key={o.id} order={o} now={now} />
            ))}
          </div>
        </section>
      ))}
      {orders.length > limit && (
        <WButton variant="secondary" full onClick={onMore}>
          Показать ещё
        </WButton>
      )}
    </div>
  );
}
