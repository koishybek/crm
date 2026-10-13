// «Заказы» — лента свободных заказов мастера (как OLX/Krisha: чипы, сортировка, карточка «деньги → что → когда → где»).
// Живые данные не сдвигают список под пальцем: новые заказы ждут за пилюлей «Показать новые заказы (N)»,
// пропавшие превращаются в «надгробия» на своём месте.
import { useQuery } from "convex/react";
import { ArrowUp, ArrowUpDown, Check, ChevronRight, Flame, Inbox, Phone, Send, SlidersHorizontal, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { api } from "../../../convex/_generated/api";
import { categoryById, serviceById } from "../../data/catalog";
import { useNow } from "../../data/hooks";
import { report } from "../../data/store";
import type { WorkerOrder } from "../../data/types";
import { connectTelegram } from "../../data/workerActions";
import {
  chipCounts,
  feedRows,
  freshIds,
  isFiltered,
  matchesFilter,
  NO_FILTER,
  readFeedParams,
  SORT_LABEL,
  sortFeed,
  withExtras,
  writeFeedParams,
  type FeedFilter,
  type FeedItem,
  type FeedSort,
} from "../../data/workerFeed";
import { SUPPORT_TEL } from "../../data/workerLinks";
import { missingSkills } from "../../data/workerMatch";
import { useWorkerPrefs } from "../../data/workerPrefs";
import { isActiveWork } from "../../data/workerStats";
import { isOverdueWork, sortActive } from "../../data/workerStatus";
import { dueLabel } from "../../data/workerTime";
import { cn, plural } from "../../lib/format";
import { OffShiftCard } from "../../components/worker/Availability";
import { FeedHint } from "../../components/worker/FeedHints";
import { Chip, Empty, ListSkeleton, MUTED, ScreenTitle, WButton, WLinkButton } from "../../components/worker/kit";
import { useNet } from "../../components/worker/net";
import { GoneCard, OrderCard, type TakeMode } from "../../components/worker/OrderCard";
import { Sheet } from "../../components/worker/Sheet";
import { TakeSheet } from "../../components/worker/TakeSheet";

type Snapshot = { key: string; rows: { id: string; number: number }[] };

const snapshotOf = (key: string, items: readonly FeedItem[]): Snapshot => ({ key, rows: items.map((o) => ({ id: o.id, number: o.number })) });

/** Длинную ленту (больше 100 заказов) рисуем по 30 карточек: слабому телефону сотни карточек сразу ни к чему. */
const PAGED_FROM = 100;
const PAGE = 30;

export function Feed() {
  const data = useQuery(api.worker.feed);
  const extras = useQuery(api.executorApp.feedExtras);
  const mine = useQuery(api.worker.mine);
  const now = useNow();
  const nav = useNavigate();
  const offline = useNet((s) => s.offline);
  const markSeen = useWorkerPrefs((s) => s.markFeedSeen);
  const [params, setParams] = useSearchParams();
  const { filter, sort } = readFeedParams(params);
  const [take, setTake] = useState<FeedItem | null>(null);
  const [sorting, setSorting] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  // Требуемые навыки (ТЗ п.11): заказ без нужного навыка мастер не откроет — не показываем его и в ленте.
  // После слияния с правилом подбора в worker.feed фильтр ничего не меняет.
  const items = useMemo(() => (data ? withExtras(data.feed.filter((o) => missingSkills(data.executor, o.requiredSkills).length === 0), extras) : []), [data, extras]);
  const allById = useMemo(() => new Map(items.map((o) => [o.id, o] as const)), [items]);
  const { urgent, when, cat } = filter;
  const visible = useMemo(() => sortFeed(items.filter((o) => matchesFilter(o, { urgent, when, cat }, now)), sort), [items, urgent, when, cat, sort, now]);
  const counts = useMemo(() => chipCounts(items, now), [items, now]);

  // Снимок порядка: обновляется при смене фильтра или сортировки, по пилюле и когда список был пуст.
  // Времена публикации приходят отдельным запросом: когда они появились, «Сначала новые» сортируем заново.
  const key = `${urgent}|${when}|${cat}|${sort}|${extras === undefined ? 0 : 1}`;
  const [snap, setSnap] = useState<Snapshot | null>(null);
  if (data !== undefined && (snap === null || snap.key !== key || (snap.rows.length === 0 && visible.length > 0))) {
    setSnap(snapshotOf(key, visible));
  }
  const rows = useMemo(() => (snap && snap.key === key ? snap.rows : snapshotOf(key, visible).rows), [snap, key, visible]);
  const fresh = useMemo(() => freshIds(rows.map((r) => r.id), visible), [rows, visible]);
  const list = useMemo(
    () =>
      feedRows(
        rows.map((r) => r.id),
        allById,
        new Map(rows.map((r) => [r.id, r.number] as const)),
      ),
    [rows, allById],
  );
  // Сколько карточек длинной ленты показано; другой фильтр или сортировка — снова с первой страницы.
  const [limit, setLimit] = useState(PAGE);
  const [limitKey, setLimitKey] = useState(key);
  if (limitKey !== key) {
    setLimitKey(key);
    setLimit(PAGE);
  }
  const paged = list.length > PAGED_FROM;
  const shown = useMemo(() => (paged ? list.slice(0, limit) : list), [list, paged, limit]);

  // Лента просмотрена: через 2 секунды на экране и при уходе — гасит счётчик на вкладке.
  useEffect(() => {
    const t = setTimeout(() => markSeen(Date.now()), 2000);
    return () => {
      clearTimeout(t);
      markSeen(Date.now());
    };
  }, [markSeen]);

  useEffect(() => {
    if (!highlight) return;
    const el = document.getElementById(`order-${highlight}`);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    const t = setTimeout(() => setHighlight(null), 2000);
    return () => clearTimeout(t);
  }, [highlight]);

  const showFresh = () => {
    const first = fresh[0] ?? null;
    setSnap(snapshotOf(key, visible));
    // Первый новый заказ может оказаться ниже показанной части длинной ленты — показываем до него.
    if (first) setLimit((n) => Math.max(n, visible.findIndex((o) => o.id === first) + 1));
    setHighlight(first);
    markSeen(Date.now());
  };

  const setFilter = (f: FeedFilter) => setParams(writeFeedParams(f, sort), { replace: true });
  const setSort = (s: FeedSort) => setParams(writeFeedParams(filter, s), { replace: true });

  const onTake = useCallback((item: FeedItem) => setTake(item), []);
  const onTaken = useCallback(
    (id: string) => {
      setTake(null);
      nav(`/w/orders/${id}`);
    },
    [nav],
  );

  if (data === undefined) return <ListSkeleton />;
  const ex = data.executor;
  const mode: TakeMode = offline ? "offline" : ex.available ? "ready" : "off_shift";
  const cats = ex.categories;
  const subtitle = [ex.city, cats.map((c) => categoryById(c).label).join(", ")].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto max-w-[760px]">
      <ScreenTitle title="Заказы" subtitle={subtitle} />

      <div className="flex flex-col gap-3">
        {!ex.available && <OffShiftCard />}
        <ActiveStrip orders={mine?.orders} now={now} />
        {/* Подсказки (Telegram, «Как брать заказы», установка) — одна за раз и не поверх карточки «приём выключен». */}
        {ex.available && <FeedHint hasOrders={items.length > 0} ownOrders={mine?.orders.length} now={now} />}
      </div>

      {items.length > 0 && (
        <>
          <div className="-mx-4 mt-3 overflow-x-auto px-4 [scrollbar-width:none] lg:mx-0 lg:overflow-visible lg:px-0 [&::-webkit-scrollbar]:hidden">
            <div className="flex w-max gap-2 lg:w-auto lg:flex-wrap">
              <Chip pressed={!isFiltered(filter)} onClick={() => setFilter(NO_FILTER)}>
                Все
              </Chip>
              <Chip pressed={urgent} icon={Flame} count={counts.urgent} onClick={() => setFilter({ ...filter, urgent: !urgent })}>
                Срочные
              </Chip>
              <Chip pressed={when === "today"} count={counts.today} onClick={() => setFilter({ ...filter, when: when === "today" ? null : "today" })}>
                Сегодня
              </Chip>
              <Chip pressed={when === "tomorrow"} count={counts.tomorrow} onClick={() => setFilter({ ...filter, when: when === "tomorrow" ? null : "tomorrow" })}>
                Завтра
              </Chip>
              {cats.length >= 2 &&
                cats.map((c) => (
                  <Chip key={c} pressed={cat === c} count={counts.byCat[c]} onClick={() => setFilter({ ...filter, cat: cat === c ? null : c })}>
                    {categoryById(c).label}
                  </Chip>
                ))}
            </div>
          </div>
          <div className="mt-1 flex min-h-12 items-center justify-between gap-3">
            <span className={cn("text-[14.5px]", MUTED)}>
              {visible.length} {plural(visible.length, "заказ", "заказа", "заказов")}
            </span>
            <button type="button" onClick={() => setSorting(true)} className="inline-flex h-12 items-center gap-2 rounded-[10px] px-2 text-[15px] font-medium text-ink hover:bg-[#f4f2ec]">
              <ArrowUpDown size={16} aria-hidden />
              {SORT_LABEL[sort]}
            </button>
          </div>
        </>
      )}

      {fresh.length > 0 && rows.length > 0 && (
        <div className="sticky top-[68px] z-20 flex justify-center lg:top-[76px]">
          <button type="button" onClick={showFresh} className="inline-flex h-12 items-center">
            <span className="inline-flex h-10 items-center gap-2 rounded-full bg-ink px-4 text-[15px] font-semibold text-white shadow-[var(--shadow-pop)]">
              <ArrowUp size={16} aria-hidden />
              Показать новые заказы ({fresh.length})
            </span>
          </button>
        </div>
      )}

      <div className="mt-2 flex flex-col gap-3">
        {shown.map((r) => (r.kind === "order" ? <OrderCard key={r.item.id} item={r.item} now={now} mode={mode} highlighted={highlight === r.item.id} onTake={onTake} /> : <GoneCard key={r.id} number={r.number} />))}
      </div>
      {shown.length < list.length && (
        <WButton variant="secondary" full className="mt-3" onClick={() => setLimit((n) => n + PAGE)}>
          Показать ещё {Math.min(PAGE, list.length - shown.length)}
        </WButton>
      )}

      {list.length === 0 && <FeedEmpty hasOrders={items.length > 0} available={ex.available} city={ex.city} noServices={cats.length === 0} onReset={() => setFilter(NO_FILTER)} />}

      {take && <TakeSheet order={allById.get(take.id) ?? take} gone={!allById.has(take.id)} available={ex.available} onClose={() => setTake(null)} onTaken={onTaken} />}

      <Sheet open={sorting} onClose={() => setSorting(false)} title="Сортировка">
        <div className="flex flex-col gap-1" role="radiogroup" aria-label="Сортировка">
          {(Object.keys(SORT_LABEL) as FeedSort[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={sort === s}
              onClick={() => {
                setSort(s);
                setSorting(false);
              }}
              className={cn("flex min-h-14 items-center justify-between rounded-[12px] px-3 text-left text-[16px]", sort === s ? "bg-[#faf8f3] font-semibold text-ink" : "text-ink-2")}
            >
              {SORT_LABEL[s]}
              {sort === s && <Check size={20} aria-hidden />}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}

/** Полоса «активный заказ» над лентой — чтобы не забыть про взятый заказ. */
function ActiveStrip({ orders, now }: { orders: WorkerOrder[] | undefined; now: number }) {
  const first = useMemo(() => sortActive((orders ?? []).filter(isActiveWork), now)[0], [orders, now]);
  if (!first) return null;
  const service = serviceById(first.serviceId).label;
  const label =
    first.status === "assigned"
      ? `Ждёт подтверждения: №${first.number} · ${service}`
      : isOverdueWork(first, now)
        ? `Просрочен: №${first.number} · ${service}`
        : first.status === "in_progress"
          ? `В работе: №${first.number} · ${service}`
          : first.status === "awaiting_client"
            ? `На паузе: №${first.number} · ${service}`
            : `Следующий: №${first.number} · ${dueLabel(first.deadline, now)}`;
  const urgent = first.status === "assigned" || isOverdueWork(first, now);
  return (
    <Link to={`/w/orders/${first.id}`} className={cn("card flex min-h-14 items-center gap-3 border-l-4 px-4 py-2 active:bg-[#faf8f3]", urgent ? "border-l-[#c41d3a]" : "border-l-brand")}>
      <span className="min-w-0 flex-1 text-[15px] leading-snug font-semibold text-ink">{label}</span>
      <ChevronRight size={20} className="shrink-0 text-ink-2" aria-hidden />
    </Link>
  );
}

function FeedEmpty({ hasOrders, available, city, noServices, onReset }: { hasOrders: boolean; available: boolean; city: string; noServices: boolean; onReset: () => void }) {
  const tg = useQuery(api.telegram.status);
  if (noServices)
    return (
      <div className="mt-3">
        <Empty
          icon={Wrench}
          title="У вас не выбраны услуги"
          text="Попросите оператора добавить услуги в ваш профиль — тогда здесь появятся заказы."
          action={
            <WLinkButton href={SUPPORT_TEL} icon={Phone} full>
              Позвонить в офис
            </WLinkButton>
          }
        />
      </div>
    );
  if (hasOrders)
    return (
      <div className="mt-3">
        <Empty
          icon={SlidersHorizontal}
          title="По этим фильтрам заказов нет"
          action={
            <WButton variant="secondary" full onClick={onReset}>
              Сбросить фильтры
            </WButton>
          }
        />
      </div>
    );
  // Приём выключен — карточка сверху уже всё объясняет.
  if (!available) return null;
  return (
    <div className="mt-3">
      <Empty
        icon={Inbox}
        title="Пока нет заказов"
        text={`Новые заказы по вашим услугам в городе ${city} появятся здесь сами.`}
        action={
          tg?.enabled && !tg.linked ? (
            <WButton icon={Send} full onClick={async () => void report(await connectTelegram())}>
              Подключить Telegram
            </WButton>
          ) : undefined
        }
      />
    </div>
  );
}
