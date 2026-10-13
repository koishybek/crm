import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { setCatalog } from "./data/catalog";
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from "react-router";
import { ForcedPasswordChange } from "./components/PasswordChange";
import { Shell } from "./components/Shell";
import { LogoMark } from "./components/icons";
import { Button } from "./components/ui";
import { useMe } from "./data/hooks";
import type { Role } from "./data/types";
import ClientDetail from "./screens/ClientDetail";
import Calls from "./screens/Calls";
import Clients from "./screens/Clients";
import Dashboard from "./screens/Dashboard";
import Executors, { ExecutorDetail } from "./screens/Executors";
import Inbox from "./screens/Inbox";
import Leads from "./screens/Leads";
import Login from "./screens/Login";
import OrderDetail from "./screens/OrderDetail";
import Orders from "./screens/Orders";
import PublicRequest from "./screens/PublicRequest";
import Settings from "./screens/Settings";
import { WorkerError } from "./screens/worker/WorkerError";

const Analytics = lazy(() => import("./screens/Analytics"));
const AuditLog = lazy(() => import("./screens/AuditLog"));
const PublicReview = lazy(() => import("./screens/PublicReview"));

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
      <p className="max-w-sm text-[14.5px] text-muted">Ваш аккаунт отключён владельцем компании. Если это ошибка — свяжитесь с ним.</p>
      <Button variant="secondary" onClick={() => void signOut()}>
        Выйти
      </Button>
    </Splash>
  );
}

/** Доступ по ролям (RBAC): исполнитель видит только свой кабинет, аналитика и настройки — только владельцу. */
function Guard({ roles }: { roles: Role[] }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useMe();
  const loc = useLocation();
  // Временный пароль: до его смены — только экран «Смените пароль» (сервер всё равно ничего не отдаёт).
  const forced = !!me?.mustChangePassword;
  // Справочник услуг из базы — до первого экрана, чтобы подписи и формы были актуальными.
  const catalog = useQuery(api.catalog.list, me && !forced ? {} : "skip");
  useMemo(() => catalog && setCatalog(catalog.categories, catalog.services), [catalog]);
  if (isLoading || (isAuthenticated && me === undefined) || (me && !forced && catalog === undefined)) return <Splash />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (!me) return <Blocked />;
  if (forced) return <ForcedPasswordChange me={me} />;
  if (!roles.includes(me.role)) return <Navigate to={me.role === "executor" ? "/w" : "/"} replace />;
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
const lazyReview = (
  <Suspense fallback={<Splash />}>
    <PublicReview />
  </Suspense>
);

const router = createBrowserRouter([
  { path: "/login", element: <LoginRoute /> },
  // Публичная форма заявки для клиентов (ссылка и iframe на сайте) — без входа.
  { path: "/zayavka", element: <PublicRequest /> },
  {
    element: <Guard roles={["owner", "operator", "manager"]} />,
    children: [
      { path: "/", element: <Dashboard /> },
      { path: "/leads", element: <Leads /> },
      { path: "/orders", element: <Orders /> },
      { path: "/orders/:id", element: <OrderDetail /> },
      { path: "/executors", element: <Executors /> },
      { path: "/executors/:id", element: <ExecutorDetail /> },
    ],
  },
  {
    // Клиентская база, звонки и переписка — владельцу и операторам; руководитель направления их не видит.
    element: <Guard roles={["owner", "operator"]} />,
    children: [
      { path: "/calls", element: <Calls /> },
      { path: "/inbox", element: <Inbox /> },
      { path: "/clients", element: <Clients /> },
      { path: "/clients/:id", element: <ClientDetail /> },
    ],
  },
  {
    element: <Guard roles={["owner"]} />,
    children: [
      { path: "/analytics", element: lazyAnalytics },
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
  { path: "*", element: <Navigate to="/" replace /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
