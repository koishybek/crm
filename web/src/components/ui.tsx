import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleX,
  Info,
  SlidersHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import type { Tone } from "../data/catalog";
import { useToasts } from "../data/store";
import { cn, initials } from "../lib/format";
import { TONE_SOFT } from "./icons";

// ── Кнопки ───────────────────────────────────────────────────────────────────
type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "danger" | "success";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  iconRight?: LucideIcon;
  full?: boolean;
}

const BTN: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand border-brand hover:bg-brand-hover hover:border-brand-hover shadow-[0_8px_18px_-8px_rgba(242,169,0,0.75)]",
  secondary: "bg-white text-ink border-line-strong hover:bg-hover",
  soft: "bg-[#f4f2ec] text-[#344d76] border-transparent hover:bg-[#ece9e2]",
  ghost: "bg-transparent text-ink-2 border-transparent hover:bg-[#f4f2ec]",
  danger: "bg-white text-bad-ink border-[#ffc9d3] hover:bg-bad-bg",
  success: "bg-ok text-white border-ok hover:bg-ok-ink",
};

export function Button({ variant = "primary", size = "md", icon: Icon, iconRight: IconRight, full, className, children, ...rest }: ButtonProps) {
  const h = size === "sm" ? "h-9 px-3.5 text-[13.5px] gap-2 rounded-[9px]" : size === "lg" ? "h-[52px] px-6 text-[16px] gap-2.5 rounded-[12px]" : "h-11 px-[18px] text-[14.5px] gap-2.5 rounded-[10px]";
  return (
    <button
      type="button"
      {...rest}
      className={cn(
        "inline-flex shrink-0 items-center justify-center border font-semibold whitespace-nowrap transition-colors disabled:opacity-50 disabled:shadow-none",
        h,
        BTN[variant],
        full && "w-full",
        className,
      )}
    >
      {Icon && <Icon size={size === "sm" ? 16 : 18} strokeWidth={2} aria-hidden />}
      {children}
      {IconRight && <IconRight size={size === "sm" ? 16 : 18} strokeWidth={2} aria-hidden />}
    </button>
  );
}

export function IconButton({ icon: Icon, label, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[9px] text-muted transition-colors hover:bg-[#f4f2ec] hover:text-ink", className)}
    >
      <Icon size={18} strokeWidth={1.9} aria-hidden />
    </button>
  );
}

export function TextLink({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cn("inline-flex shrink-0 items-center gap-1.5 text-[14px] font-medium whitespace-nowrap text-brand-ink hover:text-brand-deep", className)}>
      {children}
      <ArrowRight size={16} aria-hidden />
    </Link>
  );
}

