import { KeyRound, Briefcase, CalendarDays, ClipboardCheck, Ellipsis, MapPin, Moon, Pencil, Phone, Plus, Search, Truck, Users, Wallet, Clock, Ban, TrendingUp, FileText } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { APP_NAME, CATEGORIES, CITIES, SERVICES, categoryById } from "../data/catalog";
import { useNow, useUi } from "../data/hooks";
import { EXEC_STATE, executorState, executorStats, isInWork, type ExecState } from "../data/logic";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { report, resetPassword, setExecutorAvailable, setUserActive, toast } from "../data/store";
import { useMe } from "../data/hooks";
import { can } from "../data/permissions";
import type { CategoryId, Executor } from "../data/types";
import { EntityHistory } from "../components/AuditHistory";
import { ExecutorReviews } from "../components/ExecutorReviews";
import { ExecutorShiftCard } from "../components/ExecutorShift";
import { ExecutorMatchCard } from "../components/ExecutorMatchCard";
import { ExecutorRating } from "../components/Rating";
import { ServiceGlyph } from "../components/icons";
import { SkillChips, SkillLine } from "../components/SkillChips";
import { textKey } from "../data/skills";
import { ExportButton } from "../components/ExportButton";
import { Avatar, BackLink, Badge, Button, Card, DotBadge, EmptyState, Input, KpiCard, Loading, Menu, MenuItem, Modal, PageHeader, Select, Toggle } from "../components/ui";
import { OrdersTable } from "./ClientDetail";
import { date, dateTime, money, phone } from "../lib/format";

const firstService = (c: CategoryId) => SERVICES.find((s) => s.category === c)!.id;

export function CategoryLabel({ cats }: { cats: CategoryId[] }) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <ServiceGlyph serviceId={firstService(cats[0]!)} />
      <span className="min-w-0 leading-tight">
        <span className="block truncate">{categoryById(cats[0]!).label}</span>
        {cats.length > 1 && <span className="text-[12.5px] text-muted">+ ещё {cats.length - 1}</span>}
      </span>
    </span>
  );
}

