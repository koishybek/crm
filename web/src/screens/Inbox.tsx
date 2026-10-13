// «Сообщения» (ТЗ п.3, п.16): единый чат с клиентами из Telegram, WhatsApp, OLX и с сайта.
// Слева — диалоги с фильтрами, справа — переписка и ответ. На телефоне: список → чат на весь экран (кнопка «назад»).
// Открытый диалог — в адресе (/inbox?c=<id>): ссылки из уведомлений ведут прямо в него, «назад» в браузере работает.
import { usePaginatedQuery, useQuery } from "convex/react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Check,
  CheckCheck,
  CircleAlert,
  Clock3,
  EllipsisVertical,
  ExternalLink,
  FilePlus2,
  FileText,
  Info,
  MapPin,
  MessagesSquare,
  Phone,
  Search,
  SendHorizontal,
  UserCheck,
  UserMinus,
  UserRound,
  UserRoundSearch,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../../convex/_generated/api";
import { isPlaceholder, REPLY_BLOCK, whatsappWindowClosed } from "../../convex/lib/chat";
import { OLX_MAX_TEXT } from "../../convex/lib/olx";
import { SourceIcon } from "../components/icons";
import { SignedAudio, SignedImg, SignedVideo } from "../components/SignedMedia";
import { Avatar, Badge, Button, EmptyState, IconButton, Input, Loading, Menu, MenuItem, Modal, PageHeader } from "../components/ui";
import { LEAD_STATUS } from "../data/catalog";
import { useFileQuery } from "../data/files";
import { useMe, useNow, useTeam, useUi } from "../data/hooks";
import { assignConversation, channelLabel, closeConversation, linkConversationClient, markConversationRead, reopenConversation, replyDraft, resendReply, sendReply } from "../data/inbox";
import { report, type Result } from "../data/store";
import type { Channel, Conversation, ConversationDetail, ConversationMessage, InboxFilter, MessageStatus } from "../data/types";
import { cn, dayDiff, hm, phone, shortName, whenShort } from "../lib/format";

const FILTERS: { id: InboxFilter; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "unread", label: "Непрочитанные" },
  { id: "mine", label: "Мои" },
  { id: "telegram", label: "Telegram" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "olx", label: "OLX" },
  { id: "site", label: "Сайт" },
  { id: "closed", label: "Закрытые" },
];
const isChannel = (f: InboxFilter): f is Channel => f === "telegram" || f === "whatsapp" || f === "olx" || f === "site";

const EMPTY: Record<"all" | "unread" | "mine" | "closed" | "channel", { title: string; text: string }> = {
  all: { title: "Пока нет сообщений", text: "Сюда приходят сообщения клиентов из Telegram-бота, WhatsApp и OLX, а также заявки с сайта." },
  unread: { title: "Всё прочитано", text: "Новые сообщения клиентов появятся здесь." },
  mine: { title: "Нет ваших диалогов", text: "Возьмите диалог себе — меню «⋮» в переписке." },
  closed: { title: "Закрытых диалогов нет", text: "Закрытый диалог откроется сам, когда клиент напишет снова." },
  channel: { title: "Здесь пока пусто", text: "Диалогов из этого канала ещё не было." },
};

const contactTitle = (c: Pick<Conversation, "contactName" | "contactPhone" | "channel">) => c.contactName || (c.contactPhone ? phone(c.contactPhone) : `Клиент из ${channelLabel(c.channel)}`);
/** Номер для звонка: только российский/казахстанский формат, иностранный — как есть. */
const callable = (p?: string) => (p && /^\d{10,15}$/.test(p) ? p : undefined);

const dayFmt = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const dayFmtYear = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });
function dayLabel(iso: string, now: number): string {
  const d = new Date(iso);
  const diff = dayDiff(d, new Date(now));
  if (diff === 0) return "Сегодня";
  if (diff === -1) return "Вчера";
  return (d.getFullYear() === new Date(now).getFullYear() ? dayFmt : dayFmtYear).format(d);
}

