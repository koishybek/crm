// Публичная страница оценки заказа (ТЗ п.14, п.29): клиент открывает ссылку из сообщения — без входа, обычно с телефона.
// Данных клиента здесь нет: номер заказа, услуга, имя мастера и дата. Проверки и лимит попыток — на сервере.
import { useQuery } from "convex/react";
import { CircleCheck, Clock, Link2Off, type LucideIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router";
import { api } from "../../convex/_generated/api";
import { Logo } from "../components/icons";
import { StarInput, Stars } from "../components/Rating";
import { Button, Loading, Textarea } from "../components/ui";
import { APP_NAME } from "../data/catalog";
import { submitReviewByLink } from "../data/reviewActions";
import { LOW_RATING, REVIEW_LINK_DAYS, REVIEW_TEXT_MAX, type ReviewLinkInfo } from "../data/reviews";
import { cn, date } from "../lib/format";

type Closed = Exclude<ReviewLinkInfo["state"], "ok">;

export default function PublicReview() {
  const { token = "" } = useParams();
  const info = useQuery(api.reviews.byToken, { token });
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  // Итог отправки важнее живого состояния ссылки: после «спасибо» ссылка становится «использованной».
  const [sent, setSent] = useState<number | null>(null);
  const [closed, setClosed] = useState<Closed | null>(null);

  useEffect(() => {
    const prev = document.title;
    document.title = `Оценка заказа — ${APP_NAME}`;
    return () => {
      document.title = prev;
    };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rating) return setError("Выберите оценку — от 1 до 5 звёзд");
    setSending(true);
    setError("");
    const r = await submitReviewByLink(token, rating, text);
    setSending(false);
    if (!r.ok) return setError(r.error);
    if (r.value.ok) return setSent(rating);
    const state = r.value.state;
    if (state === "used" || state === "expired" || state === "invalid") return setClosed(state);
    setError(r.value.error);
  };

  const order = info?.order;
  const state: Closed | null = closed ?? (info && info.state !== "ok" ? info.state : null);
  let body: ReactNode;
  if (sent !== null) {
    body = (
      <Message icon={CircleCheck} tone="ok" title="Спасибо за оценку!">
        <Stars value={sent} size={24} className="mt-3" />
        <p className="mt-3">{sent <= LOW_RATING ? "Нам жаль, что не всё прошло хорошо, — мы обязательно разберёмся." : "Рады, что всё прошло хорошо! Ваш отзыв помогает нам работать с лучшими мастерами."}</p>
      </Message>
    );
  } else if (info === undefined) {
    body = <Loading text="Открываем заказ…" />;
  } else if (state === "used") {
    body = (
      <Message icon={CircleCheck} tone="ok" title="Оценка уже получена">
        <p>{order ? `Спасибо! По заказу №${order.number} мы уже получили вашу оценку.` : "Спасибо! Мы уже получили вашу оценку."}</p>
      </Message>
    );
  } else if (state === "expired") {
    body = (
      <Message icon={Clock} tone="warn" title="Срок действия ссылки истёк">
        <p>Ссылка для оценки действует {REVIEW_LINK_DAYS} дней. Если хотите оценить работу — напишите или позвоните нам, и мы пришлём новую.</p>
      </Message>
    );
  } else if (state === "invalid" || !order) {
    body = (
      <Message icon={Link2Off} tone="gray" title="Ссылка не найдена">
        <p>Проверьте, что ссылка скопирована целиком, или попросите менеджера прислать новую.</p>
      </Message>
    );
  } else {
    body = (
      <form onSubmit={submit} noValidate>
        <h1 className="text-[22px] leading-tight font-bold tracking-[-0.02em] text-ink sm:text-[24px]">Как прошёл заказ №{order.number}?</h1>
        <p className="mt-1.5 text-[15px] text-ink-2">
          {order.service}
          {order.executor && ` · мастер ${order.executor}`}
          {order.doneAt && ` · выполнен ${date(order.doneAt)}`}
        </p>
        <div className="my-6">
          <StarInput
            value={rating}
            onChange={(v) => {
              setRating(v);
              setError("");
            }}
            size={52}
            starClassName="h-[clamp(34px,11vw,52px)] w-[clamp(34px,11vw,52px)]"
            label="Ваша оценка"
          />
        </div>
        <label htmlFor="review-text" className="mb-2 block text-[14px] font-semibold text-ink">
          Комментарий <span className="font-normal text-muted">— по желанию</span>
        </label>
        <Textarea
          id="review-text"
          rows={4}
          maxLength={REVIEW_TEXT_MAX}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={rating && rating <= LOW_RATING ? "Что пошло не так? Мы обязательно разберёмся" : "Что понравилось, что стоит улучшить"}
        />
        <div className="mt-1 text-right text-[12px] text-muted tabular-nums">
          {text.length}/{REVIEW_TEXT_MAX}
        </div>
        {error && (
          <p role="alert" className="mt-2 text-[14px] font-medium text-bad-ink">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" full disabled={sending} className="mt-4">
          {sending ? "Отправляем…" : "Отправить"}
        </Button>
        <p className="mt-3 text-center text-[12.5px] text-muted">Оценку и комментарий увидят только сотрудники {APP_NAME}.</p>
      </form>
    );
  }

  return (
    <div className="min-h-dvh bg-page">
      <header className="mx-auto flex w-full max-w-[560px] items-center px-4 pt-6 pb-2">
        <Logo />
      </header>
      <main className="mx-auto w-full max-w-[560px] px-4 pt-3 pb-10">
        <div className="card p-5 sm:p-7">{body}</div>
      </main>
    </div>
  );
}

const TONE: Record<"ok" | "warn" | "gray", string> = { ok: "bg-ok-bg text-ok", warn: "bg-warn-bg text-warn-ink", gray: "bg-slate-bg text-muted" };

function Message({ icon: Icon, tone, title, children }: { icon: LucideIcon; tone: keyof typeof TONE; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center py-6 text-center" role="status">
      <span className={cn("inline-flex h-16 w-16 items-center justify-center rounded-full", TONE[tone])}>
        <Icon size={34} aria-hidden />
      </span>
      <h1 className="mt-4 text-[22px] font-bold tracking-[-0.02em] text-ink">{title}</h1>
      <div className="mt-1.5 flex max-w-sm flex-col items-center text-[15px] text-ink-2">{children}</div>
    </div>
  );
}