// ── Бейджи ───────────────────────────────────────────────────────────────────
export function Badge({ tone = "blue", children, className, size = "md", title }: { tone?: Tone; children: ReactNode; className?: string; size?: "sm" | "md"; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center justify-center rounded-[8px] font-semibold whitespace-nowrap",
        size === "sm" ? "px-2 py-[3px] text-[11.5px]" : "px-2.5 py-[5px] text-[12.5px]",
        TONE_SOFT[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

const DOT: Record<Tone, string> = {
  blue: "bg-blue",
  yellow: "bg-brand",
  sky: "bg-sky",
  violet: "bg-violet",
  amber: "bg-warn",
  green: "bg-ok",
  red: "bg-bad",
  orange: "bg-orange",
  gray: "bg-faint",
};

/** Пилюля с точкой — статус рядом с заголовком и у исполнителей. */
export function DotBadge({ tone, children, size = "md" }: { tone: Tone; children: ReactNode; size?: "md" | "lg" }) {
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-[10px] font-semibold whitespace-nowrap", size === "lg" ? "px-4 py-2 text-[15px]" : "px-3 py-1.5 text-[13px]", TONE_SOFT[tone])}>
      <span className={cn("rounded-full", size === "lg" ? "h-2.5 w-2.5" : "h-2 w-2", DOT[tone])} />
      {children}
    </span>
  );
}

// ── Аватар ───────────────────────────────────────────────────────────────────
const AVATAR_TONES = [
  "bg-[#e3eefc] text-[#2f6fd8]",
  "bg-[#ece7ff] text-[#6a4ae0]",
  "bg-[#dff5ea] text-[#0f8a55]",
  "bg-[#fff0e0] text-[#c96a10]",
  "bg-[#e1f2fb] text-[#1d82b8]",
  "bg-[#fde8ef] text-[#c8325a]",
];
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export function Avatar({ name, size = 40, variant = "client", status, className }: { name: string; size?: number; variant?: "client" | "person"; status?: Tone; className?: string }) {
  const tone = variant === "client" ? AVATAR_TONES[0] : AVATAR_TONES[hash(name) % AVATAR_TONES.length];
  return (
    <span className={cn("relative inline-flex shrink-0", className)} style={{ width: size, height: size }}>
      <span
        className={cn("inline-flex h-full w-full items-center justify-center rounded-full font-semibold tracking-[-0.01em]", tone)}
        style={{ fontSize: Math.max(11, Math.round(size * 0.36)) }}
        aria-hidden
      >
        {initials(name)}
      </span>
      {status && <span className={cn("absolute right-0 bottom-0 rounded-full border-2 border-white", DOT[status])} style={{ width: Math.max(10, size * 0.26), height: Math.max(10, size * 0.26) }} />}
    </span>
  );
}

// ── Карточки ─────────────────────────────────────────────────────────────────
export function Card({ title, action, children, className, bodyClass, titleExtra, icon: Icon }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string; bodyClass?: string; titleExtra?: ReactNode; icon?: LucideIcon }) {
  return (
    <section className={cn("card min-w-0", className)}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pt-[18px] pb-3">
          {/* Узкий экран: значок рядом с заголовком и кнопка действия переносятся строкой ниже, а не уходят за край. */}
          <h2 className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[18px] font-semibold tracking-[-0.01em] text-ink">
            {Icon && (
              <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[#fff0c4] text-[#3a2c00]">
                <Icon size={19} strokeWidth={1.9} aria-hidden />
              </span>
            )}
            {title}
            {titleExtra}
          </h2>
          {action}
        </header>
      )}
      <div className={cn(title || action ? "px-5 pb-5" : "p-5", bodyClass)}>{children}</div>
    </section>
  );
}

/** Ошибка формы: при появлении сама прокручивается в зону видимости — в длинной форме внизу её иначе не видно. */
export function FormError({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Тело в скобках: свежий Chrome возвращает из scrollIntoView обещание, а эффект должен вернуть функцию или ничего.
    ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [children]);
  return (
    <div ref={ref} role="alert" className="rounded-[10px] bg-bad-bg px-3.5 py-2.5 text-[13.5px] font-medium text-bad-ink">
      {children}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {back}
        <h1 className="text-[26px] leading-tight font-bold tracking-[-0.025em] text-ink sm:text-[32px]">{title}</h1>
        {subtitle && <p className="mt-1 text-[15px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2.5">{actions}</div>}
    </div>
  );
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="mb-2 inline-flex items-center gap-2 text-[14.5px] text-muted hover:text-ink">
      <ChevronLeft size={18} aria-hidden className="-ml-1" />
      {children}
    </Link>
  );
}

export interface Trend {
  value: string;
  up: boolean;
  good: boolean;
  caption: string;
}
export function TrendLine({ trend }: { trend: Trend }) {
  const Arrow = trend.up ? ArrowUpRight : ArrowDownRight;
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13.5px]">
      <Arrow size={17} strokeWidth={2.2} className={trend.good ? "text-ok" : "text-bad"} aria-hidden />
      <span className={cn("font-semibold", trend.good ? "text-ok" : "text-bad")}>{trend.value}</span>
      <span className="text-muted">{trend.caption}</span>
    </div>
  );
}

/** Подложка и декоративные столбики KPI-карточки — как на макете. */
const KPI_TINT: Partial<Record<Tone, { bg: string; bar: string }>> = {
  yellow: { bg: "bg-[linear-gradient(135deg,#fff6df_0%,#ffffff_75%)]", bar: "bg-[#ffd24d]" },
  amber: { bg: "bg-[linear-gradient(135deg,#fffaf0_0%,#ffffff_75%)]", bar: "bg-[#ffd24d]" },
  green: { bg: "bg-white", bar: "bg-[#5fd497]" },
  red: { bg: "bg-[linear-gradient(135deg,#fff1f1_0%,#fffafa_75%)]", bar: "bg-[#ff9aa8]" },
};

