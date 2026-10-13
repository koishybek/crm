// Общие кусочки экранов мастера: срок, бейджи статуса и выплаты, превью, звёзды рейтинга, строка завершённого заказа.
import { CircleCheck, Clock, ImageOff, Pause, Star, StarHalf } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { serviceById } from "../../data/catalog";
import type { WorkerOrder } from "../../data/types";
import { payoutChip, statusView, type Step } from "../../data/workerStatus";
import { dateAlmaty, dueLabel, isDueSoon, isPast, relLabel } from "../../data/workerTime";
import { cn, money } from "../../lib/format";
import { ServiceTile } from "../icons";
import { MUTED, WBadge } from "./kit";

/**
 * Срок: «Сегодня, до 14:00 · через 2 ч». Меньше 3 часов — янтарный, прошёл — красный и словами.
 * settled — заказ завершён или отменён: только дата, без «через…» и без цвета тревоги.
 */
export function DueText({ deadline, now, mode = "mine", className, bare, settled }: { deadline: string; now: number; mode?: "mine" | "feed"; className?: string; bare?: boolean; settled?: boolean }) {
  const past = !settled && isPast(deadline, now);
  const soon = !settled && isDueSoon(deadline, now);
  return (
    <span className={cn("inline-flex min-w-0 items-start gap-2", past ? "font-semibold text-[#c41d3a]" : soon ? "font-semibold text-[#9a5b00]" : "text-ink-2", className)}>
      {!bare && <Clock size={18} className="mt-[2px] shrink-0" aria-hidden />}
      <span className="min-w-0">{settled ? dueLabel(deadline, now) : `${dueLabel(deadline, now)} · ${relLabel(deadline, now, mode)}`}</span>
    </span>
  );
}

export function StatusBadge({ order, now }: { order: Pick<WorkerOrder, "status" | "payoutPaid" | "payout" | "deadline">; now: number }) {
  const v = statusView(order, now);
  return <WBadge tone={v.tone}>{v.label}</WBadge>;
}

export function PayoutChipBadge({ order }: { order: Pick<WorkerOrder, "status" | "payoutPaid"> }) {
  const chip = payoutChip(order);
  return chip ? <WBadge tone={chip.tone}>{chip.label}</WBadge> : null;
}

/** Фото заказа или плитка с иконкой услуги; не загрузилось — тоже плитка. */
export function OrderThumb({ serviceId, url, size = 72 }: { serviceId: string; url?: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!url || broken) return <ServiceTile serviceId={serviceId} size={size} />;
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      className="shrink-0 rounded-[12px] bg-[#efece5] object-cover"
      style={{ width: size, height: size }}
    />
  );
}

/** Картинка во весь блок, с запасным видом «Фото не загрузилось». */
export function Photo({ url, alt, className }: { url: string; alt: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken)
    return (
      <span className={cn("flex flex-col items-center justify-center gap-1.5 bg-[#efece5] text-[14px]", MUTED, className)}>
        <ImageOff size={24} aria-hidden />
        Фото не загрузилось
      </span>
    );
  return <img src={url} alt={alt} loading="lazy" decoding="async" onError={() => setBroken(true)} className={cn("bg-[#efece5] object-cover", className)} />;
}

/** Звёзды рейтинга (дублируют число рядом, поэтому скрыты от экранного диктора). */
export function Stars({ rating, size = 20 }: { rating: number; size?: number }) {
  const halves = Math.round(Math.min(5, Math.max(0, rating)) * 2);
  return (
    <span className="inline-flex items-center gap-0.5" aria-hidden>
      {Array.from({ length: 5 }, (_, i) => {
        const left = halves - i * 2;
        if (left >= 2) return <Star key={i} size={size} className="fill-[#ffc629] text-[#b07200]" />;
        if (left === 1)
          return (
            <span key={i} className="relative inline-flex">
              <Star size={size} className="text-[#b07200]" />
              <StarHalf size={size} className="absolute inset-0 fill-[#ffc629] text-[#b07200]" />
            </span>
          );
        return <Star key={i} size={size} className="text-[#b07200]" />;
      })}
    </span>
  );
}

/**
 * Шаги заказа «Принят → В работе → Сдан → Выплачено» с текущим шагом. Галочка у пройденного шага — только
 * если шаг шире 88 px: на экранах 320–360 px иначе «Выплачено» обрезалось бы; пройденность видна и по полосе.
 */
export function StatusStepper({ steps }: { steps: Step[] }) {
  return (
    <ol aria-label="Этапы заказа" className="grid grid-cols-4 gap-1">
      {steps.map((s, i) => (
        <li key={i} aria-current={s.state === "current" ? "step" : undefined} className="@container min-w-0">
          <span className={cn("block h-1.5 rounded-full transition-[background-color] duration-300", s.state === "done" ? "bg-ink" : s.state === "current" ? "bg-brand" : "bg-line-strong")} aria-hidden />
          <span
            className={cn(
              "mt-1.5 flex items-center gap-1 text-[12.5px] leading-tight",
              s.state === "done" ? "text-ink-2" : s.state === "current" ? "font-semibold text-ink" : "text-[#6b675f]",
            )}
          >
            {s.state === "done" && <CircleCheck size={14} className="hidden shrink-0 text-[#067a46] @min-[88px]:block" aria-hidden />}
            {s.state === "current" && s.label === "Пауза" && <Pause size={13} className="shrink-0" aria-hidden />}
            <span className="min-w-0 truncate">{s.label}</span>
            {s.state === "done" && <span className="sr-only"> — пройден</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Строка завершённого заказа: услуга, дата и состояние выплаты; справа сумма. У отмен и возвратов сумма зачёркнута. */
export function DoneRow({ order, now }: { order: WorkerOrder; now: number }) {
  const voided = order.status === "cancelled" || order.status === "refund";
  return (
    <Link to={`/w/orders/${order.id}`} className="flex min-h-16 items-start gap-3 border-t border-line px-1 py-3 first:border-t-0 active:bg-[#faf8f3]">
      <span className="min-w-0 flex-1">
        <span className="line-clamp-2 text-[15px] leading-snug text-ink">{serviceById(order.serviceId).label}</span>
        <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={cn("text-[13.5px]", MUTED)}>{dateAlmaty(order.doneAt ?? order.assignedAt ?? order.createdAt, now)}</span>
          <PayoutChipBadge order={order} />
        </span>
      </span>
      <span className={cn("shrink-0 text-[16px] font-semibold tabular-nums", voided ? "text-[#6b675f] line-through" : "text-ink")}>{money(order.payout)}</span>
    </Link>
  );
}
