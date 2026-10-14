import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { setCatalog } from "./data/catalog";
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from "react-router";
import { RouteError } from "./components/RouteError";
import { ForcedPasswordChange } from "./components/PasswordChange";
import { Shell } from "./components/Shell";
import { LogoMark } from "./components/icons";
import { Button } from "./components/ui";
import { useMe } from "./data/hooks";
import { can, type Permission } from "./data/permissions";
import { useServiceWorker } from "./data/serviceWorker";
import type { Role } from "./data/types";
import Login from "./screens/Login";
import { BlockedReason } from "./screens/SubscriptionCards";
import { WorkerError } from "./screens/worker/WorkerError";

// Экраны сотрудников — отдельными чанками (Suspense — вокруг Outlet в Shell): мастеру с телефона они не грузятся.
const CatalogScreen = lazy(() => import("./screens/CatalogScreen"));
const ClientDetail = lazy(() => import("./screens/ClientDetail"));
const Calls = lazy(() => import("./screens/Calls"));
const Clients = lazy(() => import("./screens/Clients"));
const Dashboard = lazy(() => import("./screens/Dashboard"));
const executorScreens = () => import("./screens/Executors");
const Executors = lazy(executorScreens);
const ExecutorDetail = lazy(() => executorScreens().then((m) => ({ default: m.ExecutorDetail })));
const Inbox = lazy(() => import("./screens/Inbox"));
const Leads = lazy(() => import("./screens/Leads"));
const OrderDetail = lazy(() => import("./screens/OrderDetail"));
const Orders = lazy(() => import("./screens/Orders"));
const PublicRequest = lazy(() => import("./screens/PublicRequest"));
const Help = lazy(() => import("./screens/Help"));
const PrivacyPage = lazy(() => import("./screens/Legal").then((m) => ({ default: m.PrivacyPage })));
const OfferPage = lazy(() => import("./screens/Legal").then((m) => ({ default: m.OfferPage })));
const Settings = lazy(() => import("./screens/Settings"));

const TEAM_ROLES: Role[] = ["owner", "operator", "manager"];
const Analytics = lazy(() => import("./screens/Analytics"));
const AuditLog = lazy(() => import("./screens/AuditLog"));
const Payouts = lazy(() => import("./screens/Payouts"));
const PublicReview = lazy(() => import("./screens/PublicReview"));
const Register = lazy(() => import("./screens/Register"));
const Platform = lazy(() => import("./screens/Platform"));
// Печатные документы заказа (ТЗ п.19.9): страница сотрудника и ссылка клиента — отдельный чанк, без меню.
const documentPages = () => import("./screens/DocumentPage");
const StaffDocumentPage = lazy(() => documentPages().then((m) => ({ default: m.StaffDocumentPage })));
const PublicDocumentPage = lazy(() => documentPages().then((m) => ({ default: m.PublicDocumentPage })));

// Кабинет мастера — один отдельный чанк: сотрудникам он не нужен. Suspense — в WorkerShell.
const workerScreens = () => import("./screens/worker");
const WorkerFeed = lazy(() => workerScreens().then((m) => ({ default: m.Feed })));
const WorkerMyOrders = lazy(() => workerScreens().then((m) => ({ default: m.MyOrders })));
const WorkerIncome = lazy(() => workerScreens().then((m) => ({ default: m.Income })));
const WorkerProfile = lazy(() => workerScreens().then((m) => ({ default: m.Profile })));
const WorkerOrderPage = lazy(() => workerScreens().then((m) => ({ default: m.OrderPage })));

export function Splash({ children }: { children?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-page px-6 text-center">
      <div className="animate-pulse">
        <LogoMark size={44} />
      </div>
      {children}
    </div>
  );
}

function Blocked() {
  const { signOut } = useAuthActions();
  return (
    <Splash>
      <div className="text-[18px] font-semibold text-ink">Доступ отключён</div>
      <BlockedReason fallback={<p className="max-w-sm text-[14.5px] text-muted">Ваш аккаунт отключён владельцем компании или работа компании приостановлена. Если это ошибка — свяжитесь с владельцем.</p>} />
      <Button variant="secondary" onClick={() => void signOut()}>
        Выйти
      </Button>
    </Splash>
  );
}

/**
 * Доступ по ролям (RBAC) и правам (ТЗ п.5.12): исполнитель видит только свой кабинет, настройки — только владелец,
 * клиенты, звонки, сообщения, аналитика и выплаты — по правам сотрудника (src/data/permissions.ts).
 */
function Guard({ roles, perm }: { roles: Role[]; perm?: Permission }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useMe();
  const loc = useLocation();
  // Временный пароль: до его смены — только экран «Смените пароль» (сервер всё равно ничего не отдаёт).
  const forced = !!me?.mustChangePassword;
  // Справочник услуг из базы — до первого экрана, чтобы подписи и формы были актуальными.
  const catalog = useQuery(api.catalog.list, me && !forced ? {} : "skip");
  useMemo(() => catalog && setCatalog(catalog.categories, catalog.services), [catalog]);
  useServiceWorker(!!me && !forced);
  if (isLoading || (isAuthenticated && me === undefined) || (me && !forced && catalog === undefined)) return <Splash />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (!me) return <Blocked />;
  if (forced) return <ForcedPasswordChange me={me} />;
  if (!roles.includes(me.role) || (perm && !can(me, perm))) return <Navigate to={me.role === "executor" ? "/w" : "/"} replace />;
  return <Shell me={me} />;
}

