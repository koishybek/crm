import { useAuthActions } from "@convex-dev/auth/react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "../convex/_generated/api";
import { setCatalog } from "./data/catalog";
import { lazy, Suspense, useMemo, type ReactNode } from "react";
import { Navigate, RouterProvider, createBrowserRouter, useLocation } from "react-router";
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
import { Feed, Income, MyOrders, WorkerOrder } from "./screens/worker/Worker";

const Analytics = lazy(() => import("./screens/Analytics"));
const AuditLog = lazy(() => import("./screens/AuditLog"));

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
  // Справочник услуг из базы — до первого экрана, чтобы подписи и формы были актуальными.
  const catalog = useQuery(api.catalog.list, me ? {} : "skip");
  useMemo(() => catalog && setCatalog(catalog.categories, catalog.services), [catalog]);
  if (isLoading || (isAuthenticated && me === undefined) || (me && catalog === undefined)) return <Splash />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!me) return <Blocked />;
  if (!roles.includes(me.role)) return <Navigate to={me.role === "executor" ? "/w" : "/"} replace />;
  return <Shell me={me} />;
}

function LoginRoute() {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useMe();
  if (isLoading || (isAuthenticated && me === undefined)) return <Splash />;
  if (isAuthenticated && me) return <Navigate to={me.role === "executor" ? "/w" : "/"} replace />;
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
    children: [
      { path: "/w", element: <Feed /> },
      { path: "/w/my", element: <MyOrders /> },
      { path: "/w/income", element: <Income /> },
      { path: "/w/orders/:id", element: <WorkerOrder /> },
    ],
  },
  { path: "*", element: <Navigate to="/" replace /> },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
