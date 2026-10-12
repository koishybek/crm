import { CalendarDays, Ellipsis, FileText, Filter, MessageCircle, Phone, Users, ArrowRight, Ban, Inbox } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { SOURCES, SOURCE_IDS, serviceById } from "../data/catalog";
import { useNow, useUi } from "../data/hooks";
import { leadBadge, leadBucket, type LeadBucket } from "../data/logic";
import { trend } from "../data/metrics";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { convertLead, report, setLeadStatus, toast } from "../data/store";
import { useMe, useTeam } from "../data/hooks";
import { Source } from "../components/icons";
import { Avatar, Badge, Button, EmptyState, KpiCard, Loading, Menu, MenuItem, PageHeader, Pagination, Select, Tabs } from "../components/ui";
import { cn, dayDiff, phone, when } from "../lib/format";

type Period = "today" | "yesterday" | "7d" | "30d" | "all";
const PERIOD_LABEL: Record<Period, string> = { today: "Сегодня", yesterday: "Вчера", "7d": "Последние 7 дней", "30d": "Последние 30 дней", all: "За всё время" };
const PER_PAGE = 10;

const TABS: { id: LeadBucket | "all"; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "new", label: "Новые" },
  { id: "qualifying", label: "Квалификация" },
  { id: "waiting", label: "Ожидают" },
  { id: "work", label: "В работе" },
  { id: "done", label: "Завершённые" },
  { id: "rejected", label: "Отказ" },
];