/** Куда вернуть после входа: путь из ссылки (Telegram, закладка), если он из раздела этой роли. */
function afterLogin(role: Role, from: unknown): string {
  const home = role === "executor" ? "/w" : "/";
  if (typeof from !== "string" || !from.startsWith("/") || from.startsWith("//") || from.startsWith("/login")) return home;
  const executorArea = from === "/w" || from.startsWith("/w/") || from.startsWith("/w?");
  return (role === "executor") === executorArea ? from : home;
}

function LoginRoute() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useMe();
  const loc = useLocation();
  if (isLoading || (isAuthenticated && me === undefined)) return <Splash />;
  if (isAuthenticated && me) return <Navigate to={afterLogin(me.role, (loc.state as { from?: unknown } | null)?.from)} replace />;
  return <Login />;
}

const lazyAnalytics = (
  <Suspense fallback={<div className="py-20 text-center text-muted">Загружаем аналитику…</div>}>
    <Analytics />
  </Suspense>
);
const lazyAudit = (
  <Suspense fallback={<div className="py-20 text-center text-muted">Загружаем журнал…</div>}>
    <AuditLog />
  </Suspense>
);
const lazyPayouts = (
  <Suspense fallback={<div className="py-20 text-center text-muted">Загружаем выплаты…</div>}>
    <Payouts />
  </Suspense>
);
const lazyReview = (
  <Suspense fallback={<Splash />}>
    <PublicReview />
  </Suspense>
);

const router = createBrowserRouter([
  {
    // Ошибка любого раздела — понятный экран вместо стека (у кабинета мастера — свой WorkerError).
    errorElement: <RouteError />,
    children: [
  { path: "/login", element: <LoginRoute /> },
  // Публичная форма заявки для клиентов (ссылка и iframe на сайте) — без входа.
  { path: "/zayavka", element: <Suspense fallback={<Splash />}><PublicRequest /></Suspense> },
  // Инструкции и документы — без входа.
  { path: "/help", element: <Suspense fallback={<Splash />}><Help /></Suspense> },
  { path: "/privacy", element: <Suspense fallback={<Splash />}><PrivacyPage /></Suspense> },
  { path: "/offer", element: <Suspense fallback={<Splash />}><OfferPage /></Suspense> },
  // Регистрация компании (ТЗ §23.7): открыта при SAAS_SIGNUP=1, иначе — «по приглашению».
  { path: "/register", element: <Suspense fallback={<Splash />}><Register /></Suspense> },
  {
    element: <Guard roles={["owner", "operator", "manager"]} />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/leads", element: <Leads /> },
      { path: "/orders", element: <Orders /> },
      { path: "/orders/:id", element: <OrderDetail /> },
      { path: "/executors", element: <Executors /> },
      { path: "/executors/:id", element: <ExecutorDetail /> },
      // Администратор платформы (PLATFORM_ADMINS) — экран сам проверяет право и уводит остальных на «Главную».
      { path: "/platform", element: <Suspense fallback={<Splash />}><Platform /></Suspense> },
    ],
  },
  // Клиентская база, звонки, переписка, аналитика, выплаты и справочник — по правам (по умолчанию: клиенты, звонки
  // и сообщения — владельцу и операторам, аналитика и выплаты — владельцу).
  { element: <Guard roles={TEAM_ROLES} perm="calls.view" />, children: [{ path: "/calls", element: <Calls /> }] },
  { element: <Guard roles={TEAM_ROLES} perm="inbox.view" />, children: [{ path: "/inbox", element: <Inbox /> }] },
  {
    element: <Guard roles={TEAM_ROLES} perm="clients.view" />,
    children: [
      { path: "/clients", element: <Clients /> },
      { path: "/clients/:id", element: <ClientDetail /> },
    ],
  },
  // «Аналитика» — по праву: руководителю (по умолчанию есть) — его направления без денег, суммы — с правом на выплаты (convex/stats.ts).
  { element: <Guard roles={TEAM_ROLES} perm="analytics.view" />, children: [{ path: "/analytics", element: lazyAnalytics }] },
  // Реестр выплат не делится по направлениям — руководителю направления не открываем.
  { element: <Guard roles={["owner", "operator"]} perm="money.payouts" />, children: [{ path: "/payouts", element: lazyPayouts }] },
  { element: <Guard roles={TEAM_ROLES} perm="catalog.edit" />, children: [{ path: "/catalog", element: <CatalogScreen /> }] },
  {
    element: <Guard roles={["owner"]} />,
    children: [
      { path: "/audit", element: lazyAudit },
      { path: "/settings", element: <Settings /> },
    ],
  },
  {
    element: <Guard roles={["executor"]} />,
    errorElement: <WorkerError />,
    children: [
      { path: "/w", element: <WorkerFeed /> },
      { path: "/w/my", element: <WorkerMyOrders /> },
      { path: "/w/income", element: <WorkerIncome /> },
      { path: "/w/profile", element: <WorkerProfile /> },
      { path: "/w/orders/:id", element: <WorkerOrderPage /> },
    ],
  },
  // Оценка заказа клиентом по ссылке из сообщения — без входа.
  { path: "/otzyv/:token", element: lazyReview },
  { path: "/docs/:kind/:orderId", element: <Suspense fallback={<Splash />}><StaffDocumentPage /></Suspense> },
  { path: "/d/:token", element: <Suspense fallback={<Splash />}><PublicDocumentPage /></Suspense> },
  { path: "*", element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
