// Экран ошибки кабинета мастера (errorElement маршрутов /w/*): понятный текст, «Обновить» и звонок в офис.
import { useAuthActions } from "@convex-dev/auth/react";
import { ConvexError } from "convex/values";
import { Headset, RotateCw, TriangleAlert } from "lucide-react";
import { Navigate, useLocation, useNavigate, useRouteError } from "react-router";
import { SUPPORT_TEL } from "../../data/workerLinks";
import { LogoMark } from "../../components/icons";
import { MUTED, WButton, WLinkButton } from "../../components/worker/kit";

const messageOf = (e: unknown): string => (e instanceof ConvexError && typeof e.data === "string" ? e.data : "");

export function WorkerError() {
  const error = useRouteError();
  const loc = useLocation();
  const nav = useNavigate();
  const { signOut } = useAuthActions();
  const msg = messageOf(error);
  if (msg === "Нужно войти") return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!msg) console.error("Кабинет мастера: ошибка экрана", error instanceof Error ? error.message : error);

  const noProfile = /профиль .*не найден/i.test(msg);
  const title = noProfile ? "Профиль мастера не найден" : msg === "Нет доступа" ? "Нет доступа к кабинету мастера" : "Что-то пошло не так";
  const text = noProfile || msg === "Нет доступа" ? "Позвоните в офис — вам помогут." : "Попробуйте обновить страницу. Если не поможет — позвоните в офис.";

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-page px-6 text-center">
      <LogoMark size={40} />
      <span className="mt-6 inline-flex h-14 w-14 items-center justify-center rounded-[16px] bg-bad-bg text-[#c41d3a]">
        <TriangleAlert size={28} aria-hidden />
      </span>
      <h1 className="mt-4 text-[20px] font-bold text-ink">{title}</h1>
      <p className={`mt-1 max-w-sm text-[15.5px] ${MUTED}`}>{text}</p>
      <div className="mt-6 flex w-full max-w-xs flex-col gap-2">
        {!noProfile && (
          <WButton size="lg" icon={RotateCw} full onClick={() => window.location.reload()}>
            Обновить
          </WButton>
        )}
        <WLinkButton href={SUPPORT_TEL} icon={Headset} full>
          Позвонить в офис
        </WLinkButton>
        {(noProfile || msg === "Нет доступа") && (
          <WButton
            variant="ghost"
            full
            onClick={async () => {
              await signOut();
              nav("/login", { replace: true });
            }}
          >
            Выйти
          </WButton>
        )}
      </div>
    </div>
  );
}