/** Аватар собеседника со значком канала. */
function ContactAvatar({ c, size = 44 }: { c: Pick<Conversation, "contactName" | "contactPhone" | "channel">; size?: number }) {
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar name={contactTitle(c)} size={size} />
      <span className="absolute -right-1 -bottom-1 inline-flex h-[22px] w-[22px] items-center justify-center rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.15)]" title={channelLabel(c.channel)}>
        <SourceIcon source={c.channel} size={14} />
      </span>
    </span>
  );
}

export default function Inbox() {
  const [params, setParams] = useSearchParams();
  const selected = params.get("c");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const select = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("c", id);
    else next.delete("c");
    setParams(next);
  };

  return (
    <>
      <div className={cn(selected && "hidden lg:block")}>
        <PageHeader title="Сообщения" subtitle="Переписка с клиентами из Telegram, WhatsApp, OLX и заявки с сайта — в одном окне" />
      </div>
      <div className="card overflow-hidden lg:grid lg:h-[calc(100dvh-236px)] lg:min-h-[520px] lg:grid-cols-[minmax(300px,380px)_1fr]">
        <ConversationList filter={filter} onFilter={setFilter} selected={selected} onSelect={select} />
        {selected ? (
          <ChatPane key={selected} id={selected} onBack={() => select(null)} />
        ) : (
          <div className="hidden min-h-0 flex-col items-center justify-center bg-[#f7f6f2] lg:flex">
            <EmptyState icon={MessagesSquare} title="Выберите диалог" text="Ответ уходит клиенту в тот же канал, откуда он написал. Из переписки можно сразу создать заявку." />
          </div>
        )}
      </div>
    </>
  );
}

// ── Список диалогов ──────────────────────────────────────────────────────────

function ConversationList({ filter, onFilter, selected, onSelect }: { filter: InboxFilter; onFilter: (f: InboxFilter) => void; selected: string | null; onSelect: (id: string) => void }) {
  const now = useNow(60_000);
  const { results, status, loadMore } = usePaginatedQuery(api.inbox.list, { filter }, { initialNumItems: 30 });
  const empty = EMPTY[isChannel(filter) ? "channel" : filter];
  return (
    <aside className={cn("min-h-0 min-w-0 flex-col border-line lg:flex lg:border-r", selected ? "hidden" : "flex")} aria-label="Диалоги">
      {/* На телефоне фильтры листаются в одну строку, на компьютере — переносятся. */}
      <div className="scroll-x scroll-thin flex shrink-0 gap-1.5 border-b border-line px-3 py-3 lg:flex-wrap lg:overflow-visible" role="tablist" aria-label="Фильтр диалогов">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => onFilter(f.id)}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13.5px] font-semibold transition-colors lg:h-8 lg:px-2.5 lg:text-[13px]",
              filter === f.id ? "border-brand bg-brand-soft text-ink" : "border-line-strong bg-white text-ink-2 hover:border-brand-line",
            )}
          >
            {isChannel(f.id) && <SourceIcon source={f.id} size={15} />}
            {f.label}
          </button>
        ))}
      </div>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {status === "LoadingFirstPage" ? (
          <Loading />
        ) : results.length === 0 ? (
          <EmptyState icon={MessagesSquare} title={empty.title} text={empty.text} />
        ) : (
          <ul className="divide-y divide-line">
            {results.map((c) => (
              <li key={c.id}>
                <ConversationRow c={c} active={c.id === selected} now={now} onClick={() => onSelect(c.id)} />
              </li>
            ))}
          </ul>
        )}
        {status === "CanLoadMore" && (
          <div className="p-3 text-center">
            <Button size="sm" variant="secondary" onClick={() => loadMore(30)}>
              Показать ещё
            </Button>
          </div>
        )}
        {status === "LoadingMore" && <Loading className="py-4" text="Загружаем…" />}
      </div>
    </aside>
  );
}

