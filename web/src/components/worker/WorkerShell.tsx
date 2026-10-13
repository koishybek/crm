// Каркас кабинета мастера: на телефоне — шапка с приёмом заказов и четыре вкладки внизу,
// на компьютере — тёмный сайдбар с теми же разделами. Экран заказа на телефоне рисует свою шапку
// («назад» + номер) и панель действий вместо вкладок.
import { useQuery } from "convex/react";
import { CircleUserRound, ClipboardList, Search, Wallet, type LucideIcon } from "lucide-react";
import { Suspense, useEffect, useMemo, type ReactNode } from "react";
import { Link, NavLink, Outlet, useMatch } from "react-router";
import { api } from "../../../convex/_generated/api";
import { useNow } from "../../data/hooks";
import type { User } from "../../data/types";
import { countUnseen } from "../../data/workerFeed";
import { listenForInstall } from "../../data/workerInstall";
import { useWorkerPrefs } from "../../data/workerPrefs";
import { needsAction } from "../../data/workerStatus";
import { cn } from "../../lib/format";
import { Logo, LogoMark } from "../icons";
import { Avatar } from "../ui";
import { AvailabilityPill } from "./Availability";
import { WorkerBell } from "./Bell";
import { ListSkeleton } from "./kit";
import { NetWatcher, OfflineBanner } from "./net";
import { WorkerToasts } from "./Toasts";

// Предложение установки (beforeinstallprompt) браузер присылает сразу после загрузки — раньше, чем
// подгрузятся экраны мастера. Каркас входит в основной бандл, поэтому начинаем слушать здесь.
listenForInstall();

type BadgeKey = "feed" | "my" | "profile";

interface Tab {
  to: string;
  label: string;
  icon: LucideIcon;
  end?: boolean;
  badge?: BadgeKey;
}

/** Разделы кабинета мастера — одни и те же внизу экрана и в сайдбаре. */
const TABS: Tab[] = [
  { to: "/w", label: "Заказы", icon: Search, end: true, badge: "feed" },
  { to: "/w/my", label: "Мои заказы", icon: ClipboardList, badge: "my" },
  { to: "/w/income", label: "Доход", icon: Wallet },
  { to: "/w/profile", label: "Профиль", icon: CircleUserRound, badge: "profile" },
];

interface Badges {
  feed: number;
  my: number;
  profile: boolean;
}

/** Счётчики вкладок: новые заказы ленты, заказы, которые ждут действия, неподключённый Telegram. */
function useBadges(): { badges: Badges; available: boolean | undefined } {
  const now = useNow(60_000);
  const mine = useQuery(api.worker.mine);
  const extras = useQuery(api.executorApp.feedExtras);
  const tg = useQuery(api.telegram.status);
  const seenAt = useWorkerPrefs((s) => s.feedSeenAt);
  const available = mine?.executor.available;
  const orders = mine?.orders;
  // С выключенным приёмом заказы взять нельзя — не зовём в ленту счётчиком.
  const feed = useMemo(() => (extras && available ? countUnseen(extras, seenAt, now) : 0), [extras, available, seenAt, now]);
  const my = useMemo(() => (orders ? needsAction(orders, now) : 0), [orders, now]);
  const profile = !!tg?.enabled && !tg.linked;
  const badges = useMemo(() => ({ feed, my, profile }), [feed, my, profile]);
  return { available, badges };
}

function badgeLabel(tab: Tab, b: Badges): string {
  if (tab.badge === "feed" && b.feed) return `${tab.label}, новых: ${b.feed}`;
  if (tab.badge === "my" && b.my) return `${tab.label}, ждут действия: ${b.my}`;
  if (tab.badge === "profile" && b.profile) return `${tab.label}, подключите Telegram`;
  return tab.label;
}

const count = (n: number) => (n > 9 ? "9+" : String(n));

function TabBadge({ tab, b, onDark }: { tab: Tab; b: Badges; onDark?: boolean }) {
  if (tab.badge === "feed" && b.feed) return <span className="absolute -top-1.5 -right-2.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand px-1 text-[11px] font-bold text-ink">{count(b.feed)}</span>;
  if (tab.badge === "my" && b.my) return <span className="absolute -top-1.5 -right-2.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#c41d3a] px-1 text-[11px] font-bold text-white">{count(b.my)}</span>;
  if (tab.badge === "profile" && b.profile) return <span className={cn("absolute -top-0.5 -right-1 h-2.5 w-2.5 rounded-full bg-[#c41d3a]", onDark ? "ring-2 ring-side" : "ring-2 ring-white")} />;
  return null;
}

