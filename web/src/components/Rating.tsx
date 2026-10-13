// Звёзды: показ оценки, выбор оценки и рейтинг мастера («Пока нет оценок», пока отзывов нет).
import { Star } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";
import { RATING_WORDS, ratingValue, reviewsCount } from "../data/reviews";
import type { Executor } from "../data/types";
import { cn } from "../lib/format";

const ON = "fill-[#ffb547] text-[#ffb547]";
const OFF = "fill-[#efece6] text-[#ddd7cb]";
const STARS = [1, 2, 3, 4, 5] as const;

/** Оценка звёздами — только показ. */
export function Stars({ value, size = 18, className }: { value: number; size?: number; className?: string }) {
  const full = Math.round(value);
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-0.5", className)} role="img" aria-label={`Оценка ${value} из 5`}>
      {STARS.map((i) => (
        <Star key={i} size={size} strokeWidth={1.6} className={i <= full ? ON : OFF} aria-hidden />
      ))}
    </span>
  );
}

/**
 * Выбор оценки: крупные звёзды под палец, подпись «Отлично / Плохо» под ними.
 * Клавиатура — как у группы радиокнопок: стрелки меняют оценку, Tab уходит дальше.
 * starClassName — размер звезды через CSS, если он должен подстраиваться под ширину экрана.
 */
export function StarInput({ value, onChange, size = 44, label = "Оценка", starClassName }: { value: number; onChange: (v: number) => void; size?: number; label?: string; starClassName?: string }) {
  const [hover, setHover] = useState(0);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const shown = hover || value;
  const pick = (n: number) => {
    onChange(n);
    refs.current[n - 1]?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "ArrowUp") pick(Math.min(5, value + 1));
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") pick(Math.max(1, value - 1));
    else return;
    e.preventDefault();
  };
  return (
    <div>
      <div role="radiogroup" aria-label={label} className="flex items-center justify-center gap-1 sm:gap-2" onMouseLeave={() => setHover(0)} onKeyDown={onKey}>
        {STARS.map((i) => (
          <button
            key={i}
            ref={(el) => {
              refs.current[i - 1] = el;
            }}
            type="button"
            role="radio"
            aria-checked={value === i}
            aria-label={`${i} из 5 — ${RATING_WORDS[i - 1]}`}
            tabIndex={value === i || (value === 0 && i === 1) ? 0 : -1}
            onClick={() => onChange(i)}
            onMouseEnter={() => setHover(i)}
            className="rounded-[12px] p-1 transition-transform duration-100 active:scale-90"
          >
            <Star size={size} strokeWidth={1.4} className={cn("transition-colors", i <= shown ? ON : OFF, starClassName)} aria-hidden />
          </button>
        ))}
      </div>
      <div className="mt-1.5 h-5 text-center text-[14.5px] font-semibold text-brand-ink" aria-live="polite">
        {shown ? RATING_WORDS[shown - 1] : ""}
      </div>
    </div>
  );
}

/** Рейтинг мастера: «★ 4.8 (12 отзывов)»; без отзывов — «Пока нет оценок», а не пустые 5.0. */
export function ExecutorRating({ e, count = true, size = 16, className }: { e: Pick<Executor, "rating" | "reviews">; count?: boolean; size?: number; className?: string }) {
  const value = ratingValue(e);
  if (!value) return <span className={cn("text-muted", className)}>Пока нет оценок</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Star size={size} className={ON} aria-hidden />
      <span className="font-semibold text-ink tabular-nums">{value}</span>
      {count && <span className="text-muted">({reviewsCount(e.reviews)})</span>}
    </span>
  );
}
