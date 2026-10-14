import { CalendarDays, Check, Clock, Ellipsis, FileText, MapPin, Settings, Wallet, ArrowRight, UserPlus, Ban, LayoutGrid, List, Archive } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { CITIES, KANBAN, ORDER_STATUS, serviceById, type Tone } from "../data/catalog";
import { useMe, useNow } from "../data/hooks";
import { isOverdue, orderBadgeShort, payout } from "../data/logic";
import { can } from "../data/permissions";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { changeStatus, toast } from "../data/store";
import { useTeam } from "../data/hooks";
import type { Order, OrderStatus } from "../data/types";
import { ExportButton } from "../components/ExportButton";
import { ServiceLabel } from "../components/icons";
import { SkillChips, SkillLine } from "../components/SkillChips";
import { Avatar, Badge, Loading, Menu, MenuItem, PageHeader, Select } from "../components/ui";
import { cn, dayDiff, dateTime, deadline, money, shortName } from "../lib/format";
import { OrdersArchive } from "./OrdersArchive";

const COL_ICON: Record<string, ReactNode> = {
  new: <FileText size={24} strokeWidth={1.8} className="text-ink" />,
  awaiting: <Clock size={24} strokeWidth={1.9} className="text-[#d98a00]" />,
  work: <Settings size={24} strokeWidth={1.9} className="fill-brand/60 text-[#e9a800]" />,
  done: (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-ok text-white">
      <Check size={15} strokeWidth={3} />
    </span>
  ),
};
const COL_HEAD: Partial<Record<Tone, { head: string; count: string }>> = {
  yellow: { head: "bg-[#fff4dc]", count: "bg-[#ffe6a3] text-[#3a2c00]" },
  green: { head: "bg-[#e6f6ec]", count: "bg-[#ccefd9] text-ok-ink" },
};

type Due = "" | "late" | "today" | "tomorrow" | "week";

