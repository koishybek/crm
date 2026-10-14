// «Архив» на экране «Заказы» (ТЗ п.27.8, E13): все заказы за всё время, в том числе выполненные раньше 45 дней.
// Фильтры и поиск выполняет сервер (orders.list) по индексам, список догружается при прокрутке.
import { usePaginatedQuery } from "convex/react";
import { Archive, CalendarDays, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ACTIVE_STATUSES, CATEGORIES, FINISHED_STATUSES, ORDER_STATUS, SOURCE_IDS, SOURCES } from "../data/catalog";
import { useMe, useNow, useTeam } from "../data/hooks";
import { can } from "../data/permissions";
import { orderBadgeShort } from "../data/logic";
import type { OrderStatus, SourceId } from "../data/types";
import { ServiceLabel } from "../components/icons";
import { Badge, Button, EmptyState, Input, Loading, Select } from "../components/ui";
import { cn, date, money, num, shortName } from "../lib/format";

const PAGE = 30;
const FIELD = "[&_input]:h-[46px] [&_input]:border-line [&_select]:h-[46px] [&_select]:border-line";

/** Группы статусов и отдельные статусы — в одном списке. */
const GROUPS: { id: string; label: string; statuses: OrderStatus[] }[] = [
  { id: "active", label: "Активные", statuses: ACTIVE_STATUSES },
  { id: "finished", label: "Завершённые", statuses: FINISHED_STATUSES },
  { id: "lost", label: "Отменённые и возвраты", statuses: ["cancelled", "refund"] },
];
const statusesOf = (v: string): OrderStatus[] | undefined => (v ? (GROUPS.find((g) => g.id === v)?.statuses ?? [v as OrderStatus]) : undefined);

/** День из поля даты (по Алматы) → граница периода в ISO: начало или конец дня. */
const dayBound = (day: string, end: boolean): string | undefined => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const t = Date.parse(`${day}T${end ? "23:59:59.999" : "00:00:00.000"}+05:00`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
};

