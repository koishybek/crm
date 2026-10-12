import {
  Bell,
  Box,
  Briefcase,
  Building2,
  ChartNoAxesColumn,
  ChevronDown,
  ClipboardList,
  FileText,
  House,
  LogOut,
  Menu as MenuIcon,
  MessagesSquare,
  PhoneCall,
  Plus,
  Search,
  Send,
  Settings as SettingsIcon,
  UserRound,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { APP_NAME, ROLE_LABEL } from "../data/catalog";
import { useNow, useUi } from "../data/hooks";
import { useInboxUnread } from "../data/inbox";
import { markAllRead, report, telegramLink, telegramUnlink, toast } from "../data/store";
import type { User } from "../data/types";
import { cn, whenShort } from "../lib/format";
import { Avatar, Badge, Button, IconButton, Menu, MenuItem, Toaster } from "./ui";
import { Logo } from "./icons";
import { ClientDrawer, ExecutorDrawer, LeadDrawer } from "../screens/drawers";
import { IncomingCalls } from "./IncomingCalls";

type NavItem = { to: string; label: string; icon: LucideIcon; end?: boolean };

const STAFF_NAV: NavItem[] = [
  { to: "/", label: "Главная", icon: House, end: true },
  { to: "/leads", label: "Заявки", icon: FileText },
  { to: "/calls", label: "Звонки", icon: PhoneCall },
  { to: "/inbox", label: "Сообщения", icon: MessagesSquare },
  { to: "/orders", label: "Заказы", icon: Briefcase },
  { to: "/clients", label: "Клиенты", icon: Users },
  { to: "/executors", label: "Исполнители", icon: UserRound },
  { to: "/analytics", label: "Аналитика", icon: ChartNoAxesColumn },
  { to: "/settings", label: "Настройки", icon: SettingsIcon },
];
const EXEC_NAV: NavItem[] = [
  { to: "/w", label: "Доступные заказы", icon: Box, end: true },
  { to: "/w/my", label: "Мои заказы", icon: ClipboardList },
  { to: "/w/income", label: "Доход", icon: Wallet },
];

const navFor = (u: User) =>
  u.role === "executor"
    ? EXEC_NAV
    : u.role === "owner"
      ? STAFF_NAV
      : STAFF_NAV.filter((n) => n.to !== "/analytics" && n.to !== "/settings" && (u.role !== "manager" || (n.to !== "/clients" && n.to !== "/calls" && n.to !== "/inbox")));

/** badges — счётчики у пунктов меню (непрочитанные «Сообщения»). */
function SideNav({ items, onNavigate, badges }: { items: NavItem[]; onNavigate?: () => void; badges?: Record<string, number> }) {
  return (
    <nav className="flex flex-col gap-1.5" aria-label="Разделы">
      {items.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            cn(
              "relative flex h-[52px] items-center gap-3.5 rounded-[12px] px-4 text-[16px] font-medium transition-colors",
              isActive
                ? "bg-[#3a3120] text-brand before:absolute before:top-2.5 before:bottom-2.5 before:-left-3 before:w-[3px] before:rounded-r-full before:bg-brand"
                : "text-[#dedbd3] hover:bg-white/[0.06] hover:text-white",
            )
          }
        >
          {({ isActive }) => (
            <>
              <n.icon size={23} strokeWidth={isActive ? 2.1 : 1.7} className={isActive ? "fill-brand/25 text-brand" : "text-[#a9a59c]"} aria-hidden />
              {n.label}
              {!!badges?.[n.to] && (
                <span className="ml-auto inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-brand px-1.5 text-[12px] font-bold text-on-brand" aria-label={`непрочитанных: ${badges[n.to]}`}>
                  {badges[n.to]! > 99 ? "99+" : badges[n.to]}
                </span>
              )}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function CompanyCard() {
  return (
    <div className="flex items-center gap-3 rounded-[12px] px-2 py-2">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-side-2 text-brand">
        <Building2 size={20} strokeWidth={1.7} aria-hidden />
      </span>
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[13.5px] font-semibold text-white">{APP_NAME}</div>
        <div className="text-[12.5px] text-[#a9a59c]">Алматы</div>
      </div>
    </div>
  );
}

// ── Поиск ────────────────────────────────────────────────────────────────────
function GlobalSearch({ executor, autoFocus, onDone }: { executor: boolean; autoFocus?: boolean; onDone?: () => void }) {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [focus, setFocus] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    if (autoFocus) return;
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [autoFocus]);

  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery(api.search.global, !executor && dq.length >= 2 ? { q: dq } : "skip") ?? [];

  const go = (to: string) => {
    nav(to);
    setQ("");
    setFocus(false);
    inputRef.current?.blur();
    onDone?.();
  };

  return (
    <div className="relative w-full max-w-[460px]">
      <Search size={19} strokeWidth={1.9} className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setCursor(0);
        }}
        onFocus={() => setFocus(true)}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (executor && e.key === "Enter") return go(`/w?q=${encodeURIComponent(q.trim())}`);
          if (e.key === "ArrowDown") setCursor((c) => Math.min(results.length - 1, c + 1));
          if (e.key === "ArrowUp") setCursor((c) => Math.max(0, c - 1));
          if (e.key === "Enter" && results[cursor]) go(results[cursor].to);
          if (e.key === "Escape") inputRef.current?.blur();
        }}
        placeholder={executor ? "Поиск по услугам или городу..." : "Поиск по клиентам, заявкам, заказам..."}
        aria-label="Поиск"
        className="h-[46px] w-full rounded-[11px] border border-transparent bg-field pr-16 pl-12 text-[15px] text-ink placeholder:text-muted focus:border-brand-line focus:bg-white focus:outline-none"
      />
      {!focus && (
        <kbd className="pointer-events-none absolute top-1/2 right-3 hidden -translate-y-1/2 rounded-[6px] border border-line-strong bg-white px-1.5 py-0.5 font-sans text-[11.5px] font-medium text-muted lg:block">
          {isMac ? "⌘" : "Ctrl"} K
        </kbd>
      )}
      {focus && q.trim().length >= 2 && !executor && (
        <div className="anim-pop absolute top-[calc(100%+8px)] right-0 left-0 z-40 overflow-hidden rounded-[14px] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]">
          {results.length === 0 ? (
            <div className="px-3 py-4 text-[14px] text-muted">{dq !== q.trim() ? "Ищем…" : `Ничего не нашли по «${q.trim()}». Ищем по имени, телефону и номеру`}</div>
          ) : (
            results.map((r, i) => (
              <div key={r.key}>
                {(i === 0 || results[i - 1]!.group !== r.group) && <div className="px-3 pt-2 pb-1 text-[11.5px] font-semibold tracking-wide text-faint uppercase">{r.group}</div>}
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => go(r.to)}
                  onMouseEnter={() => setCursor(i)}
                  className={cn("block w-full rounded-[9px] px-3 py-2 text-left", i === cursor ? "bg-[#f7f4ec]" : "")}
                >
                  <div className="truncate text-[14px] font-semibold text-ink">{r.title}</div>
                  <div className="truncate text-[12.5px] text-muted">{r.sub}</div>
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ── Уведомления ──────────────────────────────────────────────────────────────
function Bell_() {
  const now = useNow(60_000);
  const nav = useNavigate();
  const data = useQuery(api.notifications.mine, { now: Math.floor(now / 60_000) * 60_000 });
  const mine = data?.items ?? [];
  const alerts = data?.alerts ?? [];
  const unread = mine.filter((n) => !n.read).length + alerts.length;
  const DOT = { info: "bg-blue", ok: "bg-ok", warn: "bg-warn", bad: "bg-bad" };

  return (
    <Menu
      width={360}
      trigger={(toggle) => (
        <button onClick={toggle} aria-label={`Уведомления${unread ? `: ${unread} новых` : ""}`} className="relative inline-flex h-11 w-11 items-center justify-center rounded-full text-ink-2 hover:bg-[#f4f2ec]">
          <Bell size={23} strokeWidth={1.7} />
          {unread > 0 && <span className="absolute top-2 right-2.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-bad" />}
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="flex items-center justify-between px-3 pt-2 pb-2">
            <div className="text-[15px] font-semibold text-ink">Уведомления</div>
            {mine.some((n) => !n.read) && (
              <button className="text-[13px] font-medium text-brand-ink" onClick={() => void markAllRead()}>
                Прочитать все
              </button>
            )}
          </div>
          <div className="scroll-thin max-h-[380px] overflow-y-auto">
            {alerts.map((a) => (
              <button key={a.id} onClick={() => (close(), nav(a.link))} className="flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-[#f7f4ec]">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", DOT[a.tone])} />
                <span className="text-[13.5px] font-semibold text-ink">{a.text}</span>
              </button>
            ))}
            {mine.slice(0, 12).map((n) => (
              <button key={n.id} onClick={() => (close(), n.link && nav(n.link))} className="flex w-full items-start gap-3 rounded-[10px] px-3 py-2.5 text-left hover:bg-[#f7f4ec]">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", n.read ? "bg-line-strong" : DOT[n.tone])} />
                <span className="min-w-0 flex-1">
                  <span className={cn("block text-[13.5px]", n.read ? "text-ink-2" : "font-semibold text-ink")}>{n.text}</span>
                  <span className="text-[12px] text-muted">{whenShort(n.at, new Date(now))}</span>
                </span>
              </button>
            ))}
            {!alerts.length && !mine.length && <div className="px-3 py-6 text-center text-[13.5px] text-muted">Пока тихо</div>}
          </div>
        </div>
      )}
    </Menu>
  );
}

function UserMenu({ me }: { me: User }) {
  const { signOut } = useAuthActions();
  const nav = useNavigate();
  const tg = useQuery(api.telegram.status);
  return (
    <Menu
      width={290}
      trigger={(toggle) => (
        <button onClick={toggle} aria-label="Меню пользователя" className="flex items-center gap-2.5 rounded-full py-1 pr-2 pl-1 hover:bg-[#f4f2ec]">
          <Avatar name={me.name} size={42} variant="person" />
          <span className="hidden text-[15px] font-semibold text-ink sm:inline">{me.name.split(" ")[0]}</span>
          <ChevronDown size={18} className="hidden text-ink-2 sm:inline" />
        </button>
      )}
    >
      {(close) => (
        <div>
          <div className="px-3 pt-2 pb-3">
            <div className="text-[15px] font-semibold text-ink">{me.name}</div>
            <div className="mt-0.5 truncate text-[12.5px] text-muted">{me.email}</div>
            <div className="mt-1.5">
              <Badge tone={me.role === "owner" ? "violet" : me.role === "operator" ? "blue" : me.role === "manager" ? "orange" : "green"} size="sm">
                {ROLE_LABEL[me.role]}
              </Badge>
            </div>
          </div>
          <div className="border-t border-line pt-1.5">
            {tg?.linked ? (
              <MenuItem
                icon={Send}
                hint="Уведомления приходят в Telegram"
                onClick={async () => {
                  close();
                  report(await telegramUnlink(), "Telegram отключён");
                }}
              >
                Отключить Telegram
              </MenuItem>
            ) : (
              <MenuItem
                icon={Send}
                disabled={!tg?.enabled}
                hint={tg?.enabled ? "Новые заказы и сообщения — в Telegram" : "Бот ещё не настроен владельцем"}
                onClick={async () => {
                  close();
                  const r = await telegramLink();
                  if (report(r)) {
                    window.open(r.value, "_blank", "noopener");
                    toast("Нажмите «Старт» в открывшемся Telegram", "info");
                  }
                }}
              >
                Подключить Telegram
              </MenuItem>
            )}
            {me.role === "owner" && (
              <MenuItem icon={SettingsIcon} onClick={() => (close(), nav("/settings"))}>
                Настройки и команда
              </MenuItem>
            )}
            <MenuItem
              icon={LogOut}
              onClick={async () => {
                close();
                await signOut();
                nav("/login");
              }}
            >
              Выйти
            </MenuItem>
          </div>
        </div>
      )}
    </Menu>
  );
}

function PrimaryAction({ me }: { me: User }) {
  const { pathname } = useLocation();
  const ui = useUi();
  if (me.role === "executor") return null;
  if (pathname.startsWith("/clients"))
    return (
      <Button icon={Plus} onClick={() => ui.openClient()}>
        Новый клиент
      </Button>
    );
  if (pathname.startsWith("/orders"))
    return (
      <Button icon={Plus} onClick={() => ui.openLead({ mode: "order" })}>
        Новый заказ
      </Button>
    );
  return (
    <Button icon={Plus} onClick={() => ui.openLead()}>
      Новая заявка
    </Button>
  );
}

export function Shell({ me, children }: { me: User; children?: ReactNode }) {
  const items = navFor(me);
  const ui = useUi();
  const unread = useInboxUnread(me);
  const badges = { "/inbox": unread };
  const [mobileSearch, setMobileSearch] = useState(false);
  const isExec = me.role === "executor";

  return (
    <div className="min-h-dvh bg-page">
      {/* Сайдбар */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-side px-3 pt-6 pb-4 lg:flex">
        <div className="mb-8 px-3">
          <Logo onDark />
        </div>
        <SideNav items={items} badges={badges} />
        <div className="mt-auto">
          <CompanyCard />
        </div>
      </aside>

      {/* Мобильная навигация */}
      {ui.nav && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="anim-fade absolute inset-0 bg-[#141414]/35" onClick={() => ui.setNav(false)} />
          <aside className="anim-drawer absolute inset-y-0 left-0 flex w-[280px] flex-col bg-side px-3 pt-5 pb-4 shadow-[var(--shadow-pop)]">
            <div className="mb-6 flex items-center justify-between px-3">
              <Logo onDark />
              <IconButton icon={X} label="Закрыть меню" onClick={() => ui.setNav(false)} className="text-[#a9a59c] hover:bg-white/10 hover:text-white" />
            </div>
            <SideNav items={items} badges={badges} onNavigate={() => ui.setNav(false)} />
            <div className="mt-auto">
              <CompanyCard />
            </div>
          </aside>
        </div>
      )}

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-line/60 bg-white/95 backdrop-blur">
          <div className="flex h-[68px] items-center gap-1 px-4 sm:gap-3 sm:px-6 lg:h-[76px] lg:px-8">
            {!isExec && (
              <span className="relative lg:hidden">
                <IconButton icon={MenuIcon} label={unread ? `Меню: непрочитанных сообщений ${unread}` : "Меню"} onClick={() => ui.setNav(true)} className="h-10 w-10" />
                {unread > 0 && <span className="pointer-events-none absolute top-1.5 right-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand" />}
              </span>
            )}
            <div className="lg:hidden">
              <Logo />
            </div>
            <div className="hidden min-w-0 flex-1 md:block">
              <GlobalSearch executor={isExec} />
            </div>
            <div className="flex-1 md:hidden" />
            <IconButton icon={Search} label="Поиск" onClick={() => setMobileSearch((v) => !v)} className="h-10 w-10 md:hidden" />
            <div className="hidden md:block">
              <PrimaryAction me={me} />
            </div>
            <Bell_ />
            <UserMenu me={me} />
          </div>
          {mobileSearch && (
            <div className="border-t border-line px-4 py-3 md:hidden">
              <GlobalSearch executor={isExec} autoFocus onDone={() => setMobileSearch(false)} />
            </div>
          )}
        </header>

        <main className={cn("mx-auto w-full max-w-[1480px] px-4 pt-6 sm:px-6 lg:px-8 lg:pt-7", isExec ? "pb-28 lg:pb-10" : "pb-24 lg:pb-10")}>{children ?? <Outlet />}</main>
      </div>

      {/* Быстрое действие на телефоне */}
      {!isExec && (
        <button
          onClick={() => ui.openLead()}
          aria-label="Новая заявка"
          className="fixed right-5 bottom-5 z-30 inline-flex h-14 w-14 items-center justify-center rounded-full bg-brand text-on-brand shadow-[0_12px_28px_-8px_rgba(242,169,0,0.8)] md:hidden"
        >
          <Plus size={26} />
        </button>
      )}

      {/* Нижняя навигация исполнителя */}
      {isExec && (
        <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-line bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden" aria-label="Разделы">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => cn("flex flex-col items-center gap-1 py-2.5 text-[11.5px] font-medium", isActive ? "text-brand-ink" : "text-muted")}>
              <n.icon size={22} strokeWidth={1.8} aria-hidden />
              {n.label}
            </NavLink>
          ))}
        </nav>
      )}

      {/* Звонки от АТС видят те, кто их принимает: владелец и операторы. */}
      {(me.role === "owner" || me.role === "operator") && <IncomingCalls />}
      <LeadDrawer />
      <ClientDrawer />
      <ExecutorDrawer />
      <Toaster />
    </div>
  );
}