/** deco — декоративные столбики справа сверху (на «Главной», где суммы короткие). */
export function KpiCard({ icon: Icon, tone, label, value, trend, caption, onClick, deco }: { icon: LucideIcon; tone: Tone; label: string; value: ReactNode; trend?: Trend; caption?: ReactNode; onClick?: () => void; deco?: boolean }) {
  const Tag = onClick ? "button" : "div";
  const tint = KPI_TINT[tone];
  return (
    <Tag onClick={onClick} className={cn("card @container/kpi relative block min-w-0 overflow-hidden text-left", tint?.bg, onClick && "transition-shadow hover:shadow-[0_8px_28px_rgba(60,45,10,0.1)]")}>
      {deco && tint && (
        <span className="pointer-events-none absolute top-6 right-5 hidden items-end gap-[5px] @min-[370px]/kpi:flex" aria-hidden>
          {[34, 52, 70, 92].map((h, i) => (
            <span key={i} className={cn("w-[8px] rounded-t-[3px]", tint.bar)} style={{ height: h * 0.5, opacity: 0.3 + i * 0.18 }} />
          ))}
        </span>
      )}
      {/* Раскладка — от ширины самой карточки: широкая — иконка слева; средняя (три в ряд на 1024px) — иконка сверху;
          узкая (2–3 в ряд на телефоне) — компактно, а совсем узкая — без пояснения: показатели видны без долгой прокрутки. */}
      <div className="flex flex-col items-start gap-2.5 p-3.5 @min-[180px]/kpi:gap-3 @min-[180px]/kpi:p-5 @min-[280px]/kpi:flex-row @min-[280px]/kpi:gap-4">
        <span className={cn("inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] @min-[180px]/kpi:h-11 @min-[180px]/kpi:w-11 @min-[180px]/kpi:rounded-[13px] @min-[280px]/kpi:h-[58px] @min-[280px]/kpi:w-[58px] @min-[280px]/kpi:rounded-[16px]", TONE_SOFT[tone])}>
          <Icon className="size-[19px] @min-[180px]/kpi:size-[22px] @min-[280px]/kpi:size-[27px]" strokeWidth={1.7} aria-hidden />
        </span>
        <div className="@container w-full min-w-0 flex-1">
          <div className="min-h-[2lh] text-[13px] leading-snug text-ink-2 @min-[180px]/kpi:min-h-0 @min-[180px]/kpi:text-[14.5px]">{label}</div>
          {/* Размер — от ширины колонки: в узкой карточке сумма «3 351 000 ₸» остаётся в одну строку. */}
          <div className="mt-0.5 text-[clamp(18px,14cqw,30px)] leading-tight font-bold tracking-[-0.02em] whitespace-nowrap text-ink tabular-nums">{value}</div>
          <div className="hidden @min-[150px]/kpi:block">{trend ? <TrendLine trend={trend} /> : caption ? <div className="mt-1.5 text-[13.5px] text-muted">{caption}</div> : null}</div>
        </div>
      </div>
    </Tag>
  );
}

