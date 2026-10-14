import {
  CalendarDays,
  CalendarPlus,
  ChevronRight,
  Clock3,
  Copy,
  Ellipsis,
  FileText,
  Mail,
  MapPin,
  MessageCircle,
  NotebookPen,
  Pencil,
  Phone,
  Plus,
  PlusCircle,
  Receipt,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { CATEGORIES, SOURCES } from "../data/catalog";
import { useMe, useNow, useTeam, useUi } from "../data/hooks";
import { can } from "../data/permissions";
import { clientState, debt, isActive, leadBadge, orderBadge, paidAmount } from "../data/logic";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { addClientNote, report, setClientTags, toast } from "../data/store";
import type { Order } from "../data/types";
import { EntityHistory } from "../components/AuditHistory";
import { ClientEraseCard, ErasedClientNotice } from "../components/ClientPrivacy";
import { ClientRecords } from "../components/ClientRecords";
import { ServiceLabel, SourceIcon } from "../components/icons";
import { Avatar, BackLink, Badge, Button, Card, EmptyState, IconTile, Loading, Menu, MenuItem, Textarea } from "../components/ui";
import { cn, date, dateTime, money, phone, plural, shortName } from "../lib/format";
import { PbxCallButton } from "../components/PbxCallButton";

const tagTone = (t: string) => (t === "VIP" ? "violet" : t === "Постоянный клиент" ? "green" : CATEGORIES.some((c) => c.label === t || t === "Кондиционеры") ? "blue" : "gray");

export default function ClientDetail() {
  const { id } = useParams();
  const d = useQuery(api.clients.detail, { id: id as Id<"clients"> });
  const team = useTeam();
  const now = useNow();
  const nav = useNavigate();
  const ui = useUi();
  const me = useMe();
  const [allTouches, setAllTouches] = useState(false);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [tag, setTag] = useState<string | null>(null);
  const c = d?.client;

  if (d === undefined) return <Loading />;
  if (!c)
    return (
      <div className="card">
        <EmptyState icon={FileText} title="Клиент не найден" action={<Button onClick={() => nav("/clients")}>К списку клиентов</Button>} />
      </div>
    );

  const orders = d!.orders;
  const active = orders.filter(isActive);
  const past = orders.filter((o) => !isActive(o));
  // Сторнированные платежи — ошибочные: в счётчик оплат клиента не входят.
  const payments = orders.flatMap((o) => o.payments.filter((p) => !p.voidedAt));
  const totalPaid = orders.reduce((s, o) => s + paidAmount(o), 0);
  const totalDebt = orders.reduce((s, o) => s + debt(o), 0);
  const touches = d!.interactions;
  const notes = d!.notes;
  const st = clientState(c, now);
  // Данные удалены по запросу клиента: карточка только для чтения, звонить и писать некому.
  const erased = !!c.anonymizedAt;

  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v);
    toast("Скопировано", "info");
  };
  const addTag = () => {
    const t = (tag ?? "").trim();
    if (t && !c.tags.includes(t)) void setClientTags(c.id, [...c.tags, t]).then((r) => report(r));
    setTag(null);
  };

  return (
    <>
      <BackLink to="/clients">К списку клиентов</BackLink>
      <h1 className="mb-5 text-[28px] font-bold tracking-[-0.025em] text-ink sm:text-[32px]">Карточка клиента</h1>
      {c.anonymizedAt && <ErasedClientNotice at={c.anonymizedAt} />}

      <section className="card flex flex-wrap items-center gap-5 p-5 sm:p-6">
        <Avatar name={c.name} size={92} status={st.label === "В работе" || st.label === "Активный" ? "green" : undefined} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-[24px] font-bold tracking-[-0.02em] text-ink">{c.name}</h2>
            <Badge tone={st.tone}>{st.label}</Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-7 gap-y-1.5 text-[15px] text-ink-2">
            {c.phone && (
              <a href={`tel:+${c.phone}`} className="inline-flex items-center gap-2 hover:text-brand-ink">
                <Phone size={18} className="text-muted" /> {phone(c.phone)}
              </a>
            )}
            {c.phone && <PbxCallButton phone={c.phone} clientId={c.id} />}
            <span className="inline-flex items-center gap-2">
              <MapPin size={18} className="text-muted" /> {c.city}
            </span>
            {c.email && (
              <span className="inline-flex items-center gap-2">
                <Mail size={18} className="text-muted" /> {c.email}
              </span>
            )}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {c.tags.map((t) => (
              <span key={t} className="group relative">
                <Badge tone={tagTone(t)} className="px-3 py-1.5 text-[13.5px]">
                  {t}
                </Badge>
                <button onClick={() => void setClientTags(c.id, c.tags.filter((x) => x !== t)).then((r) => report(r))} aria-label={`Убрать тег ${t}`} className="absolute -top-1.5 -right-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-ink text-white group-hover:inline-flex">
                  <X size={11} />
                </button>
              </span>
            ))}
            {erased ? null : tag === null ? (
              <button onClick={() => setTag("")} className="inline-flex items-center gap-1.5 rounded-[8px] bg-slate-bg px-3 py-1.5 text-[13.5px] font-medium text-muted hover:text-ink">
                <Plus size={15} /> Добавить тег
              </button>
            ) : (
              <input
                autoFocus
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                onBlur={addTag}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addTag();
                  if (e.key === "Escape") setTag(null);
                }}
                placeholder="Новый тег"
                className="h-[33px] w-36 rounded-[8px] border border-brand-line px-2.5 text-[13.5px] focus:outline-none"
              />
            )}
          </div>
        </div>
        <div className={cn("flex flex-wrap items-center gap-2.5", erased && "hidden")}>
          <Button size="lg" icon={Plus} className="h-[50px] text-[15px]" onClick={() => ui.openLead({ clientId: c.id })}>
            Новая заявка
          </Button>
          <Button size="lg" variant="secondary" icon={CalendarPlus} className="h-[50px] bg-white text-[15px]" onClick={() => ui.openLead({ clientId: c.id, mode: "order" })}>
            Создать заказ
          </Button>
          <Menu
            width={220}
            trigger={(toggle) => (
              <button onClick={toggle} aria-label="Ещё" className="inline-flex h-[50px] w-[54px] items-center justify-center rounded-[12px] border border-line-strong bg-white text-ink-2 hover:bg-[#f8f6f1]">
                <Ellipsis size={20} />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={Pencil} onClick={() => (close(), ui.openClient(c.id))}>
                  Редактировать
                </MenuItem>
                <MenuItem icon={Phone} onClick={() => (close(), (window.location.href = `tel:+${c.phone}`))}>
                  Позвонить
                </MenuItem>
                <MenuItem icon={MessageCircle} onClick={() => (close(), window.open(`https://wa.me/${c.phone}`, "_blank"))}>
                  Написать в WhatsApp
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
      </section>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2 2xl:grid-cols-[1fr_1fr_0.95fr]">
        <Card
          title="Контактные данные"
          action={
            erased ? undefined : (
              <button onClick={() => ui.openClient(c.id)} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink">
                <Pencil size={15} /> Редактировать
              </button>
            )
          }
        >
          <dl className="divide-y divide-line">
            <Row icon={Phone} label="Телефон" copy={c.phone ? () => copy(phone(c.phone)) : undefined}>
              {c.phone ? phone(c.phone) : <span className="text-muted">—</span>}
            </Row>
            <Row icon={Mail} label="Email" copy={c.email ? () => copy(c.email!) : undefined}>
              {c.email ?? <span className="text-muted">—</span>}
            </Row>
            <Row icon={MapPin} label="Город">
              {c.city}
            </Row>
            <Row icon={MapPin} label="Адрес">
              {c.address ?? <span className="text-muted">—</span>}
            </Row>
            <Row icon={Clock3} label="Предпочтительный способ связи">
              {c.preferredChannel ? (
                <span className="inline-flex items-center gap-2">
                  <SourceIcon source={c.preferredChannel} size={18} /> {SOURCES[c.preferredChannel].label}
                </span>
              ) : (
                <span className="text-muted">—</span>
              )}
            </Row>
            <Row icon={CalendarDays} label="Дата регистрации">
              {date(c.createdAt)}
            </Row>
            <Row icon={NotebookPen} label="Заметки">
              <span className="font-normal">{c.notes ?? <span className="text-muted">—</span>}</span>
            </Row>
          </dl>
        </Card>

        <Card
          title="История обращений"
          action={
            touches.length > 5 ? (
              <button onClick={() => setAllTouches((v) => !v)} className="text-[13.5px] font-medium text-brand-ink">
                {allTouches ? "Свернуть" : `Все обращения (${touches.length}) →`}
              </button>
            ) : undefined
          }
        >
          {touches.length === 0 ? (
            <div className="py-6 text-center text-[14px] text-muted">Обращений пока нет</div>
          ) : (
            <ol className="space-y-1">
              {(allTouches ? touches : touches.slice(0, 5)).map((t) => {
                const lead = t.leadId ? d!.leads.find((l) => l.id === t.leadId) : undefined;
                const b = lead ? leadBadge(lead, orders.find((o) => o.id === lead.orderId), now) : undefined;
                const icon: { I: LucideIcon; tone: "blue" | "red" | "green" } =
                  t.kind === "lead" ? { I: FileText, tone: "blue" } : t.kind === "call" ? { I: Phone, tone: "red" } : { I: MessageCircle, tone: "green" };
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => lead && ui.openLead({ leadId: lead.id })}
                      className={cn("flex w-full items-start gap-3 rounded-[12px] px-1.5 py-2.5 text-left", lead && "hover:bg-[#f8f6f1]")}
                    >
                      <IconTile icon={icon.I} tone={icon.tone} size={38} />
                      <span className="w-[98px] shrink-0 pt-0.5 text-[12.5px] text-muted">{dateTime(t.at).replace(/ \d{4},/, ",")}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-semibold text-ink">{t.title}</span>
                        <span className="block truncate text-[13px] text-muted">{t.text}</span>
                      </span>
                      {b && (
                        <Badge tone={b.tone} size="sm" className="mt-0.5">
                          {b.label}
                        </Badge>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </Card>

        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 2xl:col-span-1">
          {can(me, "money.view") && (
          <Card title="Финансы клиента">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-[14px] bg-ok-bg/60 p-4">
                <div className="flex items-start gap-3">
                  <IconTile icon={Wallet} tone="green" size={40} />
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink-2">Всего оплат</div>
                    <div className="text-[19px] font-bold whitespace-nowrap text-ink tabular-nums xl:text-[21px]">{money(totalPaid)}</div>
                    <div className="text-[12.5px] text-muted">
                      {payments.length} {plural(payments.length, "платёж", "платежа", "платежей")}
                    </div>
                  </div>
                </div>
              </div>
              <div className={cn("rounded-[14px] p-4", totalDebt ? "bg-bad-bg/60" : "bg-brand-soft/60")}>
                <div className="flex items-start gap-3">
                  <IconTile icon={Receipt} tone={totalDebt ? "red" : "yellow"} size={40} />
                  <div className="min-w-0">
                    <div className="text-[13px] text-ink-2">Задолженность</div>
                    <div className={cn("text-[19px] font-bold whitespace-nowrap tabular-nums xl:text-[21px]", totalDebt ? "text-bad-ink" : "text-ink")}>{money(totalDebt)}</div>
                    <div className="text-[12.5px] text-muted">{totalDebt ? "есть неоплаченные заказы" : "Все счета оплачены"}</div>
                  </div>
                </div>
              </div>
            </div>
          </Card>
          )}

          <Card
            title="Комментарии"
            action={
              erased ? undefined : (
                <button onClick={() => setNoting(true)} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink">
                  <PlusCircle size={17} /> Добавить
                </button>
              )
            }
          >
            {noting && (
              <div className="mb-3">
                <Textarea autoFocus rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: просила напоминать о ТО раз в полгода" />
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => (setNoting(false), setNote(""))}>
                    Отмена
                  </Button>
                  <Button
                    size="sm"
                    disabled={!note.trim()}
                    onClick={async () => {
                      if (!report(await addClientNote(c.id, note.trim()))) return;
                      setNote("");
                      setNoting(false);
                    }}
                  >
                    Сохранить
                  </Button>
                </div>
              </div>
            )}
            {notes.length === 0 && !noting ? (
              <div className="py-4 text-center text-[14px] text-muted">Комментариев нет</div>
            ) : (
              <ul className="divide-y divide-line">
                {notes.map((n) => {
                  const u = team.users.find((x) => x.id === n.authorId);
                  return (
                    <li key={n.id} className="flex gap-3 py-3 first:pt-0">
                      <Avatar name={u?.name ?? "?"} size={40} variant="person" />
                      <div className="min-w-0">
                        <div className="flex items-baseline gap-2.5">
                          <span className="text-[14px] font-semibold text-ink">{u?.name.split(" ")[0]}</span>
                          <span className="text-[12.5px] text-muted">{dateTime(n.at)}</span>
                        </div>
                        <p className="mt-0.5 text-[14px] leading-snug text-ink-2">{n.text}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <Card className="mt-4" title="Активные заказы" bodyClass="px-3 pb-3 sm:px-4">
        <OrdersTable orders={active} empty="Активных заказов нет" />
      </Card>
      <Card className="mt-4" title="История заказов" bodyClass="px-3 pb-3 sm:px-4">
        <OrdersTable orders={past} empty="Завершённых заказов пока нет" />
      </Card>
      <ClientRecords clientId={c.id} orders={orders} className="mt-4" />
      <ClientEraseCard client={c} />
      <EntityHistory entity="client" entityId={c.id} variant="card" className="mt-4" />
    </>
  );
}

function Row({ icon: Icon, label, children, copy }: { icon: LucideIcon; label: string; children: ReactNode; copy?: () => void }) {
  return (
    <div className="grid grid-cols-[24px_minmax(0,140px)_1fr_auto] items-start gap-3 py-2.5">
      <Icon size={18} className="mt-0.5 text-muted" />
      <dt className="text-[14px] leading-snug text-muted">{label}</dt>
      <dd className="min-w-0 text-[14px] leading-snug font-medium break-words text-ink">{children}</dd>
      {copy ? (
        <button onClick={copy} aria-label={`Скопировать: ${label}`} className="hit relative text-faint hover:text-brand-ink">
          <Copy size={16} />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

export function OrdersTable({ orders, empty }: { orders: Order[]; empty: string }) {
  const db = useTeam();
  const now = useNow();
  const nav = useNavigate();
  const seesMoney = can(useMe(), "money.view");
  if (!orders.length) return <div className="py-6 text-center text-[14px] text-muted">{empty}</div>;
  return (
    <div className="scroll-x">
      <table className="tbl min-w-[760px]">
        <thead>
          <tr>
            <th>№ заказа</th>
            <th>Дата</th>
            <th>Услуга</th>
            <th>Исполнитель</th>
            <th>Статус</th>
            {seesMoney && <th className="text-right">Сумма</th>}
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const ex = db.executors.find((e) => e.id === o.executorId);
            const b = orderBadge(o, now);
            return (
              <tr key={o.id} className="row-link" onClick={() => nav(`/orders/${o.id}`)}>
                <td className="font-semibold text-ink">
                  <Link to={`/orders/${o.id}`}>№{o.number}</Link>
                </td>
                <td className="whitespace-nowrap text-ink-2">{date(o.createdAt)}</td>
                <td>
                  <ServiceLabel serviceId={o.serviceId} className="max-w-[300px] text-ink-2" />
                </td>
                <td>
                  {ex ? (
                    <span className="flex items-center gap-2">
                      <Avatar name={ex.name} size={28} variant="person" />
                      <span className="text-ink-2">{shortName(ex.name)}</span>
                    </span>
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td>
                  <Badge tone={b.tone}>{b.label}</Badge>
                </td>
                {seesMoney && <td className="text-right font-semibold text-ink tabular-nums">{o.clientPrice ? money(o.clientPrice) : "—"}</td>}
                <td className="text-right text-muted">
                  <ChevronRight size={18} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