function ConversationRow({ c, active, now, onClick }: { c: Conversation; active: boolean; now: number; onClick: () => void }) {
  const unread = c.unread > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn("flex w-full items-start gap-3 px-4 py-3 text-left transition-colors", active ? "bg-brand-soft/70" : "hover:bg-[#faf8f3]", c.status === "closed" && "opacity-75")}
    >
      <ContactAvatar c={c} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[15px] text-ink", unread ? "font-bold" : "font-semibold")}>{contactTitle(c)}</span>
          <span className={cn("shrink-0 text-[12px]", unread ? "font-semibold text-brand-ink" : "text-muted")}>{whenShort(c.lastMessageAt, new Date(now))}</span>
        </span>
        {c.subject && <span className="block truncate text-[12.5px] text-muted">{c.subject}</span>}
        <span className="mt-0.5 flex items-center gap-2">
          <span className={cn("min-w-0 flex-1 truncate text-[13.5px]", unread ? "text-ink-2" : "text-muted")}>
            {c.lastDirection === "out" && <span className="text-muted">Вы: </span>}
            {c.lastText}
          </span>
          {unread && (
            <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-brand px-1.5 text-[11.5px] font-bold text-on-brand" aria-label={`Непрочитанных: ${c.unread}`}>
              {c.unread > 99 ? "99+" : c.unread}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

// ── Переписка ────────────────────────────────────────────────────────────────

const PAGE = 100;

function ChatPane({ id, onBack }: { id: string; onBack: () => void }) {
  const [limit, setLimit] = useState(PAGE);
  const data = useFileQuery(api.inbox.get, { id, limit });
  const unread = data?.conversation.unread ?? 0;

  // Открытый диалог прочитан — но только когда вкладка на экране, а не в фоне.
  useEffect(() => {
    if (!unread) return;
    const mark = () => {
      if (document.visibilityState === "visible") void markConversationRead(id);
    };
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
  }, [id, unread]);

  return (
    <section className="fixed inset-0 z-40 flex min-h-0 min-w-0 flex-col bg-white lg:static lg:z-auto" aria-label="Переписка">
      {data === undefined ? (
        <>
          <div className="flex items-center gap-2 border-b border-line px-3 py-3 lg:hidden">
            <IconButton icon={ArrowLeft} label="К списку диалогов" onClick={onBack} className="h-10 w-10" />
          </div>
          <Loading className="flex-1" />
        </>
      ) : data === null ? (
        <>
          <div className="flex items-center gap-2 border-b border-line px-3 py-3 lg:hidden">
            <IconButton icon={ArrowLeft} label="К списку диалогов" onClick={onBack} className="h-10 w-10" />
          </div>
          <EmptyState icon={MessagesSquare} title="Диалог не найден" text="Ссылка устарела или диалог удалён. Выберите другой в списке." />
        </>
      ) : (
        <Chat detail={data} onBack={onBack} onMore={() => setLimit((n) => n + PAGE)} />
      )}
    </section>
  );
}

function Chat({ detail, onBack, onMore }: { detail: ConversationDetail; onBack: () => void; onMore: () => void }) {
  const c = detail.conversation;
  const now = useNow(60_000);
  const windowClosed = c.channel === "whatsapp" && whatsappWindowClosed(c.replyUntil, now);
  const block = detail.replyBlock ?? (windowClosed ? REPLY_BLOCK.windowClosed : undefined);
  return (
    <>
      <ChatHeader detail={detail} onBack={onBack} />
      {c.subject && (
        <div className="flex items-center gap-2 border-b border-line bg-[#fffaf0] px-4 py-2 text-[13px]">
          <span className="shrink-0 text-muted">{c.channel === "olx" ? "Объявление:" : "Тема:"}</span>
          {c.subjectUrl ? (
            <a href={c.subjectUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 items-center gap-1 font-semibold text-brand-ink hover:underline">
              <span className="truncate">{c.subject}</span>
              <ExternalLink size={13} className="shrink-0" aria-hidden />
            </a>
          ) : (
            <span className="truncate font-semibold text-ink">{c.subject}</span>
          )}
        </div>
      )}
      <MessageList detail={detail} onMore={onMore} />
      {block ? <ReplyBlocked reason={block} tel={callable(detail.client?.phone ?? c.contactPhone)} /> : <ReplyBox key={c.id} c={c} />}
    </>
  );
}

function ChatHeader({ detail, onBack }: { detail: ConversationDetail; onBack: () => void }) {
  const c = detail.conversation;
  const me = useMe();
  const team = useTeam();
  const ui = useUi();
  const nav = useNavigate();
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState(false);
  const tel = callable(detail.client?.phone ?? c.contactPhone);
  const assignee = c.assigneeId ? team.userName(c.assigneeId) : "";
  const staff = team.users.filter((u) => (u.role === "owner" || u.role === "operator") && u.active !== false && u.id !== c.assigneeId);

  const act = async (p: Promise<Result<unknown>>, okText: string) => {
    setBusy(true);
    report(await p, okText);
    setBusy(false);
  };
  const createLead = () => ui.openLead({ conversationId: c.id, phone: c.contactPhone && /^7\d{10}$/.test(c.contactPhone) ? c.contactPhone : undefined, clientId: detail.client?.id });
  const openLead = () => detail.lead && (detail.lead.orderId ? nav(`/orders/${detail.lead.orderId}`) : ui.openLead({ leadId: detail.lead.id }));
  const toggle = () => (c.status === "open" ? act(closeConversation(c.id), "Диалог закрыт") : act(reopenConversation(c.id), "Диалог снова открыт"));

  return (
    <header className="shrink-0 border-b border-line px-2 py-2.5 sm:px-4">
      <div className="flex items-center gap-2 sm:gap-3">
        <IconButton icon={ArrowLeft} label="К списку диалогов" onClick={onBack} className="h-10 w-10 lg:hidden" />
        <ContactAvatar c={c} size={42} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[16px] font-semibold text-ink">{detail.client?.name ?? contactTitle(c)}</span>
            {c.status === "closed" && (
              <Badge tone="gray" size="sm">
                закрыт
              </Badge>
            )}
          </div>
          <div className="truncate text-[13px] text-muted">
            {channelLabel(c.channel)}
            {tel && (
              <>
                {" · "}
                <a href={`tel:+${tel}`} className="hover:text-brand-ink">
                  {phone(tel)}
                </a>
              </>
            )}
            {detail.telegramUsername && (
              <span className="hidden sm:inline">
                {" · "}
                <a href={`https://t.me/${encodeURIComponent(detail.telegramUsername)}`} target="_blank" rel="noopener noreferrer" className="hover:text-brand-ink">
                  @{detail.telegramUsername}
                </a>
              </span>
            )}
            {assignee && ` · ведёт ${shortName(assignee)}`}
          </div>
        </div>

        {/* На телефоне главная кнопка — заявка, остальное в меню; на компьютере действия — строкой ниже. */}
        <div className="lg:hidden">
          {detail.lead ? (
            <Button size="sm" variant="secondary" onClick={openLead}>
              №{detail.lead.number}
            </Button>
          ) : (
            <Button size="sm" icon={FilePlus2} onClick={createLead} aria-label="Создать заявку">
              <span className="hidden sm:inline">Заявка</span>
            </Button>
          )}
        </div>
        <Menu
          width={270}
          trigger={(toggleMenu) => <IconButton icon={EllipsisVertical} label="Действия с диалогом" onClick={toggleMenu} className="h-10 w-10" />}
        >
          {(close) => (
            <>
              {tel && (
                <MenuItem icon={Phone} onClick={() => (close(), window.location.assign(`tel:+${tel}`))}>
                  Позвонить {phone(tel)}
                </MenuItem>
              )}
              {detail.client ? (
                <MenuItem icon={UserRound} onClick={() => (close(), nav(`/clients/${detail.client!.id}`))}>
                  Карточка клиента
                </MenuItem>
              ) : (
                <MenuItem icon={UserRoundSearch} hint="Найти клиента в базе по имени или номеру" onClick={() => (close(), setLinking(true))}>
                  Связать с клиентом
                </MenuItem>
              )}
              {me && c.assigneeId !== me.id && (
                <MenuItem icon={UserCheck} hint="Новые сообщения — только вам" onClick={() => (close(), void act(assignConversation(c.id, me.id), "Диалог ваш"))}>
                  Взять себе
                </MenuItem>
              )}
              {c.assigneeId && (
                <MenuItem icon={UserMinus} onClick={() => (close(), void act(assignConversation(c.id), "Назначение снято"))}>
                  Снять назначение
                </MenuItem>
              )}
              {staff
                .filter((u) => u.id !== me?.id)
                .slice(0, 8)
                .map((u) => (
                  <MenuItem key={u.id} icon={UserRound} onClick={() => (close(), void act(assignConversation(c.id, u.id), `Диалог передан: ${shortName(u.name)}`))}>
                    Передать: {shortName(u.name)}
                  </MenuItem>
                ))}
              <MenuItem icon={c.status === "open" ? Archive : ArchiveRestore} onClick={() => (close(), void toggle())}>
                {c.status === "open" ? "Закрыть диалог" : "Открыть снова"}
              </MenuItem>
            </>
          )}
        </Menu>
      </div>

      <div className="mt-2.5 hidden flex-wrap items-center gap-2 lg:flex">
        {detail.lead ? (
          <Button size="sm" variant="secondary" onClick={openLead}>
            {detail.lead.orderId ? `Заказ №${detail.lead.number}` : `Заявка №${detail.lead.number}`}
            <Badge tone={LEAD_STATUS[detail.lead.status].tone} size="sm">
              {LEAD_STATUS[detail.lead.status].label}
            </Badge>
          </Button>
        ) : (
          <Button size="sm" icon={FilePlus2} onClick={createLead}>
            Создать заявку
          </Button>
        )}
        {detail.client && (
          <Button size="sm" variant="secondary" icon={UserRound} onClick={() => nav(`/clients/${detail.client!.id}`)}>
            Карточка клиента
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={c.status === "open" ? Archive : ArchiveRestore} disabled={busy} onClick={() => void toggle()}>
          {c.status === "open" ? "Закрыть диалог" : "Открыть снова"}
        </Button>
      </div>
      <LinkClientModal conversationId={c.id} open={linking} onClose={() => setLinking(false)} />
    </header>
  );
}

function LinkClientModal({ conversationId, open, onClose }: { conversationId: string; open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const found = useQuery(api.clients.list, open && dq.length >= 2 ? { q: dq } : "skip");
  const link = async (clientId: string) => {
    if (report(await linkConversationClient(conversationId, clientId), "Диалог связан с клиентом")) onClose();
  };
  return (
    <Modal open={open} onClose={onClose} title="Связать с клиентом" width={480}>
      <Input icon={Search} autoFocus placeholder="Имя или телефон клиента" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск клиента" />
      <div className="mt-3 min-h-[120px]">
        {dq.length < 2 ? (
          <p className="py-6 text-center text-[13.5px] text-muted">Начните вводить имя или номер — от двух символов.</p>
        ) : found === undefined ? (
          <Loading className="py-8" />
        ) : found.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-muted">Не нашли «{dq}». Клиент появится в базе, когда вы создадите заявку из этого чата.</p>
        ) : (
          <ul className="divide-y divide-line">
            {found.slice(0, 20).map((cl) => (
              <li key={cl.id}>
                <button type="button" onClick={() => void link(cl.id)} className="flex w-full items-center gap-3 rounded-[10px] px-2 py-2.5 text-left hover:bg-[#f7f4ec]">
                  <Avatar name={cl.name} size={36} />
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-semibold text-ink">{cl.name}</span>
                    <span className="text-[12.5px] text-muted">
                      {phone(cl.phone)} · {cl.city}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

// ── Лента сообщений ──────────────────────────────────────────────────────────

function MessageList({ detail, onMore }: { detail: ConversationDetail; onMore: () => void }) {
  const now = useNow(60_000);
  const team = useTeam();
  const ref = useRef<HTMLDivElement>(null);
  /** Пока человек внизу ленты, новые сообщения прокручивают её; если он читает историю — не дёргаем. */
  const atBottom = useRef(true);
  /** Высота до подгрузки ранних сообщений — чтобы лента не прыгнула. */
  const restore = useRef<number | null>(null);
  // Просмотр фото — по id: ссылка (живёт 15 минут) берётся из свежих данных, а не та, что была при клике.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const msgs = detail.messages;
  const preview = previewId ? (msgs.find((m) => m.id === previewId) ?? null) : null;
  const last = msgs.at(-1);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (restore.current !== null) {
      el.scrollTop = el.scrollHeight - restore.current;
      restore.current = null;
      return;
    }
    if (atBottom.current || (last?.direction === "out" && last.kind !== "system")) el.scrollTop = el.scrollHeight;
  }, [last?.id, msgs.length, last?.direction, last?.kind]);

  // Поле ответа выросло или повернули телефон — лента стала ниже; если человек был внизу, остаёмся внизу.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const more = () => {
    const el = ref.current;
    if (el) restore.current = el.scrollHeight - el.scrollTop;
    onMore();
  };

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#f7f6f2] px-3 py-4 sm:px-6"
      role="log"
      aria-live="polite"
      aria-label="Сообщения диалога"
    >
      {detail.hasMore && (
        <div className="mb-3 text-center">
          <Button size="sm" variant="secondary" onClick={more}>
            Показать ранние сообщения
          </Button>
        </div>
      )}
      {msgs.length === 0 && <p className="py-10 text-center text-[14px] text-muted">Сообщений пока нет.</p>}
      {msgs.map((m, i) => (
        <div key={m.id}>
          {(i === 0 || dayDiff(new Date(msgs[i - 1]!.at), new Date(m.at)) !== 0) && (
            <div className="my-3 flex justify-center">
              <span className="rounded-full bg-white px-3 py-1 text-[12px] font-medium text-muted shadow-[0_1px_2px_rgba(0,0,0,0.05)]">{dayLabel(m.at, now)}</span>
            </div>
          )}
          <Bubble m={m} author={m.authorId ? shortName(team.userName(m.authorId) || "Сотрудник") : ""} onPreview={(x) => setPreviewId(x.id)} />
        </div>
      ))}
      <Modal open={!!preview} onClose={() => setPreviewId(null)} title={preview?.fileName ?? "Фото"} width={820}>
        <SignedImg src={preview?.fileUrl} alt={preview?.fileName ?? "Фото клиента"} className="w-full rounded-[12px]" />
      </Modal>
    </div>
  );
}

const DELIVERY: Record<MessageStatus, { icon: LucideIcon; label: string; tone?: string }> = {
  sending: { icon: Clock3, label: "Отправляется" },
  sent: { icon: Check, label: "Отправлено" },
  delivered: { icon: CheckCheck, label: "Доставлено" },
  read: { icon: CheckCheck, label: "Прочитано", tone: "text-sky" },
  failed: { icon: CircleAlert, label: "Не отправлено", tone: "text-bad" },
};

function Delivery({ m }: { m: ConversationMessage }) {
  const d = DELIVERY[m.status ?? "sent"];
  return (
    <span className={cn("inline-flex", d.tone)} title={d.label}>
      <d.icon size={14} aria-hidden />
      <span className="sr-only">{d.label}</span>
    </span>
  );
}

/** Ссылки в тексте клиента — кликабельные (только http/https; остальное — обычный текст, React его экранирует). */
function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>"]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-blue underline">
            {p}
          </a>
        ) : (
          p
        ),
      )}
    </>
  );
}

const VIDEO = /\.(mp4|mov|webm|m4v)$/i;
/** Координаты в тексте геопозиции: Telegram — «43.238949, 76.889709», WhatsApp — «📍 Место» + координаты + ссылка на карту. */
const COORDS = /(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/;

/** Название и адрес места (WhatsApp) — первая строка «📍 …», если в ней не сами координаты. */
function placeOf(text: string): string | undefined {
  const first = text.split("\n", 1)[0]!;
  const place = first.startsWith("📍") ? first.slice("📍".length).trim() : "";
  return place && !COORDS.test(place) ? place : undefined;
}

function Media({ m, onPreview }: { m: ConversationMessage; onPreview: (m: ConversationMessage) => void }) {
  if (m.kind === "location") {
    const g = COORDS.exec(m.text);
    if (!g) return null;
    const [lat, lon] = [g[1]!, g[2]!];
    const place = placeOf(m.text);
    return (
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13.5px]">
        <span className="inline-flex items-center gap-1 font-semibold text-ink">
          <MapPin size={15} className="text-bad" aria-hidden /> Геопозиция клиента
        </span>
        <a href={`https://yandex.kz/maps/?pt=${lon},${lat}&z=17&l=map`} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-ink hover:underline">
          Яндекс Карты
        </a>
        <a href={`https://www.google.com/maps/search/?api=1&query=${lat},${lon}`} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-ink hover:underline">
          Google Карты
        </a>
        {place && <span className="basis-full text-ink-2">{place}</span>}
      </div>
    );
  }
  if (!m.fileUrl) {
    return m.kind === "image" || m.kind === "audio" || m.kind === "file" ? <div className="mb-1 text-[12.5px] text-muted italic">Файл не сохранился — попросите клиента прислать ещё раз</div> : null;
  }
  if (m.kind === "image") {
    return (
      <button type="button" onClick={() => onPreview(m)} className="mb-1 block overflow-hidden rounded-[10px]" aria-label="Открыть фото">
        <SignedImg
          src={m.fileUrl}
          alt={m.fileName ?? "Фото клиента"}
          loading="lazy"
          className="max-h-[300px] max-w-full object-cover"
          fallback={<span className="block px-3 py-6 text-[12.5px] text-muted">Фото не загрузилось</span>}
        />
      </button>
    );
  }
  if (m.kind === "audio") {
    return (
      <SignedAudio controls preload="none" src={m.fileUrl} className="mb-1 h-10 w-[260px] max-w-full">
        <a href={m.fileUrl}>Скачать голосовое</a>
      </SignedAudio>
    );
  }
  if (VIDEO.test(m.fileName ?? "")) {
    return <SignedVideo controls preload="metadata" src={m.fileUrl} className="mb-1 max-h-[300px] max-w-full rounded-[10px]" />;
  }
  return (
    <a href={m.fileUrl} target="_blank" rel="noopener noreferrer" className="mb-1 inline-flex max-w-full items-center gap-2 rounded-[10px] border border-line bg-white px-3 py-2 text-[13px] text-ink-2 hover:border-brand-line">
      <FileText size={16} className="shrink-0 text-brand-ink" aria-hidden />
      <span className="truncate">{m.fileName ?? "Файл"}</span>
    </a>
  );
}

function Bubble({ m, author, onPreview }: { m: ConversationMessage; author: string; onPreview: (m: ConversationMessage) => void }) {
  const [busy, setBusy] = useState(false);
  if (m.kind === "system") {
    // Входящая отметка (реакция клиента, смена номера, «не поддерживается») — от канала, а не автоответ бота.
    const fromChannel = m.direction === "in";
    const Icon = fromChannel ? Info : Bot;
    return (
      <div className="my-2 flex justify-center">
        <div className="max-w-[88%] rounded-[12px] bg-[#ece9e2] px-3 py-1.5 text-[12.5px] leading-snug text-ink-2 sm:max-w-[75%]">
          <Icon size={13} className="mr-1 -mt-0.5 inline text-muted" aria-hidden />
          <span className="sr-only">{fromChannel ? "Служебная отметка: " : "Автоответ бота: "}</span>
          <span className="whitespace-pre-wrap">{m.text}</span>
          <span className="ml-1.5 text-[11px] text-muted">{hm(new Date(m.at))}</span>
          {m.status === "failed" && <span className="ml-1 text-[11px] text-bad-ink">· не доставлено</span>}
        </div>
      </div>
    );
  }
  const out = m.direction === "out";
  const showText = m.kind === "location" ? false : !(m.fileUrl && isPlaceholder(m.text));
  const retry = async () => {
    setBusy(true);
    report(await resendReply(m.id));
    setBusy(false);
  };
  return (
    <div className={cn("my-1.5 flex", out ? "justify-end" : "justify-start")}>
      <div className={cn("max-w-[88%] rounded-[16px] px-3.5 py-2 shadow-[0_1px_1px_rgba(0,0,0,0.05)] sm:max-w-[70%]", out ? "rounded-br-[6px] bg-brand-soft" : "rounded-bl-[6px] bg-white")}>
        {out && author && <div className="mb-0.5 text-[12px] font-semibold text-brand-ink">{author}</div>}
        <Media m={m} onPreview={onPreview} />
        {showText && (
          <div className="text-[14.5px] leading-snug break-words whitespace-pre-wrap text-ink">
            <Linkified text={m.text} />
          </div>
        )}
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[11.5px] text-muted">
          {hm(new Date(m.at))}
          {out && <Delivery m={m} />}
        </div>
        {out && m.status === "failed" && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2 border-t border-[#f3d7a0] pt-1 text-[12.5px] text-bad-ink">
            <span className="min-w-0 flex-1">{m.error ?? "Не отправлено"}</span>
            <button type="button" disabled={busy} onClick={() => void retry()} className="font-semibold underline disabled:opacity-50">
              Повторить
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Ответ ────────────────────────────────────────────────────────────────────

const MAX_REPLY = 4000;
/** На телефоне Enter — новая строка (как в мессенджерах), отправка — кнопкой; на компьютере Enter отправляет. */
const touchKeyboard = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

function ReplyBox({ c }: { c: Conversation }) {
  const [text, setText] = useState(() => replyDraft.get(c.id));
  const [sending, setSending] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => replyDraft.set(c.id, text), [c.id, text]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    const r = await sendReply(c.id, body);
    setSending(false);
    if (!report(r)) return;
    setText("");
    ref.current?.focus();
  };

  return (
    <form
      className="shrink-0 border-t border-line bg-white px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] sm:px-4"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          maxLength={c.channel === "olx" ? OLX_MAX_TEXT : MAX_REPLY}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !touchKeyboard()) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Ответ в ${channelLabel(c.channel)}…`}
          aria-label="Ответ клиенту"
          className="field max-h-40 min-h-[46px] flex-1 resize-none"
        />
        <button
          type="submit"
          disabled={!text.trim() || sending}
          aria-label="Отправить"
          className="inline-flex h-[46px] w-[46px] shrink-0 items-center justify-center rounded-full bg-brand text-on-brand transition-colors hover:bg-brand-hover disabled:opacity-50"
        >
          <SendHorizontal size={20} aria-hidden />
        </button>
      </div>
      <div className="mt-1.5 flex justify-between gap-3 text-[12px] text-muted">
        <span className="hidden sm:inline">Enter — отправить, Shift+Enter — новая строка</span>
        {text.length > MAX_REPLY - 500 && <span className="ml-auto tabular-nums">осталось {MAX_REPLY - text.length}</span>}
      </div>
    </form>
  );
}

function ReplyBlocked({ reason, tel }: { reason: string; tel?: string }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line bg-[#faf8f3] px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      <Info size={18} className="shrink-0 text-muted" aria-hidden />
      <p className="min-w-0 flex-1 text-[13.5px] text-ink-2">{reason}</p>
      {tel && (
        <a href={`tel:+${tel}`} className="inline-flex h-10 items-center gap-2 rounded-[10px] bg-ok px-4 text-[14px] font-semibold text-white hover:bg-ok-ink">
          <Phone size={16} aria-hidden /> Позвонить
        </a>
      )}
    </div>
  );
}
