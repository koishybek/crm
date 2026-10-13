// Шторка снизу экрана (на компьютере — окно по центру) для подтверждений мастера.
// Главная кнопка — внизу, ближе к большому пальцу; фокус внутри шторки; Esc и тап по фону закрывают,
// пока не идёт отправка. Возвращает фокус на кнопку, с которой шторку открыли.
import { X } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconBtn } from "./kit";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Кнопки внизу: сверху вторичная, ниже главная (во всю ширину). */
  footer?: ReactNode;
  /** Идёт отправка — не закрываем по фону и Esc. */
  locked?: boolean;
}

export function Sheet({ open, onClose, title, children, footer, locked }: SheetProps) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const lockedRef = useRef(locked);
  useLayoutEffect(() => {
    close.current = onClose;
    lockedRef.current = locked;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Фокус — на саму шторку: диктор читает заголовок, Tab ведёт к полям. Фокус на первой кнопке
    // рисовал бы рамку, похожую на уже сделанный выбор (мастер работает пальцем, не клавиатурой).
    panel.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !lockedRef.current) {
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (document.activeElement === panel.current) {
        e.preventDefault();
        (e.shiftKey ? lastEl : firstEl).focus();
      } else if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-end justify-center sm:items-center sm:p-6">
      <div className="anim-fade absolute inset-0 bg-[#141414]/45" onClick={() => !locked && onClose()} aria-hidden />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="anim-pop relative flex max-h-[92dvh] w-full max-w-[480px] flex-col rounded-t-[20px] bg-white shadow-[var(--shadow-pop)] outline-none sm:rounded-[20px]"
      >
        <span className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong sm:hidden" aria-hidden />
        <header className="flex items-start justify-between gap-2 pt-2 pr-2 pl-5">
          <h2 id={titleId} className="pt-3 text-[19px] leading-snug font-bold text-ink">
            {title}
          </h2>
          <IconBtn icon={X} label="Закрыть" onClick={onClose} disabled={locked} className="-mb-1 disabled:opacity-40" />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1 pb-4">
          {children}
        </div>
        {footer && <footer className="flex flex-col gap-2 border-t border-line px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}
