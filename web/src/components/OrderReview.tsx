// Блок «Отзыв клиента» в карточке заказа (ТЗ п.14, п.29 «закрытие → рейтинг»): отзыв, если он есть,
// или два способа его получить — ссылка для клиента и оценка со слов клиента.
import { useQuery } from "convex/react";
import { Link2, MessageSquarePlus, Pencil } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useMe, useNow, useTeam } from "../data/hooks";
import { requestReviewLink, saveOperatorReview } from "../data/reviewActions";
import { LOW_RATING, REVIEW_EDIT_DAYS, REVIEW_TEXT_MAX, REVIEW_VIA, ratingWord, type ReviewView } from "../data/reviews";
import { report, toast } from "../data/store";
import type { Order } from "../data/types";
import { date, dateTime, shortName } from "../lib/format";
import { StarInput, Stars } from "./Rating";
import { Badge, Button, Card, FormRow, Modal, Textarea } from "./ui";

type OrderRef = Pick<Order, "id" | "number">;

/** Монтируется в карточке заказа всегда: пока заказ не выполнен и отзыва нет, блока не видно. */
export function OrderReview({ o }: { o: OrderRef }) {
  const me = useMe();
  const team = useTeam();
  const now = useNow(60_000);
  const info = useQuery(api.reviews.forOrder, { orderId: o.id as Id<"orders"> });
  const [modal, setModal] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!info || (!info.review && !info.reviewable)) return null;

  // Получать и записывать оценки — владелец и операторы (как и сервер); руководитель только видит.
  const staff = me?.role === "owner" || me?.role === "operator";
  const r = info.review;
  const canEdit = staff && !!r && !!info.editableUntil && Date.parse(info.editableUntil) > now;
  const sentUntil = !r && !link && info.linkExpiresAt && Date.parse(info.linkExpiresAt) > now ? info.linkExpiresAt : undefined;

  const copyLink = async () => {
    setBusy(true);
    const res = await requestReviewLink(o.id);
    setBusy(false);
    if (!report(res)) return;
    setLink(res.value);
    try {
      await navigator.clipboard.writeText(res.value.url);
      toast("Ссылка скопирована — отправьте её клиенту");
    } catch {
      toast("Скопируйте ссылку из поля в блоке «Отзыв клиента»", "info");
    }
  };

  return (
    <Card
      title="Отзыв клиента"
      titleExtra={r && r.rating <= LOW_RATING ? <Badge tone="red">Низкая оценка</Badge> : undefined}
      action={
        canEdit ? (
          <button onClick={() => setModal(true)} className="inline-flex items-center gap-1.5 text-[14px] font-medium text-brand-ink hover:text-brand-deep">
            <Pencil size={16} /> Исправить
          </button>
        ) : undefined
      }
    >
      {r ? (
        <ReviewBody r={r} author={r.authorId ? team.userName(r.authorId) : ""} />
      ) : (
        <div>
          <p className="text-[14px] text-muted">
            Клиент ещё не оценил работу.
            {staff && " Отправьте ему ссылку или запишите оценку с его слов — рейтинг мастера пересчитается сам."}
          </p>
          {staff && (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={Link2} onClick={() => void copyLink()} disabled={busy}>
                Скопировать ссылку для оценки
              </Button>
              <Button size="sm" variant="secondary" icon={MessageSquarePlus} onClick={() => setModal(true)}>
                Записать оценку со слов клиента
              </Button>
            </div>
          )}
          {link && (
            <div className="mt-3">
              <input readOnly aria-label="Ссылка для клиента" value={link.url} onFocus={(e) => e.currentTarget.select()} className="field h-10 text-[13.5px]" />
              <p className="mt-1.5 text-[12.5px] text-muted">Действует до {date(link.expiresAt)}. По ссылке можно оставить одну оценку, данных клиента на странице нет.</p>
            </div>
          )}
          {sentUntil && <p className="mt-2.5 text-[12.5px] text-muted">Ссылка уже создавалась и действует до {date(sentUntil)} — повторное копирование даст ту же.</p>}
        </div>
      )}
      {modal && <OperatorReviewModal o={o} current={r} onClose={() => setModal(false)} />}
    </Card>
  );
}

function ReviewBody({ r, author }: { r: ReviewView; author: string }) {
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Stars value={r.rating} size={22} />
        <span className="text-[15px] font-semibold text-ink">
          {r.rating} из 5 · {ratingWord(r.rating)}
        </span>
      </div>
      {r.text ? (
        <p className="mt-2 text-[14.5px] whitespace-pre-line text-ink-2 [overflow-wrap:anywhere]">«{r.text}»</p>
      ) : (
        <p className="mt-2 text-[13.5px] text-muted">Без комментария</p>
      )}
      <p className="mt-2 text-[12.5px] text-muted">
        {REVIEW_VIA[r.via]}
        {r.via === "operator" && author ? ` · записал(а) ${shortName(author)}` : ""} · {dateTime(r.at)}
      </p>
    </div>
  );
}

function OperatorReviewModal({ o, current, onClose }: { o: OrderRef; current: ReviewView | null; onClose: () => void }) {
  const [rating, setRating] = useState(current?.rating ?? 0);
  const [text, setText] = useState(current?.text ?? "");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!rating) return toast("Выберите оценку — от 1 до 5 звёзд", "bad");
    setBusy(true);
    const r = await saveOperatorReview(o.id, rating, text);
    setBusy(false);
    if (report(r, r.ok && r.value.updated ? "Оценка исправлена" : "Оценка записана — рейтинг мастера обновлён")) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={current ? "Исправить оценку" : "Оценка со слов клиента"}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            Сохранить
          </Button>
        </>
      }
    >
      <p className="-mt-1 mb-4 text-[14px] text-muted">Заказ №{o.number}. Спросите клиента, как он оценивает работу мастера — от 1 до 5.</p>
      <StarInput value={rating} onChange={setRating} size={40} label="Оценка клиента" />
      <div className="mt-4">
        <FormRow label="Что сказал клиент" hint={`Необязательно · ${text.length}/${REVIEW_TEXT_MAX}`}>
          {(id) => <Textarea id={id} rows={3} maxLength={REVIEW_TEXT_MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="Например: пришёл вовремя, всё сделал аккуратно" />}
        </FormRow>
      </div>
      <p className="mt-3 text-[12.5px] text-muted">Записанную оценку можно исправить в течение {REVIEW_EDIT_DAYS} дней. Оценку, которую клиент оставил сам, изменить нельзя.</p>
    </Modal>
  );
}