export function IconTile({ icon: Icon, tone, size = 44 }: { icon: LucideIcon; tone: Tone; size?: number }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-[12px]", TONE_SOFT[tone])} style={{ width: size, height: size }}>
      <Icon size={Math.round(size * 0.48)} strokeWidth={1.8} aria-hidden />
    </span>
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <IconTile icon={Icon} tone="yellow" size={56} />
      <div className="mt-4 text-[16px] font-semibold text-ink">{title}</div>
      {text && <p className="mt-1 max-w-sm text-[14px] text-muted">{text}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Загрузка данных с сервера. */
export function Loading({ text = "Загружаем…", className }: { text?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-3 py-16 text-[14.5px] text-muted", className)} role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-line-strong border-t-brand" />
      {text}
    </div>
  );
}

// ── Поля ─────────────────────────────────────────────────────────────────────
export function Label({ children, required, htmlFor }: { children: ReactNode; required?: boolean; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-2 block text-[14px] font-semibold text-ink">
      {children}
      {required && <span className="ml-0.5 text-bad">*</span>}
    </label>
  );
}

export function FormRow({ label, required, children, hint }: { label: string; required?: boolean; children: (id: string) => ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="min-w-0">
      <Label required={required} htmlFor={id}>
        {label}
      </Label>
      {children(id)}
      {hint && <div className="mt-1.5 text-[12.5px] text-muted">{hint}</div>}
    </div>
  );
}

export function Input({ icon: Icon, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { icon?: LucideIcon }) {
  return (
    <div className={cn("relative", className)}>
      {Icon && <Icon size={18} strokeWidth={1.8} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-faint" aria-hidden />}
      <input {...rest} className={cn("field", Icon && "pl-10")} />
    </div>
  );
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("field", props.className)} />;
}

export function Select({ icon: Icon, className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { icon?: LucideIcon }) {
  return (
    <div className={cn("relative min-w-0", className)}>
      {Icon && <Icon size={18} strokeWidth={1.8} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted" aria-hidden />}
      <select {...rest} className={cn("field appearance-none truncate pr-10", Icon && "pl-10", rest.value === "" && "text-muted")}>
        {children}
      </select>
      <ChevronDown size={18} className="pointer-events-none absolute top-1/2 right-3.5 -translate-y-1/2 text-ink-2" aria-hidden />
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string; icon?: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex h-[50px] items-center justify-center gap-2 rounded-[10px] border text-[14.5px] font-medium transition-colors",
            o.value === value ? "border-brand bg-brand-soft/60 text-ink" : "border-line-strong bg-white text-ink-2 hover:border-brand-line",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ items, value, onChange }: { items: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="scroll-x scroll-thin -mx-1 flex gap-1 border-b border-line px-1" role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={t.id === value}
          onClick={() => onChange(t.id)}
          className={cn(
            "relative inline-flex shrink-0 items-center gap-2 px-3 pt-1 pb-3 text-[15px] font-medium transition-colors",
            t.id === value ? "text-ink" : "text-muted hover:text-ink",
          )}
        >
          {t.label}
          {t.count !== undefined && (
            <span className={cn("rounded-[7px] px-1.5 py-0.5 text-[12px] font-semibold", t.id === value ? "bg-brand-soft text-brand-ink" : "bg-slate-bg text-muted")}>{t.count}</span>
          )}
          {t.id === value && <span className="absolute inset-x-2 -bottom-px h-[2.5px] rounded-full bg-brand" />}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2.5 text-[14px] font-medium text-ink-2">
      <span className={cn("relative h-6 w-11 rounded-full transition-colors", checked ? "bg-ok" : "bg-line-strong")}>
        <span className={cn("absolute top-0.5 left-0 h-5 w-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-[22px]" : "translate-x-0.5")} />
      </span>
      {label}
    </button>
  );
}

// ── Пагинация ────────────────────────────────────────────────────────────────
export function Pagination({ page, total, perPage, onChange, noun = "записей" }: { page: number; total: number; perPage: number; onChange: (p: number) => void; noun?: string }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (total === 0) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(total, page * perPage);
  const nums = pages <= 7 ? [...Array(pages)].map((_, i) => i + 1) : [1, ...[page - 1, page, page + 1].filter((p) => p > 1 && p < pages), pages];
  const uniq = [...new Set(nums)];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
      <div className="text-[13.5px] text-muted">
        Показано {from}–{to} из {total} {noun}
      </div>
      {/* На телефоне кнопки страниц переносятся, а не уходят за край экрана. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1 sm:gap-1.5">
        <button className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] border border-line text-ink-2 disabled:opacity-40" disabled={page === 1} onClick={() => onChange(page - 1)} aria-label="Назад">
          <ChevronLeft size={17} />
        </button>
        {uniq.map((p, i) => (
          <span key={p} className="flex items-center gap-1 sm:gap-1.5">
            {i > 0 && p - uniq[i - 1]! > 1 && <span className="px-0.5 text-muted">…</span>}
            <button
              onClick={() => onChange(p)}
              className={cn("inline-flex h-9 min-w-8 items-center justify-center rounded-[9px] px-1.5 text-[14px] font-semibold sm:min-w-9 sm:px-2", p === page ? "bg-brand text-on-brand" : "text-ink-2 hover:bg-[#f4f2ec]")}
            >
              {p}
            </button>
          </span>
        ))}
        <button className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] border border-line text-ink-2 disabled:opacity-40" disabled={page === pages} onClick={() => onChange(page + 1)} aria-label="Вперёд">
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}

// ── Оверлеи ──────────────────────────────────────────────────────────────────
function useEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);
}

export function Drawer({ open, onClose, title, children, footer, width = 460 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      <div className="anim-fade absolute inset-0 bg-[#141414]/35" onClick={onClose} />
      <aside role="dialog" aria-modal="true" className="anim-drawer absolute top-0 right-0 flex h-full w-full flex-col bg-white shadow-[var(--shadow-pop)]" style={{ maxWidth: width }}>
        <header className="flex items-center justify-between gap-3 px-6 pt-6 pb-4">
          <h2 className="text-[24px] font-bold tracking-[-0.02em] text-ink">{title}</h2>
          <IconButton icon={X} label="Закрыть" onClick={onClose} className="h-10 w-10" />
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-6">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-6 py-4">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

export function Modal({ open, onClose, title, children, footer, width = 520 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6">
      <div className="anim-fade absolute inset-0 bg-[#141414]/35" onClick={onClose} />
      <div role="dialog" aria-modal="true" className="anim-pop relative flex max-h-[92vh] w-full flex-col rounded-t-[20px] bg-white shadow-[var(--shadow-pop)] sm:rounded-[18px]" style={{ maxWidth: width }}>
        <header className="flex items-center justify-between gap-3 px-6 pt-5 pb-3">
          <h2 className="text-[20px] font-bold tracking-[-0.015em] text-ink">{title}</h2>
          <IconButton icon={X} label="Закрыть" onClick={onClose} />
        </header>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-6 pb-5">{children}</div>
        {footer && <footer className="flex flex-wrap items-center justify-end gap-2.5 border-t border-line px-6 py-4">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Выпадающее меню. trigger получает toggle; закрывается по клику снаружи. */
export function Menu({ trigger, children, align = "right", width = 260 }: { trigger: (toggle: () => void, open: boolean) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", h);
    window.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      window.removeEventListener("keydown", k);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(() => setOpen((v) => !v), open)}
      {open && (
        <div className={cn("anim-pop absolute top-[calc(100%+8px)] z-40 rounded-[14px] border border-line bg-white p-1.5 shadow-[var(--shadow-pop)]", align === "right" ? "right-0" : "left-0")} style={{ width }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon: Icon, children, onClick, danger, disabled, hint }: { icon?: LucideIcon; children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-[9px] px-3 py-2.5 text-left text-[14px] font-medium transition-colors disabled:opacity-45",
        danger ? "text-bad-ink hover:bg-bad-bg" : "text-ink-2 hover:bg-[#f7f4ec]",
      )}
    >
      {Icon && <Icon size={17} strokeWidth={1.9} aria-hidden className={danger ? "" : "text-muted"} />}
      <span className="min-w-0 flex-1">
        {children}
        {hint && <span className="block text-[12px] font-normal text-muted">{hint}</span>}
      </span>
    </button>
  );
}

// ── Тосты ────────────────────────────────────────────────────────────────────
export function Toaster() {
  const { items, drop } = useToasts();
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 lg:right-6 lg:bottom-6 lg:left-auto lg:items-end">
      {items.map((t) => {
        const Icon = t.tone === "ok" ? CircleCheck : t.tone === "bad" ? CircleX : Info;
        return (
          <div key={t.id} role="status" className="anim-toast pointer-events-auto flex max-w-[420px] items-start gap-3 rounded-[14px] bg-ink px-4 py-3 text-[14px] text-white shadow-[var(--shadow-pop)]">
            <Icon size={19} className={cn("mt-px shrink-0", t.tone === "ok" ? "text-[#4ade9b]" : t.tone === "bad" ? "text-[#ff8197]" : "text-[#8ec0ff]")} aria-hidden />
            <span className="min-w-0 flex-1">{t.text}</span>
            <button onClick={() => drop(t.id)} aria-label="Закрыть" className="text-white/60 hover:text-white">
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/**
 * Фильтры списка, свёрнутые на телефоне за кнопкой «Фильтры» (несколько списков подряд занимали весь экран до данных).
 * Кладётся внутрь сетки фильтров: с sm — display: contents, поля становятся ячейками той же сетки, кнопки нет.
 */
export function MobileFilters({ active, children }: { active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-11 w-full items-center gap-2 rounded-[11px] border border-line bg-white px-3.5 text-[14.5px] font-medium text-ink-2 sm:hidden"
      >
        <SlidersHorizontal size={17} className="text-muted" aria-hidden />
        Фильтры
        {active && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[12px] font-semibold text-brand-ink">включены</span>}
        <ChevronDown size={17} className={cn("ml-auto text-muted transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      <div className={cn(open ? "grid gap-3" : "hidden", "sm:contents")}>{children}</div>
    </>
  );
}