export default function Leads() {
  const team = useTeam();
  const me = useMe();
  const now = useNow();
  const nav = useNavigate();
  const ui = useUi();
  const [params, setParams] = useSearchParams();
  const [source, setSource] = useState("");
  const [tab, setTab] = useState<LeadBucket | "all">("all");
  const [period, setPeriod] = useState<Period>("7d");
  const [operator, setOperator] = useState("");
  const [page, setPage] = useState(1);

  // Открыть заявку из поиска: /leads?open=<id>
  useEffect(() => {
    const id = params.get("open");
    if (id) {
      ui.openLead({ leadId: id });
      params.delete("open");
      setParams(params, { replace: true });
    }
  }, [params, setParams, ui]);

  // С сервера — заявки периода (и минимум со вчера, для сравнения «к вчера»).
  const dayStart = new Date(new Date(now).setHours(0, 0, 0, 0)).getTime();
  const periodFrom = period === "all" ? undefined : dayStart - (period === "today" ? 1 : period === "yesterday" ? 1 : period === "7d" ? 7 : 30) * 86400_000;
  const data = useQuery(api.leads.list, { from: periodFrom === undefined ? undefined : new Date(periodFrom).toISOString() });
  const open = useQuery(api.leads.openCounts);
  const db = useMemo(() => ({ leads: data?.leads ?? [], orders: data?.orders ?? [] }), [data]);
  const ordersById = useMemo(() => new Map(db.orders.map((o) => [o.id, o])), [db.orders]);
  const operators = team.users.filter((u) => u.role !== "executor");

  const inPeriod = (iso: string) => {
    const d = dayDiff(new Date(iso), new Date(now));
    return period === "all" || (period === "today" ? d === 0 : period === "yesterday" ? d === -1 : period === "7d" ? d > -7 : d > -30);
  };

  const base = useMemo(
    () =>
      db.leads
        .filter((l) => inPeriod(l.createdAt) && (!source || l.source === source) && (!operator || l.operatorId === operator))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [db.leads, period, source, operator, now],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: base.length };
    for (const l of base) {
      const b = leadBucket(l, l.orderId ? ordersById.get(l.orderId) : undefined);
      c[b] = (c[b] ?? 0) + 1;
    }
    return c;
  }, [base, ordersById]);
  const rows = tab === "all" ? base : base.filter((l) => leadBucket(l, l.orderId ? ordersById.get(l.orderId) : undefined) === tab);
  const pageRows = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  useEffect(() => setPage(1), [tab, period, source, operator]);

  const today = db.leads.filter((l) => dayDiff(new Date(l.createdAt), new Date(now)) === 0);
  const yesterdaySameTime = db.leads.filter((l) => {
    const t = new Date(l.createdAt);
    return dayDiff(t, new Date(now)) === -1 && t.getTime() <= now - 86400_000;
  });
  const newCount = open?.new ?? 0;
  const qualifying = open?.qualifying ?? 0;
  const reset = () => {
    setSource("");
    setOperator("");
    setPeriod("7d");
    setTab("all");
  };
  const filtered = source || operator || period !== "7d" || tab !== "all";

  return (
    <>
      <PageHeader title="Заявки" subtitle="Все входящие заявки из разных источников" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard icon={FileText} tone="blue" label="Новые заявки" value={newCount} caption={newCount ? "ждут первого ответа" : "все разобраны"} onClick={() => (setTab("new"), setPeriod("all"))} />
        <KpiCard icon={Users} tone="violet" label="На квалификации" value={qualifying} caption="уточняем детали с клиентом" onClick={() => (setTab("qualifying"), setPeriod("all"))} />
        <KpiCard icon={CalendarDays} tone="green" label="Сегодня" value={today.length} trend={trend(today.length, yesterdaySameTime.length, "к вчера")} onClick={() => setPeriod("today")} />
      </div>

      <div className="card mt-4 p-4 sm:p-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1fr_auto] xl:items-end">
          <div>
            <div className="mb-2 text-[13.5px] font-medium text-ink-2">Источник</div>
            <Select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="">Все источники</option>
              {SOURCE_IDS.map((s) => (
                <option key={s} value={s}>
                  {SOURCES[s].label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <div className="mb-2 text-[13.5px] font-medium text-ink-2">Статус</div>
            <Select value={tab} onChange={(e) => setTab(e.target.value as LeadBucket | "all")}>
              {TABS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id === "all" ? "Все статусы" : t.label}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <div className="mb-2 text-[13.5px] font-medium text-ink-2">Период</div>
            <Select icon={CalendarDays} value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
              {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
                <option key={p} value={p}>
                  {PERIOD_LABEL[p]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <div className="mb-2 text-[13.5px] font-medium text-ink-2">Ответственный</div>
            <Select value={operator} onChange={(e) => setOperator(e.target.value)}>
              <option value="">Все операторы</option>
              {operators.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </div>
          <Button variant="soft" icon={Filter} onClick={reset} disabled={!filtered}>
            Сбросить
          </Button>
        </div>

        <div className="mt-5">
          <Tabs items={TABS.map((t) => ({ ...t, count: counts[t.id] ?? 0 }))} value={tab} onChange={setTab} />
        </div>

        {data === undefined ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState icon={Inbox} title="Заявок нет" text="Под выбранные фильтры ничего не попало. Попробуйте другой период." action={filtered ? <Button variant="soft" onClick={reset}>Сбросить фильтры</Button> : undefined} />
        ) : (
          <>
            <div className="scroll-x mt-3">
              <table className="tbl min-w-[1040px]">
                <thead>
                  <tr>
                    <th>№</th>
                    <th>Клиент</th>
                    <th>Источник</th>
                    <th>Услуга</th>
                    <th>Город</th>
                    <th>Статус</th>
                    <th>Ответственный</th>
                    <th>Время</th>
                    <th className="text-right">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((l) => {
                    const c = { id: l.clientId, name: l.clientName, phone: l.clientPhone };
                    const order = l.orderId ? ordersById.get(l.orderId) : undefined;
                    const b = leadBadge(l, order, now);
                    const op = team.users.find((u) => u.id === l.operatorId);
                    return (
                      <tr key={l.id} className="row-link" onClick={() => ui.openLead({ leadId: l.id })}>
                        <td className="font-medium text-ink-2 tabular-nums">{l.number}</td>
                        <td>
                          <span className="flex items-center gap-3">
                            <Avatar name={c.name} size={38} />
                            <span className="min-w-0 leading-tight">
                              <span className="block max-w-[170px] truncate font-medium text-ink">{c.name}</span>
                              <span className="text-[13px] text-muted">{phone(c.phone)}</span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <Source source={l.source} />
                        </td>
                        <td className="max-w-[210px] truncate text-ink-2">
                          {serviceById(l.serviceId).label}
                          {l.urgency === "urgent" && <Badge tone="red" size="sm" className="ml-2">срочно</Badge>}
                        </td>
                        <td className="text-ink-2">{l.city}</td>
                        <td>
                          <Badge tone={b.tone}>{b.label}</Badge>
                        </td>
                        <td>
                          {op && (
                            <span className="flex items-center gap-2">
                              <Avatar name={op.name} size={28} variant="person" />
                              <span className="text-ink-2">{op.name.split(" ")[0]}</span>
                            </span>
                          )}
                        </td>
                        <td className={cn("whitespace-nowrap", dayDiff(new Date(l.createdAt), new Date(now)) === 0 ? "text-ink-2" : "text-muted")}>{when(l.createdAt, new Date(now))}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1.5">
                            <a href={`tel:+${c.phone}`} aria-label={`Позвонить: ${c.name}`} className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] bg-[#f4f2ec] text-ink-2 hover:bg-brand-soft hover:text-brand-ink">
                              <Phone size={16} />
                            </a>
                            <a href={`https://wa.me/${c.phone}`} target="_blank" rel="noreferrer" aria-label={`Написать: ${c.name}`} className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] bg-[#f4f2ec] text-brand-ink hover:bg-brand-soft">
                              <MessageCircle size={16} />
                            </a>
                            <Menu
                              width={230}
                              trigger={(toggle) => (
                                <button onClick={toggle} aria-label="Ещё" className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] bg-[#f4f2ec] text-ink-2 hover:bg-brand-soft">
                                  <Ellipsis size={17} />
                                </button>
                              )}
                            >
                              {(close) => (
                                <>
                                  {order ? (
                                    <MenuItem icon={ArrowRight} onClick={() => (close(), nav(`/orders/${order.id}`))}>
                                      Открыть заказ №{order.number}
                                    </MenuItem>
                                  ) : (
                                    l.status !== "rejected" && (
                                      <MenuItem
                                        icon={ArrowRight}
                                        onClick={async () => {
                                          close();
                                          const r = await convertLead(l.id);
                                          if (!r.ok) return toast(r.error, "bad");
                                          toast(`Заказ №${r.value.number} создан. Укажите цену и опубликуйте`);
                                          nav(`/orders/${r.value.id}`);
                                        }}
                                      >
                                        Создать заказ
                                      </MenuItem>
                                    )
                                  )}
                                  {me?.role !== "manager" && (
                                    <MenuItem icon={Users} onClick={() => (close(), nav(`/clients/${c.id}`))}>
                                      Карточка клиента
                                    </MenuItem>
                                  )}
                                  {!order && l.status !== "rejected" && (
                                    <MenuItem
                                      icon={Ban}
                                      danger
                                      onClick={async () => {
                                        close();
                                        if (report(await setLeadStatus(l.id, "rejected", "Не дозвонились"))) toast(`Заявка №${l.number} закрыта`, "info");
                                      }}
                                    >
                                      Закрыть: не дозвонились
                                    </MenuItem>
                                  )}
                                </>
                              )}
                            </Menu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={rows.length} perPage={PER_PAGE} onChange={setPage} noun="заявок" />
          </>
        )}
      </div>
    </>
  );
}
