// Тосты кабинета мастера: над нижней панелью (вкладки или кнопки заказа), а не поверх неё.
// На телефоне виден один — новый заменяет старый. Ошибки озвучиваются сразу (role="alert").
import { CircleCheck, CircleX, Info, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useToasts } from "../../data/store";
import { cn } from "../../lib/format";

export function WorkerToasts({ raised }: { raised: boolean }) {
  const { items, drop } = useToasts();
  const latest = items.at(-1);
  return createPortal(
    <div
      className={cn(
        "pointer-events-none fixed inset-x-0 z-[60] flex flex-col items-center gap-2 px-4 lg:right-6 lg:bottom-6 lg:left-auto lg:items-end",
        raised ? "bottom-[calc(96px+env(safe-area-inset-bottom))]" : "bottom-[calc(76px+env(safe-area-inset-bottom))]",
      )}
    >
      {items.map((t) => {
        const Icon = t.tone === "ok" ? CircleCheck : t.tone === "bad" ? CircleX : Info;
        return (
          <div
            key={t.id}
            role={t.tone === "bad" ? "alert" : "status"}
            className={cn(
              "anim-toast pointer-events-auto w-full max-w-[420px] items-start gap-3 rounded-[14px] bg-ink py-3 pr-1 pl-4 text-[15px] text-white shadow-[var(--shadow-pop)]",
              t === latest ? "flex" : "hidden lg:flex",
            )}
          >
            <Icon size={20} className={cn("mt-0.5 shrink-0", t.tone === "ok" ? "text-[#4ade9b]" : t.tone === "bad" ? "text-[#ff8197]" : "text-[#8ec0ff]")} aria-hidden />
            <span className="min-w-0 flex-1 py-0.5">{t.text}</span>
            <button onClick={() => drop(t.id)} aria-label="Закрыть уведомление" className="-my-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-white/70 hover:text-white">
              <X size={18} aria-hidden />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
