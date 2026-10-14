// Экран ошибки раздела: вместо технического стека — понятное сообщение и «Обновить»; ошибка уходит в «Состояние системы».
import { useEffect } from "react";
import { useRouteError } from "react-router";
import { RotateCw } from "lucide-react";
import { reportClientError } from "../data/errorReporting";

const textOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === "string" ? e : "Ошибка раздела");

export function RouteError() {
  const error = useRouteError();
  useEffect(() => reportClientError(textOf(error), "error", "route"), [error]);
  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
      <div className="card w-full max-w-[440px] p-6 text-center">
        <h1 className="text-[22px] font-bold text-ink">Что-то пошло не так</h1>
        <p className="mt-2 text-[14.5px] text-ink-2">Раздел не открылся. Обновите страницу — если ошибка повторится, владелец увидит её в «Состоянии системы».</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" onClick={() => location.reload()} className="inline-flex h-11 items-center gap-2 rounded-[10px] bg-brand px-4 font-semibold text-on-brand hover:bg-brand-hover">
            <RotateCw size={17} aria-hidden /> Обновить
          </button>
          <a href="/" className="inline-flex h-11 items-center rounded-[10px] border border-line bg-white px-4 font-semibold text-ink-2 hover:bg-[#f4f2ec]">
            На главную
          </a>
        </div>
      </div>
    </div>
  );
}
