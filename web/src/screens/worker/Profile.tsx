// «Профиль»: главный переключатель «Принимаю заказы», рейтинг и отзывы, услуги и навыки (меняет оператор),
// Telegram, карты для маршрута, поддержка и выход.
import { useAuthActions } from "@convex-dev/auth/react";
import { useQuery } from "convex/react";
import { Check, ChevronRight, CircleCheck, Headset, LogOut, MapPinned, Send, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api } from "../../../convex/_generated/api";
import type { Tone } from "../../data/catalog";
import { useNow } from "../../data/hooks";
import { report, telegramUnlink } from "../../data/store";
import { connectTelegram } from "../../data/workerActions";
import { MAP_APPS, SUPPORT_PHONE, SUPPORT_TEL, type MapApp } from "../../data/workerLinks";
import { useWorkerPrefs } from "../../data/workerPrefs";
import { dateAlmaty, monthYearGenitive } from "../../data/workerTime";
import type { WorkerReview } from "../../data/workerTypes";
import { cn, phone, plural } from "../../lib/format";
import { Avatar } from "../../components/ui";
import { AvailabilitySwitch } from "../../components/worker/Availability";
import { ConfirmSheet } from "../../components/worker/ConfirmSheet";
import { ListSkeleton, MUTED, ScreenTitle, Section, WButton, WLinkButton } from "../../components/worker/kit";
import { Stars } from "../../components/worker/parts";
import { Sheet } from "../../components/worker/Sheet";

/** Цвета чипов направлений — с контрастом текста не ниже 4,5:1. */
const CATEGORY_TONE: Record<Tone, string> = {
  blue: "bg-blue-soft text-[#0a58cc]",
  sky: "bg-sky-bg text-[#1767c2]",
  violet: "bg-violet-bg text-[#5a37d6]",
  amber: "bg-warn-bg text-[#9a5b00]",
  green: "bg-ok-bg text-[#067a46]",
  red: "bg-bad-bg text-[#c41d3a]",
  orange: "bg-orange-bg text-[#a34a07]",
  gray: "bg-slate-bg text-[#6b675f]",
  yellow: "bg-[#ffeaa6] text-[#3a2c00]",
};

const COOPERATION = { freelance: "Внештатный мастер", staff: "Мастер в штате" } as const;

const REVIEWS_SHOWN = 3;

type Confirm = "logout" | "tg-off" | null;