export function OrdersArchive() {
  const me = useMe();
  const team = useTeam();
  const now = useNow();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [status, setStatus] = useState("");
  const [by, setBy] = useState<"created" | "done">("created");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [executor, setExecutor] = useState("");
  const [source, setSource] = useState<SourceId | "">("");
  const [category, setCategory] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Цена — по праву «Цена клиента и оплаты» (ТЗ п.5.12): без него сервер отдаёт заказы без сумм.
  const owner = can(me, "money.view");
  const scope = me?.role === "manager" ? (me.categories ?? []) : null;
  const categories = CATEGORIES.filter((c) => !scope || scope.includes(c.id));
  const args = useMemo(
    () => ({
      statuses: statusesOf(status),
      period: from || to || by === "done" ? { by, from: dayBound(from, false), to: dayBound(to, true) } : undefined,
      executorId: executor === "none" ? ("none" as const) : executor ? (executor as Id<"executors">) : undefined,
      source: source || undefined,
      category: category || undefined,
      q: dq || undefined,
    }),
    [status, by, from, to, executor, source, category, dq],
  );
  const { results, status: loading, loadMore } = usePaginatedQuery(api.orders.list, args, { initialNumItems: PAGE });

  // Бесконечная прокрутка: пока «хвост» списка на экране и есть что догрузить — догружаем (страница с редким
  // фильтром бывает короткой, поэтому смотрим и на смену статуса загрузки, а не только на появление «хвоста»).
  const tail = useRef<HTMLDivElement>(null);
  const [tailVisible, setTailVisible] = useState(false);
  useEffect(() => {
    const el = tail.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setTailVisible(!!e?.isIntersecting), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (tailVisible && loading === "CanLoadMore") loadMore(PAGE);
  }, [tailVisible, loading, loadMore]);

  const filtered = !!(status || from || to || by === "done" || executor || source || category || dq);
  const reset = () => {
    setQ("");
    setStatus("");
    setBy("created");
    setFrom("");
    setTo("");
    setExecutor("");
    setSource("");
    setCategory("");
  };

  return (
    <div className="mt-1">
      <div className={cn("grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4", FIELD)}>
        <Input icon={Search} aria-label="Поиск" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} placeholder="№ заказа, имя или телефон клиента" className="sm:col-span-2" />
        <Select aria-label="Статус" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Все статусы</option>
          {GROUPS.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
          {(Object.keys(ORDER_STATUS) as OrderStatus[]).map((s) => (
            <option key={s} value={s}>
              — {ORDER_STATUS[s].label}
            </option>
          ))}
        </Select>
        <Select aria-label="Исполнитель" value={executor} onChange={(e) => setExecutor(e.target.value)}>
          <option value="">Все исполнители</option>
          <option value="none">Без исполнителя</option>
          {team.executors.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </Select>
        {/* Какая дата и период — одной группой на две колонки: полям дат нужна ширина под «дд.мм.гггг» и календарь. */}
        <div className="grid grid-cols-2 gap-3 sm:col-span-2 xl:grid-cols-[1.4fr_1fr_1fr]">
          <Select icon={CalendarDays} aria-label="Какая дата" value={by} onChange={(e) => setBy(e.target.value as "created" | "done")} className="col-span-2 xl:col-span-1">
            <option value="created">Дата создания</option>
            <option value="done">Дата выполнения</option>
          </Select>
          <Input type="date" aria-label="С даты" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
          <Input type="date" aria-label="По дату" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Select aria-label="Источник" value={source} onChange={(e) => setSource(e.target.value as SourceId | "")}>
          <option value="">Все источники</option>
          {SOURCE_IDS.map((s) => (
            <option key={s} value={s}>
              {SOURCES[s].label}
            </option>
          ))}
        </Select>
        <Select aria-label="Направление" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">{scope ? "Все мои направления" : "Все направления"}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </Select>
      </div>

      <div className="card mt-4 p-3 sm:p-4">
        {loading === "LoadingFirstPage" ? (
          <Loading />
        ) : results.length === 0 ? (
          <EmptyState
            icon={Archive}
            title={filtered ? "Ничего не нашлось" : "Заказов пока нет"}
            text={filtered ? "Под эти фильтры заказов нет — измените их или сбросьте." : undefined}
            action={filtered ? <Button variant="secondary" onClick={reset}>Сбросить фильтры</Button> : undefined}
          />
        ) : (
          <div className="scroll-x">
            <table className="tbl min-w-[980px]">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Создан</th>
                  <th>Клиент и город</th>
                  <th>Услуга</th>
                  <th>Исполнитель</th>
                  <th>Статус</th>
                  <th>Выполнен</th>
                  {owner && <th className="text-right">Цена</th>}
                </tr>
              </thead>
              <tbody>
                {results.map((o) => {
                  const b = orderBadgeShort(o, now);
                  return (
                    <tr key={o.id} className="row-link" onClick={() => nav(`/orders/${o.id}`)}>
                      <td className="font-semibold text-ink">№{o.number}</td>
                      <td className="whitespace-nowrap text-ink-2">{date(o.createdAt)}</td>
                      <td className="max-w-[180px] leading-tight">
                        <span className="block truncate text-ink">{o.clientName}</span>
                        <span className="block truncate text-[13px] text-muted">{o.city}</span>
                      </td>
                      <td>
                        <ServiceLabel serviceId={o.serviceId} className="max-w-[220px] text-ink-2" />
                      </td>
                      <td className="whitespace-nowrap text-ink-2" title={team.executor(o.executorId)?.name}>{shortName(team.executor(o.executorId)?.name ?? "") || <span className="text-muted">—</span>}</td>
                      <td>
                        <Badge tone={b.tone} title={b.full}>{b.label}</Badge>
                      </td>
                      <td className="whitespace-nowrap text-ink-2">{o.doneAt ? date(o.doneAt) : <span className="text-muted">—</span>}</td>
                      {owner && <td className="text-right font-semibold text-ink tabular-nums">{o.clientPrice ? money(o.clientPrice) : "—"}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div ref={tail} className="flex items-center justify-between gap-3 pt-3 text-[13px] text-muted">
          {results.length > 0 && <span>Показано {num(results.length)}</span>}
          {loading === "LoadingMore" && <span>Загружаем ещё…</span>}
          {loading === "CanLoadMore" && (
            <button onClick={() => loadMore(PAGE)} className="font-medium text-brand-ink">
              Показать ещё
            </button>
          )}
          {loading === "Exhausted" && results.length > 0 && <span>Это все заказы{filtered ? " по фильтрам" : ""}</span>}
        </div>
      </div>
    </div>
  );
}
