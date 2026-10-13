// Мелкие детали кабинета мастера: кнопки с большими целями нажатия (от 48 px), бейджи с контрастом
// не ниже 4,5:1 (цвета текста темнее общих токенов — мастер смотрит в телефон на улице), спиннер, скелетоны.
import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { WTone } from "../../data/workerStatus";
import { cn } from "../../lib/format";

/** Текст и фон бейджей. */
export const TONE: Record<WTone, string> = {
  warn: "bg-warn-bg text-[#9a5b00]",
  sky: "bg-sky-bg text-[#1767c2]",
  ok: "bg-ok-bg text-[#067a46]",
  orange: "bg-orange-bg text-[#a34a07]",
  slate: "bg-slate-bg text-[#6b675f]",
  bad: "bg-bad-bg text-[#c41d3a]",
  brand: "bg-[#ffeaa6] text-[#3a2c00]",
};

/** Вторичный текст: темнее общего muted, читается и на фоне страницы. */
export const MUTED = "text-[#6b675f]";

export function WBadge({ tone, icon: Icon, children, className }: { tone: WTone; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-[8px] px-2 py-[3px] text-[12.5px] font-semibold whitespace-nowrap", TONE[tone], className)}>
      {Icon && <Icon size={13} strokeWidth={2.2} aria-hidden />}
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={cn("inline-block h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none", className)} aria-hidden />;
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "dark";

const VARIANT: Record<Variant, string> = {
  primary: "border-brand bg-brand text-on-brand hover:bg-brand-hover",
  secondary: "border-[#cfc9bc] bg-white text-ink hover:bg-hover",
  ghost: "border-transparent bg-transparent text-ink-2 hover:bg-[#f4f2ec]",
  danger: "border-[#c41d3a] bg-[#c41d3a] text-white hover:bg-[#a9182f]",
  dark: "border-ink bg-ink text-white hover:bg-[#2b2b2b]",
};

/** Вид «нельзя нажать»: серый, но читаемый (без прозрачности — на солнце бледный текст пропадает). */
const DISABLED_LOOK = "border-[#e0dbd0] bg-[#efece5] text-[#6b675f] hover:bg-[#efece5]";

interface WButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  variant?: Variant;
  /** md — 48 px, lg — 56 px (главное действие внизу экрана). */
  size?: "md" | "lg";
  icon?: LucideIcon;
  full?: boolean;
  /** Идёт запрос: спиннер и текст busyText, кнопка не нажимается. */
  busy?: boolean;
  busyText?: string;
  /**
   * Выглядит неактивной, но нажимается — чтобы объяснить, почему действие сейчас недоступно
   * (aria-disabled, а не disabled: такая кнопка остаётся в фокусе и озвучивается).
   */
  softDisabled?: boolean;
  children: ReactNode;
}

export function WButton({ variant = "primary", size = "md", icon: Icon, full, busy, busyText, softDisabled, disabled, className, children, ...rest }: WButtonProps) {
  const off = disabled || softDisabled;
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || busy}
      aria-disabled={softDisabled || undefined}
      aria-busy={busy || undefined}
      className={cn(
        "inline-flex min-w-0 items-center justify-center gap-2 rounded-[12px] border px-4 text-center font-semibold leading-tight text-balance transition-[transform,background-color] active:scale-[0.98] motion-reduce:active:scale-100 disabled:cursor-not-allowed",
        size === "lg" ? "min-h-14 py-2 text-[16px]" : "min-h-12 py-1.5 text-[15px]",
        off ? DISABLED_LOOK : VARIANT[variant],
        full && "w-full",
        className,
      )}
    >
      {busy ? <Spinner /> : Icon && <Icon size={size === "lg" ? 20 : 18} strokeWidth={2} aria-hidden className="shrink-0" />}
      <span className="min-w-0">{busy ? (busyText ?? children) : children}</span>
    </button>
  );
}

/** Ссылка в виде кнопки — для tel: и карт (работают и без связи с сервером). */
export function WLinkButton({ variant = "secondary", icon: Icon, full, className, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; icon?: LucideIcon; full?: boolean }) {
  return (
    <a
      {...rest}
      className={cn(
        "inline-flex min-h-12 min-w-0 items-center justify-center gap-2 rounded-[12px] border px-4 py-1.5 text-center text-[15px] font-semibold leading-tight transition-[transform,background-color] active:scale-[0.98] motion-reduce:active:scale-100",
        VARIANT[variant],
        full && "w-full",
        className,
      )}
    >
      {Icon && <Icon size={18} strokeWidth={2} aria-hidden className="shrink-0" />}
      <span className="min-w-0">{children}</span>
    </a>
  );
}