export function Profile() {
  const p = useQuery(api.executorApp.profile);
  const now = useNow(60_000);
  const nav = useNavigate();
  const { signOut } = useAuthActions();
  const mapApp = useWorkerPrefs((s) => s.mapApp);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [maps, setMaps] = useState(false);
  const [allReviews, setAllReviews] = useState(false);

  if (p === undefined) return <ListSkeleton count={2} />;
  const reviews = allReviews ? p.reviews : p.reviews.slice(0, REVIEWS_SHOWN);

  return (
    <div className="mx-auto flex max-w-[760px] flex-col gap-3">
      <ScreenTitle title="Профиль" />

      <section className="card flex items-center gap-4 p-4">
        <Avatar name={p.name} size={64} variant="person" />
        <div className="min-w-0">
          <h2 className="text-[20px] leading-tight font-bold text-ink">{p.name}</h2>
          <div className="mt-0.5 text-[15px] text-ink-2 tabular-nums">{phone(p.phone)}</div>
          <div className={cn("text-[14px]", MUTED)}>
            {p.city} · Мастер с {monthYearGenitive(p.joinedAt)}
          </div>
          <div className={cn("text-[14px]", MUTED)}>{COOPERATION[p.cooperation]}</div>
        </div>
      </section>

      <AvailabilitySwitch available={p.available} />

      <Section title="Рейтинг">
        {p.reviewsCount > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[28px] leading-none font-bold text-ink tabular-nums">{p.rating.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
            <Stars rating={p.rating} />
            <span className={cn("text-[15px]", MUTED)}>
              {p.reviewsCount} {plural(p.reviewsCount, "отзыв", "отзыва", "отзывов")}
            </span>
          </div>
        ) : (
          <p className="text-[16px] text-ink-2">Пока нет оценок. Они появятся после первых заказов.</p>
        )}
        <div className="mt-4 grid grid-cols-3 gap-2 text-center">
          <Stat label="Выполнено" value={p.stats.completed} />
          <Stat label="В работе" value={p.stats.active} />
          <Stat label="Отменено" value={p.stats.cancelled} />
        </div>
        {p.reviews.length > 0 && (
          <>
            <h3 className="mt-4 text-[15px] font-semibold text-ink">Отзывы клиентов</h3>
            <ul className="mt-2 flex flex-col gap-2">
              {reviews.map((r) => (
                <ReviewItem key={r.id} review={r} now={now} />
              ))}
            </ul>
            {p.reviews.length > REVIEWS_SHOWN && (
              <WButton variant="ghost" full className="mt-1" onClick={() => setAllReviews((v) => !v)}>
                {allReviews ? "Свернуть" : "Показать все отзывы"}
              </WButton>
            )}
          </>
        )}
      </Section>

      <Section title="Мои услуги">
        {p.categories.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {p.categories.map((c) => (
              <li key={c.id} className={cn("inline-flex min-h-8 items-center rounded-[8px] px-2.5 text-[14px] font-semibold", CATEGORY_TONE[c.tone])}>
                {c.label}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[15px] text-ink-2">Не выбраны</p>
        )}
        <h3 className="mt-4 text-[15px] font-semibold text-ink">Мои навыки</h3>
        {p.skills.length ? (
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {p.skills.map((s) => (
              <li key={s} className="inline-flex min-h-8 items-center rounded-[8px] bg-slate-bg px-2.5 text-[14px] text-ink">
                {s}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-0.5 text-[15px] text-ink-2">Не указаны</p>
        )}
        <h3 className="mt-4 text-[15px] font-semibold text-ink">Город</h3>
        <p className="mt-0.5 text-[15px] text-ink-2">{p.city}</p>
        <p className={cn("mt-4 text-[14px]", MUTED)}>Изменить услуги, навыки и город может оператор.</p>
        <WLinkButton href={SUPPORT_TEL} icon={Headset} full className="mt-2">
          Позвонить в офис
        </WLinkButton>
      </Section>

      <section className="card divide-y divide-line px-1">
        {p.telegram.enabled && (
          <div className="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5">
            <Send size={22} className="shrink-0 text-[#1767c2]" aria-hidden />
            <div className="min-w-[180px] flex-1">
              {p.telegram.linked ? (
                <span className="inline-flex items-center gap-1.5 text-[16px] font-semibold text-ink">
                  Telegram подключён <CircleCheck size={18} className="text-[#067a46]" aria-hidden />
                </span>
              ) : (
                <>
                  <span className="block text-[16px] font-semibold text-ink">Telegram</span>
                  <span className={cn("block text-[14px]", MUTED)}>Подключите, чтобы новые заказы приходили сразу</span>
                </>
              )}
            </div>
            {p.telegram.linked ? (
              <WButton variant="secondary" className="ml-auto" onClick={() => setConfirm("tg-off")}>
                Отключить
              </WButton>
            ) : (
              <WButton className="ml-auto" onClick={async () => void report(await connectTelegram())}>
                Подключить
              </WButton>
            )}
          </div>
        )}
        <RowButton icon={MapPinned} title={`Карты для маршрута: ${mapApp ? MAP_APPS[mapApp].label : "спрашивать"}`} onClick={() => setMaps(true)} />
        <RowLink icon={Headset} title="Позвонить в поддержку" hint={SUPPORT_PHONE} href={SUPPORT_TEL} />
        <RowButton icon={LogOut} title="Выйти" danger onClick={() => setConfirm("logout")} />
      </section>

      {maps && <MapsSheet value={mapApp} onClose={() => setMaps(false)} />}
      {confirm === "logout" && (
        <ConfirmSheet
          title="Выйти из аккаунта?"
          text="Уведомления в Telegram продолжат приходить. Чтобы вернуться, войдите по телефону и паролю."
          confirm="Выйти"
          danger
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            await signOut();
            nav("/login", { replace: true });
          }}
        />
      )}
      {confirm === "tg-off" && (
        <ConfirmSheet
          title="Отключить Telegram?"
          text="Новые заказы и сообщения перестанут приходить в Telegram."
          confirm="Отключить"
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            if (report(await telegramUnlink(), "Telegram отключён")) setConfirm(null);
          }}
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[12px] bg-[#faf8f3] px-2 py-2.5">
      <div className="text-[22px] leading-tight font-bold text-ink tabular-nums">{value}</div>
      <div className={cn("text-[13px]", MUTED)}>{label}</div>
    </div>
  );
}

function ReviewItem({ review: r, now }: { review: WorkerReview; now: number }) {
  const [open, setOpen] = useState(false);
  const long = (r.text?.length ?? 0) > 220;
  return (
    <li className="rounded-[12px] bg-[#faf8f3] p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <Stars rating={r.rating} size={16} />
        <span className="sr-only">Оценка {r.rating} из 5.</span>
        <span className={cn("text-[13.5px]", MUTED)}>
          {[r.service, dateAlmaty(r.at, now)].filter(Boolean).join(" · ")}
        </span>
      </div>
      {r.text && <p className={cn("mt-1 text-[15px] whitespace-pre-line text-ink-2 wrap-anywhere", long && !open && "line-clamp-4")}>{r.text}</p>}
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="-ml-2 inline-flex min-h-12 items-center px-2 text-[14.5px] font-semibold text-[#855600]">
          {open ? "Свернуть" : "Показать полностью"}
        </button>
      )}
    </li>
  );
}

function rowInner(Icon: LucideIcon, title: string, hint?: string, danger?: boolean): ReactNode {
  return (
    <>
      <Icon size={22} className={cn("shrink-0", danger ? "text-[#c41d3a]" : "text-ink-2")} aria-hidden />
      <span className="min-w-0 flex-1">
        <span className={cn("block text-[16px] font-medium", danger ? "text-[#c41d3a]" : "text-ink")}>{title}</span>
        {hint && <span className={cn("block text-[14px] tabular-nums", MUTED)}>{hint}</span>}
      </span>
      {!danger && <ChevronRight size={20} className="shrink-0 text-[#6b675f]" aria-hidden />}
    </>
  );
}

const ROW = "flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left active:bg-[#faf8f3]";

function RowButton({ icon, title, hint, danger, onClick }: { icon: LucideIcon; title: string; hint?: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className={ROW}>
      {rowInner(icon, title, hint, danger)}
    </button>
  );
}

function RowLink({ icon, title, hint, href }: { icon: LucideIcon; title: string; hint?: string; href: string }) {
  return (
    <a href={href} className={ROW}>
      {rowInner(icon, title, hint)}
    </a>
  );
}

/** Какие карты открывать по кнопке «Маршрут». */
function MapsSheet({ value, onClose }: { value: MapApp | null; onClose: () => void }) {
  const setMapApp = useWorkerPrefs((s) => s.setMapApp);
  const options: { value: MapApp | null; label: string }[] = [...(Object.keys(MAP_APPS) as MapApp[]).map((k) => ({ value: k, label: MAP_APPS[k].label })), { value: null, label: "Спрашивать каждый раз" }];
  return (
    <Sheet open onClose={onClose} title="Карты для маршрута">
      <div className="flex flex-col gap-1" role="radiogroup" aria-label="Карты для маршрута">
        {options.map((o) => (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => {
              setMapApp(o.value);
              onClose();
            }}
            className={cn("flex min-h-14 items-center justify-between rounded-[12px] px-3 text-left text-[16px]", value === o.value ? "bg-[#faf8f3] font-semibold text-ink" : "text-ink-2")}
          >
            {o.label}
            {value === o.value && <Check size={20} aria-hidden />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