export default function Executors() {
  const data = useQuery(api.executors.list);
  const db = useMemo(() => ({ executors: data?.executors ?? [], orders: data?.load ?? [] }), [data]);
  const nav = useNavigate();
  const ui = useUi();
  const [cat, setCat] = useState("");
  const [city, setCity] = useState("");
  const [st, setSt] = useState<ExecState | "">("");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    // Поиск по имени, телефону и навыку: «фреон» найдёт мастеров с «Заправка фреоном».
    const needle = textKey(q);
    const matches = (e: Executor) =>
      !needle || textKey(e.name).includes(needle) || e.phone.includes(q.replace(/\D/g, "") || "§") || e.skills.some((s) => textKey(s).includes(needle));
    return db.executors
      .map((e) => ({ e, state: executorState(e, db.orders), active: db.orders.filter((o) => o.executorId === e.id && isInWork(o)).length }))
      .filter(({ e, state }) => (!cat || e.categories.includes(cat as CategoryId)) && (!city || e.city === city) && (!st || state === st) && matches(e));
  }, [db.executors, db.orders, cat, city, st, q]);
  const all = db.executors.map((e) => executorState(e, db.orders));
  const count = (s: ExecState) => all.filter((x) => x === s).length;

  return (
    <>
      <PageHeader
        title="Исполнители"
        subtitle="Управление исполнителями, их загрузкой и доступностью"
        actions={
          <>
            <ExportButton kinds={["executors", "payouts"]} height={50} />
            <Button size="lg" icon={Plus} className="h-[50px] text-[15px]" onClick={() => ui.openExecutor()}>
              Добавить исполнителя
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard icon={Users} tone="green" label="Свободны сейчас" value={count("free")} caption={`из ${all.length} исполнителей`} onClick={() => setSt("free")} />
        <KpiCard icon={Briefcase} tone="blue" label="На заказе" value={count("busy")} caption="назначены, ещё не выехали" onClick={() => setSt("busy")} />
        <KpiCard icon={Truck} tone="red" label="На выезде" value={count("onsite")} caption="заказ в статусе «В работе»" onClick={() => setSt("onsite")} />
        <KpiCard icon={Moon} tone="violet" label="Выходные" value={count("off")} caption="не получают заказы" onClick={() => setSt("off")} />
      </div>

      <div className="card mt-4 grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_1.2fr]">
        <div>
          <div className="mb-2 text-[13.5px] font-medium text-ink-2">Специализация</div>
          <Select value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Все специализации</option>
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <div className="mb-2 text-[13.5px] font-medium text-ink-2">Город</div>
          <Select icon={MapPin} value={city} onChange={(e) => setCity(e.target.value)}>
            <option value="">Все города</option>
            {CITIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </div>
        <div>
          <div className="mb-2 text-[13.5px] font-medium text-ink-2">Доступность</div>
          <Select icon={CalendarDays} value={st} onChange={(e) => setSt(e.target.value as ExecState | "")}>
            <option value="">Все статусы</option>
            {(Object.keys(EXEC_STATE) as ExecState[]).map((s) => (
              <option key={s} value={s}>
                {EXEC_STATE[s].label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex items-end">
          <Input icon={Search} placeholder="Имя, телефон или навык" value={q} onChange={(e) => setQ(e.target.value)} className="w-full [&_input]:bg-field [&_input]:border-transparent" />
        </div>
      </div>

      <div className="card mt-4 p-3 sm:p-4">
        {rows.length === 0 ? (
          <EmptyState icon={Users} title="Никого не нашли" text="Измените фильтры или добавьте исполнителя." />
        ) : (
          <div className="scroll-x">
            <table className="tbl min-w-[980px]">
              <thead>
                <tr>
                  <th>Исполнитель</th>
                  <th>Специализация и навыки</th>
                  <th>Город</th>
                  <th>Статус</th>
                  <th>Рейтинг</th>
                  <th className="text-center">Активные заказы</th>
                  <th className="text-right">Действия</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ e, state, active }) => (
                  <tr key={e.id} className="row-link" onClick={() => nav(`/executors/${e.id}`)}>
                    <td className="py-3">
                      <span className="flex items-center gap-3.5">
                        <Avatar name={e.name} size={46} variant="person" />
                        <span className="leading-tight">
                          <span className="block text-[15px] font-semibold text-ink">{e.name}</span>
                          <span className="text-[13px] text-muted">{phone(e.phone)}</span>
                        </span>
                      </span>
                    </td>
                    <td className="max-w-[260px] text-ink-2">
                      <CategoryLabel cats={e.categories} />
                      <SkillLine skills={e.skills} label="Навыки" className="mt-1" />
                    </td>
                    <td className="text-ink-2">
                      <span className="inline-flex items-center gap-1.5">
                        <MapPin size={15} className="text-muted" /> {e.city}
                      </span>
                    </td>
                    <td>
                      <DotBadge tone={EXEC_STATE[state].tone}>{EXEC_STATE[state].label}</DotBadge>
                      {e.unavailableUntil && <div className="mt-1 text-[12.5px] whitespace-nowrap text-muted">до {dateTime(e.unavailableUntil)}</div>}
                    </td>
                    <td className="whitespace-nowrap">
                      <ExecutorRating e={e} count={false} size={17} />
                    </td>
                    <td className="text-center font-medium text-ink tabular-nums">{active}</td>
                    <td onClick={(ev) => ev.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="secondary" className="bg-white px-5" onClick={() => nav(`/executors/${e.id}`)}>
                          Подробнее
                        </Button>
                        <Menu
                          width={230}
                          trigger={(toggle) => (
                            <button onClick={toggle} aria-label="Действия" className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] text-ink-2 hover:bg-[#f4f2ec]">
                              <Ellipsis size={18} className="rotate-90" />
                            </button>
                          )}
                        >
                          {(close) => (
                            <>
                              <MenuItem icon={Moon} onClick={async () => (close(), report(await setExecutorAvailable(e.id, !e.available), e.available ? `${e.name.split(" ")[0]} на выходном` : `${e.name.split(" ")[0]} снова на смене`))}>
                                {e.available ? "Отметить выходной" : "Вернуть на смену"}
                              </MenuItem>
                              <MenuItem icon={Pencil} onClick={() => (close(), ui.openExecutor(e.id))}>
                                Редактировать
                              </MenuItem>
                              <MenuItem icon={Phone} onClick={() => (close(), (window.location.href = `tel:+${e.phone}`))}>
                                Позвонить
                              </MenuItem>
                            </>
                          )}
                        </Menu>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

export function ExecutorDetail() {
  const { id } = useParams();
  const d = useQuery(api.executors.detail, { id: id as Id<"executors"> });
  const me = useMe();
  const now = useNow();
  const nav = useNavigate();
  const ui = useUi();
  const [creds, setCreds] = useState<{ login: string; password: string } | null>(null);
  const e = d?.executor;
  const db = { orders: d?.orders ?? [] };
  if (d === undefined) return <Loading />;
  if (!e)
    return (
      <div className="card">
        <EmptyState icon={FileText} title="Исполнитель не найден" action={<Button onClick={() => nav("/executors")}>К списку</Button>} />
      </div>
    );
  const state = executorState(e, db.orders);
  const s = executorStats(e, db.orders, now);
  const mine = db.orders.filter((o) => o.executorId === e.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = mine.filter(isInWork);
  const done = mine.filter((o) => !isInWork(o)).slice(0, 15);

  return (
    <>
      <BackLink to="/executors">К списку исполнителей</BackLink>
      <section className="card mt-1 flex flex-wrap items-center gap-5 p-5 sm:p-6">
        <Avatar name={e.name} size={92} variant="person" status={state === "off" ? "red" : "green"} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[26px] font-bold tracking-[-0.02em] text-ink">{e.name}</h1>
            <DotBadge tone={EXEC_STATE[state].tone}>{EXEC_STATE[state].label}</DotBadge>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5 text-[15px] text-ink-2">
            <a href={`tel:+${e.phone}`} className="inline-flex items-center gap-2 hover:text-brand-ink">
              <Phone size={17} className="text-muted" /> {phone(e.phone)}
            </a>
            <span className="inline-flex items-center gap-2">
              <MapPin size={17} className="text-muted" /> {e.city}
            </span>
            <ExecutorRating e={e} size={17} />
            <span className="text-muted">
              {e.cooperation === "staff" ? "В штате" : "Фрилансер"} · с {date(e.joinedAt)}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {e.categories.map((c) => (
              <Badge key={c} tone="blue" className="px-3 py-1.5 text-[13px]">
                {categoryById(c).label}
              </Badge>
            ))}
          </div>
          <div className="mt-2.5">
            <SkillChips
              skills={e.skills}
              markCustom
              empty={
                <button onClick={() => ui.openExecutor(e.id)} className="text-[13.5px] font-medium text-brand-ink hover:text-brand-deep">
                  Навыки не отмечены — отметьте, чтобы мастер видел заказы, где они нужны
                </button>
              }
            />
          </div>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <Toggle checked={e.available} onChange={async (v) => void report(await setExecutorAvailable(e.id, v), v ? "Снова на смене — получает заказы" : "Выходной — заказы не приходят")} label={e.available ? "На смене" : "Выходной"} />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={Pencil} className="bg-white" onClick={() => ui.openExecutor(e.id)}>
              Редактировать
            </Button>
            {me?.role === "owner" && d.user && (
              <Menu
                width={250}
                trigger={(toggle) => (
                  <Button variant="secondary" icon={KeyRound} className="bg-white" onClick={toggle}>
                    Доступ
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem
                      icon={KeyRound}
                      hint="Старые входы закроются"
                      onClick={async () => {
                        close();
                        const r = await resetPassword(d.user!.id);
                        if (report(r)) setCreds(r.value);
                      }}
                    >
                      Выдать новый пароль
                    </MenuItem>
                    <MenuItem
                      icon={Ban}
                      danger={d.user!.active !== false}
                      onClick={async () => {
                        close();
                        const on = d.user!.active === false;
                        report(await setUserActive(d.user!.id, on), on ? "Доступ включён" : "Доступ отключён — войти он больше не сможет");
                      }}
                    >
                      {d.user?.active === false ? "Включить доступ" : "Отключить доступ"}
                    </MenuItem>
                  </>
                )}
              </Menu>
            )}
          </div>
          <div className="text-[12.5px] text-muted">
            Логин: <b className="text-ink-2">{phone(e.phone)}</b>
            {d.user?.telegram ? " · Telegram подключён" : ""}
            {d.user?.active === false ? " · доступ отключён" : ""}
          </div>
        </div>
      </section>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        <KpiCard icon={ClipboardCheck} tone="green" label="Выполнено" value={s.done} />
        <KpiCard icon={Briefcase} tone="blue" label="В работе" value={s.active} />
        <KpiCard icon={Clock} tone="red" label="Просрочки" value={s.overdue} caption={`${s.lateDone} сдано позже срока`} />
        <KpiCard icon={Ban} tone="gray" label="Отмены" value={s.cancelled} />
        {/* Доход мастера и долг ему — выплаты: по праву «Выплаты мастерам и маржа» (ТЗ п.5.12). */}
        {can(me, "money.payouts") && (
          <>
            <KpiCard icon={TrendingUp} tone="violet" label="Доход за 30 дней" value={money(s.incomeMonth)} />
            <KpiCard icon={Wallet} tone="amber" label="К выплате" value={money(s.toPay)} caption="выполнено, ещё не выплачено" />
          </>
        )}
      </div>
      <ExecutorShiftCard e={e} className="mt-4" />
      <ExecutorMatchCard e={e} className="mt-4" />
      <ExecutorReviews e={e} className="mt-4" />

      <Modal open={!!creds} onClose={() => setCreds(null)} title="Новый пароль" width={440}>
        {creds && (
          <div className="space-y-3 text-[15px]">
            <p className="text-[14px] text-muted">Передайте исполнителю — пароль показывается один раз. При первом входе он придумает свой.</p>
            <div className="flex justify-between">
              <span className="text-muted">Логин</span>
              <b>{phone(creds.login)}</b>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Пароль</span>
              <b className="font-mono tracking-wide">{creds.password}</b>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(`${APP_NAME} — вход: ${window.location.origin}\nЛогин: ${creds.login}\nПароль: ${creds.password}`);
                toast("Скопировано", "info");
              }}
            >
              Скопировать для отправки
            </Button>
          </div>
        )}
      </Modal>

      <Card className="mt-4" title="Активные заказы" bodyClass="px-3 pb-3 sm:px-4">
        <OrdersTable orders={active} empty="Сейчас заказов нет" />
      </Card>
      <Card className="mt-4" title="Последние заказы" bodyClass="px-3 pb-3 sm:px-4">
        <OrdersTable orders={done} empty="Пока нет выполненных заказов" />
      </Card>
      <EntityHistory entity="executor" entityId={e.id} variant="card" className="mt-4" />
    </>
  );
}
