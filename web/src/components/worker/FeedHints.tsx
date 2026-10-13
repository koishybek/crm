// Подсказки над лентой — не больше одной за раз, по важности: подключить Telegram, «Как брать заказы»
// (новичку, пока нет своих заказов), установить приложение на телефон (один раз). Каждая скрывается своей кнопкой.
import { useQuery } from "convex/react";
import { Send, X } from "lucide-react";
import { useId, useState } from "react";
import { api } from "../../../convex/_generated/api";
import { report } from "../../data/store";
import { connectTelegram } from "../../data/workerActions";
import { pickFeedHint, shownFeedHint, type FeedHintFlags, type FeedHintKind } from "../../data/workerFeed";
import { TG_BANNER_PAUSE_MS, useWorkerPrefs } from "../../data/workerPrefs";
import { IconBtn, WButton } from "./kit";
import { InstallCard, useInstallCardVisible } from "./Install";

interface FeedHintProps {
  /** В ленте есть заказы (пустая лента сама предлагает подключить Telegram). */
  hasOrders: boolean;
  /** Сколько у мастера своих заказов; undefined — ещё грузятся. */
  ownOrders: number | undefined;
  now: number;
}

export function FeedHint({ hasOrders, ownOrders, now }: FeedHintProps) {
  const tg = useQuery(api.telegram.status);
  const tgHiddenAt = useWorkerPrefs((s) => s.tgBannerHiddenAt);
  const onboarded = useWorkerPrefs((s) => s.onboarded);
  const install = useInstallCardVisible();
  const tgPaused = tgHiddenAt !== null && now - tgHiddenAt < TG_BANNER_PAUSE_MS;
  const flags: FeedHintFlags = {
    telegram: hasOrders && !!tg?.enabled && !tg.linked && !tgPaused,
    howto: !onboarded && ownOrders === 0,
    install,
  };

  // Подсказку выбираем один раз — когда известно про Telegram и свои заказы. Дальше она может только
  // исчезнуть, но не смениться другой и не появиться позже: лента под пальцем не сдвигается.
  const [chosen, setChosen] = useState<FeedHintKind | null | undefined>(undefined);
  if (chosen === undefined && tg !== undefined && ownOrders !== undefined) setChosen(pickFeedHint(flags));

  const shown = chosen === undefined ? null : shownFeedHint(chosen, flags);
  if (shown === "telegram") return <TelegramBanner />;
  if (shown === "howto") return <HowToCard />;
  if (shown === "install") return <InstallCard />;
  return null;
}

/** «Подключите Telegram» — новые заказы будут приходить сразу. Скрывается на неделю. */
function TelegramBanner() {
  const hide = useWorkerPrefs((s) => s.hideTgBanner);
  return (
    <section className="card py-2 pr-1 pl-4" aria-label="Telegram">
      <div className="flex items-start gap-3">
        <Send size={22} className="mt-2.5 shrink-0 text-[#1767c2]" aria-hidden />
        <p className="min-w-0 flex-1 pt-2 text-[15px] leading-snug text-ink">Подключите Telegram — новые заказы будут приходить сразу</p>
        <IconBtn icon={X} label="Скрыть на неделю" onClick={() => hide(Date.now())} />
      </div>
      <div className="mt-1 pr-3 pb-1 pl-[34px]">
        <WButton variant="secondary" onClick={async () => void report(await connectTelegram())}>
          Подключить Telegram
        </WButton>
      </div>
    </section>
  );
}

const HOW_TO = [
  "Выберите заказ и нажмите «Взять заказ».",
  "Позвоните клиенту, приезжайте и сделайте работу.",
  "Нажмите «Работа выполнена» и приложите фото. Выплата — после оплаты клиентом.",
];

/** «Как брать заказы» — три шага для новичка, один раз до «Понятно». */
function HowToCard() {
  const finish = useWorkerPrefs((s) => s.finishOnboarding);
  const titleId = useId();
  return (
    <section className="card p-4" aria-labelledby={titleId}>
      <h2 id={titleId} className="text-[17px] font-semibold text-ink">
        Как брать заказы
      </h2>
      <ol className="mt-3 flex flex-col gap-3">
        {HOW_TO.map((text, i) => (
          <li key={text} className="flex items-start gap-3">
            <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-[14px] font-bold text-on-brand" aria-hidden>
              {i + 1}
            </span>
            <span className="min-w-0 pt-0.5 text-[15px] leading-snug text-ink-2">{text}</span>
          </li>
        ))}
      </ol>
      <WButton variant="secondary" full className="mt-4" onClick={finish}>
        Понятно
      </WButton>
    </section>
  );
}