/** Нижние вкладки (телефон). Без размытия фона — на средних Android оно тормозит прокрутку. */
function TabBar({ badges }: { badges: Badges }) {
  return (
    <nav aria-label="Разделы" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t border-line bg-white pb-[env(safe-area-inset-bottom)] lg:hidden">
      {TABS.map((t) => (
        <NavLink key={t.to} to={t.to} end={t.end} aria-label={badgeLabel(t, badges)} className="flex h-16 flex-col items-center justify-center gap-1">
          {({ isActive }) => (
            <>
              <span className={cn("relative inline-flex h-8 w-14 items-center justify-center rounded-full transition-colors", isActive && "bg-brand-soft")}>
                <t.icon size={24} strokeWidth={isActive ? 2.2 : 1.8} className={isActive ? "text-ink" : "text-[#6b675f]"} aria-hidden />
                <TabBadge tab={t} b={badges} />
              </span>
              <span className={cn("text-[12px] leading-none font-semibold", isActive ? "text-ink" : "text-[#6b675f]")} aria-hidden>
                {t.label}
              </span>
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

/** Сайдбар (компьютер): те же разделы и счётчики. */
function SideBar({ me, badges }: { me: User; badges: Badges }) {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col bg-side px-3 pt-6 pb-4 lg:flex">
      <div className="mb-8 px-3">
        <Logo onDark />
      </div>
      <nav aria-label="Разделы" className="flex flex-col gap-1.5">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            aria-label={badgeLabel(t, badges)}
            className={({ isActive }) =>
              cn("flex h-[52px] items-center gap-3.5 rounded-[12px] px-4 text-[16px] font-medium transition-colors", isActive ? "bg-[#3a3120] text-brand" : "text-[#dedbd3] hover:bg-white/[0.06] hover:text-white")
            }
          >
            {({ isActive }) => (
              <>
                <span className="relative inline-flex">
                  <t.icon size={23} strokeWidth={isActive ? 2.1 : 1.7} className={isActive ? "text-brand" : "text-[#a9a59c]"} aria-hidden />
                  <TabBadge tab={t} b={badges} onDark />
                </span>
                <span aria-hidden>{t.label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <Link to="/w/profile" className="mt-auto flex items-center gap-3 rounded-[12px] px-2 py-2 hover:bg-white/[0.06]">
        <Avatar name={me.name} size={40} variant="person" />
        <span className="min-w-0 leading-tight">
          <span className="block truncate text-[14px] font-semibold text-white">{me.name}</span>
          <span className="text-[12.5px] text-[#c9c4b8]">Кабинет мастера</span>
        </span>
      </Link>
    </aside>
  );
}

export function WorkerShell({ me, children }: { me: User; children?: ReactNode }) {
  const orderRoute = useMatch("/w/orders/:id") !== null;
  const { badges, available } = useBadges();
  const countVisit = useWorkerPrefs((s) => s.countVisit);
  // Открытия кабинета: подсказку об установке на телефон показываем не с первого захода.
  useEffect(() => countVisit(), [countVisit]);

  return (
    <div className="min-h-dvh bg-page">
      <NetWatcher />
      <SideBar me={me} badges={badges} />
      <div className="lg:pl-[248px]">
        {/* На телефоне у экрана заказа своя шапка; на компьютере шапка общая. */}
        <div className={cn("sticky top-0 z-30", orderRoute && "max-lg:hidden")}>
          <header className="border-b border-line bg-white">
            <div className="mx-auto flex h-14 items-center gap-2 px-2 lg:h-16 lg:px-8">
              <Link to="/w" aria-label="Заказы" className="inline-flex h-12 w-12 shrink-0 items-center justify-center lg:hidden">
                <LogoMark size={30} />
              </Link>
              {available !== undefined && <AvailabilityPill available={available} />}
              <div className="flex-1" />
              <WorkerBell />
              <Link to="/w/profile" aria-label="Профиль" className="hidden h-12 w-12 items-center justify-center rounded-full hover:bg-[#f4f2ec] lg:inline-flex">
                <Avatar name={me.name} size={38} variant="person" />
              </Link>
            </div>
          </header>
          <OfflineBanner />
        </div>
        <main
          className={cn(
            "lg:px-8 lg:pt-6 lg:pb-12",
            orderRoute ? "pb-[calc(120px+env(safe-area-inset-bottom))]" : "px-4 pt-4 pb-[calc(96px+env(safe-area-inset-bottom))]",
          )}
        >
          <Suspense fallback={<ListSkeleton />}>{children ?? <Outlet />}</Suspense>
        </main>
      </div>
      {!orderRoute && <TabBar badges={badges} />}
      <WorkerToasts raised={orderRoute} />
    </div>
  );
}