/** Квадратная кнопка-иконка 48×48 с обязательной подписью для экранного диктора. */
export function IconBtn({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn("inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-[#f4f2ec] active:bg-[#ece9e2]", className)}
    >
      <Icon size={22} strokeWidth={1.9} aria-hidden />
    </button>
  );
}

/** Чип-фильтр: видимая «пилюля» 40 px внутри цели нажатия 48 px. */
export function Chip({ pressed, icon: Icon, count, onClick, children }: { pressed: boolean; icon?: LucideIcon; count?: number; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={onClick} className="inline-flex h-12 shrink-0 items-center">
      <span
        className={cn(
          "inline-flex h-10 items-center gap-1.5 rounded-full border px-4 text-[15px] font-medium whitespace-nowrap transition-colors",
          pressed ? "border-ink bg-ink text-white" : "border-[#cfc9bc] bg-white text-ink active:bg-[#f4f2ec]",
        )}
      >
        {Icon && <Icon size={16} aria-hidden />}
        {children}
        {!!count && <span className="tabular-nums">· {count}</span>}
      </span>
    </button>
  );
}

/** Белая карточка-секция с заголовком. */
export function Section({ title, action, children, className }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("card p-4", className)}>
      {(title || action) && (
        <header className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-[17px] font-semibold text-ink">{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/** Заголовок экрана-вкладки. */
export function ScreenTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[26px] leading-tight font-bold tracking-[-0.02em] text-ink lg:text-[30px]">{title}</h1>
        {subtitle && <p className={cn("mt-0.5 truncate text-[15px]", MUTED)}>{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/** Пустой экран: крупная иконка, короткий текст, одно действие. */
export function Empty({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-5 py-10 text-center">
      <span className="inline-flex h-14 w-14 items-center justify-center rounded-[16px] bg-[#ffeaa6] text-[#3a2c00]">
        <Icon size={27} strokeWidth={1.8} aria-hidden />
      </span>
      <h2 className="mt-4 text-[17px] font-semibold text-ink">{title}</h2>
      {text && <p className={cn("mt-1 max-w-sm text-[15px]", MUTED)}>{text}</p>}
      {action && <div className="mt-5 flex w-full max-w-xs flex-col gap-2">{action}</div>}
    </div>
  );
}

/** Серые блоки на время загрузки — без спиннера на весь экран. */
export function Skeleton({ className }: { className?: string }) {
  return <span className={cn("block rounded-[8px] bg-[#efece5] motion-safe:animate-pulse", className)} aria-hidden />;
}

export function CardSkeleton() {
  return (
    <div className="card p-4" aria-hidden>
      <div className="flex gap-3">
        <Skeleton className="h-[72px] w-[72px] rounded-[12px]" />
        <div className="flex-1 space-y-2.5">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-5 w-4/5" />
        </div>
      </div>
      <Skeleton className="mt-4 h-4 w-3/5" />
      <Skeleton className="mt-2.5 h-4 w-2/5" />
      <Skeleton className="mt-4 h-14 w-full rounded-[12px]" />
    </div>
  );
}

export function ListSkeleton({ count = 3 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Загружаем">
      {Array.from({ length: count }, (_, i) => (
        <CardSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Состояние запроса для кнопки: busy — идёт, slow — идёт дольше 3 секунд (тогда пишем «Ждём связь…»:
 * Convex сам повторит мутацию, когда связь вернётся).
 */
export function useBusy(): { busy: boolean; slow: boolean; run: <T>(fn: () => Promise<T>) => Promise<T> } {
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!busy) return;
    const t = setTimeout(() => setSlow(true), 3000);
    return () => clearTimeout(t);
  }, [busy]);
  const run = async <T,>(fn: () => Promise<T>): Promise<T> => {
    setBusy(true);
    setSlow(false);
    try {
      return await fn();
    } finally {
      if (alive.current) {
        setBusy(false);
        setSlow(false);
      }
    }
  };
  return { busy, slow, run };
}

/** Текст на кнопке во время запроса. */
export const busyLabel = (slow: boolean, text: string) => (slow ? "Ждём связь…" : text);
