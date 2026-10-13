// Отзывы клиентов в карточке мастера (ТЗ п.14): рейтинг, сколько каких оценок и последние отзывы.
import { useQuery } from "convex/react";
import { Link } from "react-router";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { LOW_RATING, REVIEW_VIA, reviewsCount } from "../data/reviews";
import type { Executor } from "../data/types";
import { cn, date } from "../lib/format";
import { Stars } from "./Rating";
import { Card, Loading } from "./ui";

const FIRST = 5;

export function ExecutorReviews({ e, className }: { e: Pick<Executor, "id" | "rating" | "reviews">; className?: string }) {
  const info = useQuery(api.reviews.forExecutor, { executorId: e.id as Id<"executors"> });
  const [all, setAll] = useState(false);
  if (info === null) return null;
  const top = Math.max(1, ...(info?.byStars ?? []));
  const shown = info ? (all ? info.latest : info.latest.slice(0, FIRST)) : [];

  return (
    <Card title="Отзывы клиентов" titleExtra={info?.total ? <span className="text-[14px] font-normal text-muted">{reviewsCount(info.total)}</span> : undefined} className={className}>
      {info === undefined ? (
        <Loading className="py-8" />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[250px_1fr]">
          <div>
            {e.reviews > 0 ? (
              <div className="flex items-end gap-3">
                <span className="text-[40px] leading-none font-bold tracking-[-0.03em] text-ink tabular-nums">{e.rating.toFixed(1)}</span>
                <span className="pb-1">
                  <Stars value={e.rating} size={18} />
                  <span className="block text-[13px] text-muted">{reviewsCount(e.reviews)}</span>
                </span>
              </div>
            ) : (
              <div className="text-[18px] font-semibold text-ink">Пока нет оценок</div>
            )}
            {info.total > 0 && (
              <ul className="mt-4 flex flex-col gap-1.5" aria-label="Сколько каких оценок">
                {[5, 4, 3, 2, 1].map((s) => {
                  const n = info.byStars[s - 1] ?? 0;
                  return (
                    <li key={s} className="flex items-center gap-2 text-[13px]">
                      <span className="w-7 shrink-0 text-muted tabular-nums">{s}★</span>
                      <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#f1efe9]">
                        <span className={cn("block h-full rounded-full", s <= LOW_RATING ? "bg-[#ff9aa8]" : "bg-[#ffb547]")} style={{ width: `${(n / top) * 100}%` }} />
                      </span>
                      <span className="w-7 shrink-0 text-right text-muted tabular-nums">{n}</span>
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="mt-3 text-[12px] text-muted">Рейтинг — среднее с поправкой на число отзывов: одна-две оценки его не раскачивают.</p>
          </div>

          {info.latest.length === 0 ? (
            <p className="self-center text-[14px] text-muted">Отзывы появятся, когда клиенты оценят выполненные заказы — по ссылке, в мессенджере или со слов клиента.</p>
          ) : (
            <div className="min-w-0">
              <ol className="divide-y divide-line">
                {shown.map((r) => (
                  <li key={r.id} className="py-3 first:pt-0">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <Stars value={r.rating} size={15} />
                      {r.orderNumber !== undefined && (
                        <Link to={`/orders/${r.orderId}`} className="text-[13.5px] font-semibold text-brand-ink hover:text-brand-deep">
                          Заказ №{r.orderNumber}
                        </Link>
                      )}
                      <span className="ml-auto text-[12.5px] text-muted">
                        {REVIEW_VIA[r.via]} · {date(r.at)}
                      </span>
                    </div>
                    {r.text && <p className="mt-1 text-[14px] whitespace-pre-line text-ink-2 [overflow-wrap:anywhere]">{r.text}</p>}
                  </li>
                ))}
              </ol>
              {!all && info.latest.length > FIRST && (
                <button type="button" onClick={() => setAll(true)} className="mt-1 text-[13.5px] font-semibold text-brand-ink hover:underline">
                  Показать ещё ({info.latest.length - FIRST})
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