export default function Orders() {
  const me = useMe();
  // Деньги в списке — по правам (ТЗ п.5.12): цена — «Цена клиента и оплаты», маржа — «Выплаты мастерам и маржа».
  const seesMoney = can(me, "money.view");
  const seesMargin = can(me, "money.payouts");
  const team = useTeam();
  const [params] = useSearchParams();
  const [view, setView] = useState<"board" | "list" | "archive">(params.get("view") === "archive" ? "archive" : "board");
  // Доска — активные и последние 45 дней; в архиве свой запрос с фильтрами на сервере.
  const board = useQuery(api.orders.board, view === "archive" ? "skip" : {});
  const db = useMemo(() => ({ orders: board ?? [], executors: team.executors }), [board, team.executors]);
  const now = useNow();
  const nav = useNavigate();
  const [status, setStatus] = useState<OrderStatus | "" | "closed_all">("");
  const [city, setCity] = useState("");
  const [executor, setExecutor] = useState("");
  const [due, setDue] = useState<Due>(params.get("late") ? "late" : "");
  const [doneLimit, setDoneLimit] = useState(8);

  const filtered = useMemo(() => {
    return db.orders
      .filter((o) => {
        if (status === "closed_all") {
          if (o.status !== "cancelled" && o.status !== "refund") return false;
        } else if (status ? o.status !== status : o.status === "cancelled" || o.status === "refund") return false;
        if (city && o.city !== city) return false;
        if (executor === "none" ? !!o.executorId : executor && o.executorId !== executor) return false;
        if (due) {
          const d = dayDiff(new Date(o.deadline), new Date(now));
          if (due === "late" && !isOverdue(o, now)) return false;
          if (due === "today" && d !== 0) return false;
          if (due === "tomorrow" && d !== 1) return false;
          if (due === "week" && (d < 0 || d > 6)) return false;
        }
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [db.orders, status, city, executor, due, now]);

  const columns = KANBAN.map((col) => {
    const items = filtered.filter((o) => col.statuses.includes(o.status));
    // В «Завершено» свежие сверху; в остальных — по сроку, просрочки наверх.
    if (col.id !== "done") items.sort((a, b) => a.deadline.localeCompare(b.deadline));
    return { ...col, items };
  });
  const extra = filtered.filter((o) => o.status === "cancelled" || o.status === "refund");

  return (
    <>
      <PageHeader
        title="Заказы"
        subtitle="Управляйте заказами на услуги и отслеживайте их выполнение"
        actions={
          <>
          {/* Выгрузка — по праву «Выгрузка в Excel», деньги в файле — по правам на деньги (src/data/exportAccess.ts). */}
          <ExportButton kinds={["orders", "payments"]} />
          <div className="inline-flex rounded-[12px] border border-line bg-white p-1">
            {(
              [
                ["board", LayoutGrid, "Доска"],
                ["list", List, "Список"],
                ["archive", Archive, "Архив"],
              ] as const
            ).map(([id, I, label]) => (
              <button key={id} onClick={() => setView(id)} className={cn("inline-flex h-9 items-center gap-2 rounded-[9px] px-3.5 text-[14px] font-medium", view === id ? "bg-brand-soft text-brand-ink" : "text-ink-2 hover:bg-[#f4f2ec]")}>
                <I size={17} /> {label}
              </button>
            ))}
          </div>
          </>
        }
      />

      {view === "archive" ? (
        <OrdersArchive />
      ) : (
      <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FilterCard label="Статус">
          <Select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | "")}>
            <option value="">Все активные и завершённые</option>
            {(Object.keys(ORDER_STATUS) as OrderStatus[])
              .filter((s) => s !== "cancelled" && s !== "refund")
              .map((s) => (
                <option key={s} value={s}>
                  {ORDER_STATUS[s].label}
                </option>
              ))}
            <option value="closed_all">Отменённые и возвраты</option>
          </Select>
        </FilterCard>
        <FilterCard label="Город">
          <Select value={city} onChange={(e) => setCity(e.target.value)}>
            <option value="">Все города</option>
            {CITIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </FilterCard>
        <FilterCard label="Исполнитель">
          <Select value={executor} onChange={(e) => setExecutor(e.target.value)}>
            <option value="">Все исполнители</option>
            <option value="none">Без исполнителя</option>
            {db.executors.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </Select>
        </FilterCard>
        <FilterCard label="Срок выполнения">
          <Select icon={CalendarDays} value={due} onChange={(e) => setDue(e.target.value as Due)}>
            <option value="">Все даты</option>
            <option value="late">Просроченные</option>
            <option value="today">Сегодня</option>
            <option value="tomorrow">Завтра</option>
            <option value="week">Ближайшие 7 дней</option>
          </Select>
        </FilterCard>
      </div>

      {board === undefined ? (
        <Loading />
      ) : view === "board" ? (
        <div className="scroll-x scroll-thin -mx-4 mt-4 px-4 pb-2 sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0">
          <div className="grid min-w-[1000px] grid-cols-4 gap-3.5">
            {columns.map((col) => {
              const shown = col.id === "done" ? col.items.slice(0, doneLimit) : col.items;
              return (
                <section key={col.id} className="min-w-0 rounded-[16px] bg-[#f3f1eb]/70">
                  <header className={cn("flex items-center gap-3 rounded-t-[16px] px-4 py-3.5", COL_HEAD[col.tone]?.head)}>
                    {COL_ICON[col.id]}
                    <h2 className="flex-1 text-[17px] font-semibold text-ink">{col.label}</h2>
                    <span className={cn("inline-flex h-7 min-w-7 items-center justify-center rounded-[8px] px-2 text-[14px] font-semibold", COL_HEAD[col.tone]?.count)}>{col.items.length}</span>
                  </header>
                  <div className="flex flex-col gap-2.5 p-2.5">
                    {shown.map((o) => (
                      <OrderCard key={o.id} o={o} clientName={o.clientName} now={now} />
                    ))}
                    {col.items.length === 0 && <div className="px-2 py-8 text-center text-[13.5px] text-muted">Пусто</div>}
                    {col.id === "done" && col.items.length > doneLimit && (
                      <button onClick={() => setDoneLimit((n) => n + 20)} className="rounded-[10px] py-2.5 text-[14px] font-medium text-brand-ink hover:bg-white">
                        Показать ещё ({col.items.length - doneLimit})
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
          {extra.length > 0 && (
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
              {extra.map((o) => (
                <OrderCard key={o.id} o={o} clientName={o.clientName} now={now} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="card mt-4 p-3 sm:p-4">
          <div className="scroll-x">
            <table className="tbl min-w-[980px]">
              <thead>
                <tr>
                  <th>№</th>
                  <th>Клиент и город</th>
                  <th>Услуга</th>
                  <th>Срок</th>
                  <th>Исполнитель</th>
                  {seesMoney && <th className="text-right">Цена</th>}
                  {seesMargin && <th className="text-right">Маржа</th>}
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((o) => {
                  const ex = db.executors.find((e) => e.id === o.executorId);
                  const b = orderBadgeShort(o, now);
                  return (
                    <tr key={o.id} className="row-link" onClick={() => nav(`/orders/${o.id}`)}>
                      <td className="font-semibold text-ink">№{o.number}</td>
                      <td className="max-w-[180px] leading-tight">
                        <span className="block truncate text-ink">{o.clientName}</span>
                        <span className="block truncate text-[13px] text-muted">{o.city}</span>
                      </td>
                      <td>
                        <ServiceLabel serviceId={o.serviceId} className="max-w-[220px] text-ink-2" />
                        <SkillLine skills={o.requiredSkills} label="Нужные навыки" icon className="mt-1 max-w-[240px]" />
                      </td>
                      <td className={cn("whitespace-nowrap", isOverdue(o, now) ? "font-medium text-bad" : "text-ink-2")}>{deadline(o.deadline, new Date(now))}</td>
                      <td className="whitespace-nowrap text-ink-2" title={ex?.name}>{ex ? shortName(ex.name) : <span className="text-muted">—</span>}</td>
                      {seesMoney && <td className="text-right font-semibold text-ink tabular-nums">{o.clientPrice ? money(o.clientPrice) : "—"}</td>}
                      {seesMargin && <td className="text-right text-ok-ink tabular-nums">{o.clientPrice ? money(o.clientPrice - payout(o)) : "—"}</td>}
                      <td>
                        <Badge tone={b.tone} title={b.full}>{b.label}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {filtered.length > 200 && <div className="pt-3 text-center text-[13px] text-muted">Показаны первые 200 — уточните фильтры или откройте «Архив»</div>}
        </div>
      )}
      </>
      )}
    </>
  );

}

function FilterCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="card px-4 pt-3 pb-4">
      <div className="mb-2 text-[13.5px] font-medium text-muted">{label}</div>
      {children}
    </div>
  );
}

function OrderCard({ o, clientName, now }: { o: Order; clientName: string; now: number }) {
  const nav = useNavigate();
  const seesMoney = can(useMe(), "money.view");
  const b = orderBadgeShort(o, now);
  const late = isOverdue(o, now);
  return (
    <article className="card relative p-4 transition-shadow hover:shadow-[0_10px_28px_rgba(32,76,127,0.12)]">
      <div className="flex items-center justify-between gap-2">
        <Link to={`/orders/${o.id}`} className="text-[16px] font-bold text-ink after:absolute after:inset-0 after:content-['']">
          №{o.number}
        </Link>
        <div className="flex items-center gap-1">
          <span className={cn("text-[13px] whitespace-nowrap", late ? "font-semibold text-bad" : "text-muted")} title={`Срок: ${dateTime(o.deadline)}`}>
            {deadline(o.deadline, new Date(now))}
          </span>
          <div className="relative z-10">
            <Menu
              width={240}
              trigger={(toggle) => (
                <button onClick={toggle} aria-label="Действия с заказом" className="hit relative inline-flex h-7 w-7 items-center justify-center rounded-[7px] text-muted hover:bg-[#f4f2ec]">
                  <Ellipsis size={17} className="rotate-90" />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem icon={ArrowRight} onClick={() => (close(), nav(`/orders/${o.id}`))}>
                    Открыть заказ
                  </MenuItem>
                  {["new", "awaiting_executor", "assigned", "accepted"].includes(o.status) && (
                    <MenuItem icon={UserPlus} onClick={() => (close(), nav(`/orders/${o.id}?assign=1`))}>
                      Назначить исполнителя
                    </MenuItem>
                  )}
                  {o.status === "new" && (
                    <MenuItem
                      icon={Clock}
                      onClick={async () => {
                        close();
                        const r = await changeStatus(o.id, "awaiting_executor");
                        if (!r.ok) return toast(r.error, "bad");
                        const n = r.value?.notified ?? 0;
                        toast(n ? `Заказ №${o.number} в ленте — уведомили исполнителей: ${n}` : `Заказ №${o.number} в ленте, но подходящих исполнителей сейчас нет — назначьте вручную`, n ? "ok" : "info");
                      }}
                    >
                      Опубликовать в ленту
                    </MenuItem>
                  )}
                  {["new", "awaiting_executor", "assigned", "accepted", "in_progress", "awaiting_client"].includes(o.status) && (
                    <MenuItem
                      icon={Ban}
                      danger
                      onClick={() => {
                        close();
                        nav(`/orders/${o.id}?cancel=1`);
                      }}
                    >
                      Отменить заказ
                    </MenuItem>
                  )}
                </>
              )}
            </Menu>
          </div>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Avatar name={clientName} size={42} />
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-ink">{clientName}</div>
          <div className="flex items-center gap-1 text-[13px] text-muted">
            <MapPin size={13} /> {o.city}
          </div>
        </div>
      </div>
      <ServiceLabel serviceId={o.serviceId} className="mt-3 w-full text-[14.5px] text-ink-2" />
      <SkillChips skills={o.requiredSkills} max={2} variant="outline" className="mt-2" />
      <div className="mt-3 flex items-center justify-between gap-2">
        {seesMoney ? (
          <span className="inline-flex items-center gap-2 text-[16px] font-bold text-ink tabular-nums">
            <Wallet size={18} className="text-muted" strokeWidth={1.8} />
            {o.clientPrice ? money(o.clientPrice) : <span className="text-[14px] font-medium text-warn-ink">цена не указана</span>}
          </span>
        ) : (
          <span />
        )}
        {/* Длинный статус («Ожидает исполнителя») в узкой колонке — с многоточием, полный — в подсказке. */}
        <Badge tone={b.tone} className="min-w-0 max-w-[150px] shrink justify-start">
          <span className="truncate" title={b.full}>
            {b.label}
          </span>
        </Badge>
      </div>
      <span className="sr-only">{serviceById(o.serviceId).label}</span>
    </article>
  );
}
