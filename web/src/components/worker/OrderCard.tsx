// Карточка заказа в ленте: сначала деньги («Вам 21 000 ₸»), потом что сделать, когда и где.
// Вся верхняя часть — ссылка на заказ, кнопка «Взять заказ» — отдельно (без вложенных интерактивных элементов).
import { Ban, Flame, Lock, MapPin, TriangleAlert } from "lucide-react";
import { memo } from "react";
import { Link } from "react-router";
import { serviceById } from "../../data/catalog";
import { isFresh, type FeedItem } from "../../data/workerFeed";
import { isPast } from "../../data/workerTime";
import { cn, money } from "../../lib/format";
import { ServiceGlyph } from "../icons";
import { MUTED, WBadge, WButton } from "./kit";
import { DueText, OrderThumb } from "./parts";

/** Можно ли сейчас взять: да; приём выключен (кнопка серая, но объясняет); нет связи. */
export type TakeMode = "ready" | "off_shift" | "offline";

interface OrderCardProps {
  item: FeedItem;
  now: number;
  mode: TakeMode;
  highlighted?: boolean;
  onTake: (item: FeedItem) => void;
}

export const OrderCard = memo(function OrderCard({ item, now, mode, highlighted, onTake }: OrderCardProps) {
  const s = serviceById(item.serviceId);
  const late = isPast(item.deadline, now);
  return (
    <article id={`order-${item.id}`} className={cn("card overflow-hidden transition-shadow lg:flex", highlighted && "ring-2 ring-brand")}>
      <Link to={`/w/orders/${item.id}`} className="block min-w-0 flex-1 p-4 pb-3 active:bg-[#faf8f3] lg:pb-4">
        <div className="flex gap-3">
          <OrderThumb serviceId={item.serviceId} url={item.thumbUrl} />
          <div className="min-w-0 flex-1">
            <div className="text-[24px] leading-tight font-bold text-ink tabular-nums">
              <span className="text-[17px]">Вам </span>
              {money(item.payout)}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {item.priority === "urgent" && (
                <WBadge tone="bad" icon={Flame}>
                  Срочно
                </WBadge>
              )}
              {item.priority === "high" && <WBadge tone="warn">Важно</WBadge>}
              {isFresh(item.publishedAt, now) && <WBadge tone="brand">Новый</WBadge>}
              {late && (
                <WBadge tone="bad" icon={TriangleAlert}>
                  Срок прошёл
                </WBadge>
              )}
            </div>
          </div>
        </div>
        <h3 className="mt-2.5 flex items-start gap-2 text-[16.5px] leading-[22px] font-semibold text-ink">
          {item.thumbUrl && <ServiceGlyph serviceId={item.serviceId} size={20} className="mt-px shrink-0" />}
          <span className="line-clamp-2 min-w-0">{s.label}</span>
        </h3>
        <div className="mt-2 flex flex-col gap-1.5 text-[15px]">
          <DueText deadline={item.deadline} now={now} mode="feed" />
          <span className="inline-flex min-w-0 items-center gap-2 text-ink-2">
            <MapPin size={18} className="shrink-0" aria-hidden />
            <span className="truncate">{item.city}</span>
          </span>
        </div>
        {item.description.trim() && <p className={cn("mt-2 line-clamp-2 text-[14.5px] leading-5 wrap-anywhere", MUTED)}>{item.description}</p>}
      </Link>
      <div className="px-4 pb-4 lg:flex lg:w-[220px] lg:shrink-0 lg:flex-col lg:justify-center lg:border-l lg:border-line lg:p-4">
        <WButton
          size="lg"
          full
          icon={mode === "off_shift" ? Lock : undefined}
          softDisabled={mode === "off_shift"}
          disabled={mode === "offline"}
          onClick={() => onTake(item)}
          aria-label={mode === "off_shift" ? `Взять заказ №${item.number}. Сначала включите приём заказов` : `Взять заказ №${item.number}`}
        >
          {mode === "offline" ? "Нет связи" : "Взять заказ"}
        </WButton>
        {mode === "off_shift" && <p className={cn("mt-1.5 text-center text-[13.5px]", MUTED)}>Сначала включите приём заказов</p>}
      </div>
    </article>
  );
});

/** «Надгробие» на месте пропавшего заказа — соседние карточки не сдвигаются под пальцем. */
export function GoneCard({ number }: { number: number }) {
  return (
    <div className="card flex min-h-14 items-center gap-2.5 px-4 text-[15px] text-[#6b675f]">
      <Ban size={18} className="shrink-0" aria-hidden />
      {number ? `Заказ №${number} больше недоступен` : "Заказ больше недоступен"}
    </div>
  );
}
