// «Установить приложение» для мастера: системное окно установки (Android, Chrome, Edge) или инструкция —
// на iPhone «Поделиться → На экран „Домой“», на Android без системного окна — через меню браузера.
// Строка в профиле есть, пока приложение не установлено; карточка в ленте — одна подсказка, один раз.
import { Download, EllipsisVertical, Plus, Share, SquarePlus, X, type LucideIcon } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "../../data/store";
import { installPlatform, installWay, isInAppBrowser, promptInstall, showInstallCard, useInstall, type InstallWay } from "../../data/workerInstall";
import { useWorkerPrefs } from "../../data/workerPrefs";
import { cn } from "../../lib/format";
import { LogoMark } from "../icons";
import { IconBtn, MUTED, WButton } from "./kit";
import { Sheet } from "./Sheet";

type Guide = "ios" | "android";

const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
const PLATFORM = typeof navigator === "undefined" ? "other" : installPlatform(UA, navigator.maxTouchPoints);
const IN_APP = isInAppBrowser(UA);

/** Как предложить установку на этом устройстве; null — уже установлено или браузер не умеет. */
export function useInstallWay(): InstallWay {
  const canPrompt = useInstall((s) => s.prompt !== null);
  const installed = useInstall((s) => s.installed);
  const standalone = useInstall((s) => s.standalone);
  return installWay({ standalone, installed, canPrompt, platform: PLATFORM });
}

/** Показывать ли в ленте карточку «Установите Home Max на телефон». */
export function useInstallCardVisible(): boolean {
  const way = useInstallWay();
  const visits = useWorkerPrefs((s) => s.visits);
  const hint = useWorkerPrefs((s) => s.installHint);
  return showInstallCard({ way, platform: PLATFORM, inApp: IN_APP, visits, hint });
}

/** Системное окно установки, ответ — тостом. Вызывать прямо из нажатия: без жеста браузер окно не откроет. */
function runPrompt(): void {
  void promptInstall().then((outcome) => {
    if (outcome === "accepted") toast("Приложение установлено — ищите иконку Home Max на экране");
    else if (outcome === "unavailable") toast("Не получилось открыть установку. Откройте меню браузера ⋮ и выберите «Установить приложение»", "bad");
  });
}

/** Кнопка «Установить»: системное окно, если браузер его дал, иначе шторка с инструкцией. */
export function useInstallOffer(): { way: InstallWay; open: () => void; sheet: ReactNode } {
  const way = useInstallWay();
  const [guide, setGuide] = useState<Guide | null>(null);

  const open = () => {
    if (way === "ios" || way === "android") setGuide(way);
    else if (way === "prompt") runPrompt();
  };

  return { way, open, sheet: guide && <InstallGuide guide={guide} onClose={() => setGuide(null)} /> };
}

interface Step {
  icon: LucideIcon;
  title: string;
  hint?: string;
}

const STEPS: Record<Guide, Step[]> = {
  ios: [
    { icon: Share, title: "Нажмите «Поделиться»", hint: "Квадрат со стрелкой вверх — внизу или вверху экрана. Не видно — сначала «•••»." },
    { icon: SquarePlus, title: "Выберите «На экран „Домой“»", hint: "Если пункта нет — пролистайте список ниже." },
    { icon: Plus, title: "Нажмите «Добавить»" },
  ],
  android: [
    { icon: EllipsisVertical, title: "Откройте меню браузера", hint: "Значок ⋮ — вверху справа." },
    { icon: SquarePlus, title: "Выберите «Установить приложение»", hint: "Или «Добавить на главный экран»." },
    { icon: Download, title: "Подтвердите установку" },
  ],
};

const FROM_TELEGRAM: Record<Guide, string> = {
  ios: "Открыли ссылку из Telegram? Сначала откройте страницу в Safari.",
  android: "Открыли ссылку из Telegram? Сначала нажмите «Открыть в браузере».",
};

function InstallGuide({ guide, onClose }: { guide: Guide; onClose: () => void }) {
  return (
    <Sheet
      open
      onClose={onClose}
      title="Установите Home Max на телефон"
      footer={
        <WButton size="lg" full onClick={onClose}>
          Понятно
        </WButton>
      }
    >
      <p className="text-[15.5px] text-ink-2">На экране появится иконка — заказы будут открываться в один тап, как обычное приложение.</p>
      <ol className="mt-4 flex flex-col gap-3.5">
        {STEPS[guide].map((s, i) => (
          <li key={s.title} className="flex items-start gap-3">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-[15px] font-bold text-on-brand" aria-hidden>
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 pt-1">
              <span className="flex items-start gap-2 text-[16px] leading-snug font-semibold text-ink">
                <span className="min-w-0">{s.title}</span>
                <s.icon size={19} className="mt-px shrink-0 text-ink-2" aria-hidden />
              </span>
              {s.hint && <span className={cn("mt-0.5 block text-[14px]", MUTED)}>{s.hint}</span>}
            </span>
          </li>
        ))}
      </ol>
      <p className={cn("mt-4 rounded-[12px] bg-[#faf8f3] px-3.5 py-2.5 text-[14px]", MUTED)}>{FROM_TELEGRAM[guide]}</p>
    </Sheet>
  );
}

/**
 * Карточка в ленте «Установите Home Max на телефон» — один раз. На Android — установка в один тап,
 * на iPhone — короткая подсказка «Поделиться → На экран „Домой“» и подробная инструкция по кнопке.
 * «Скрыть», «Установить» или прочитанная инструкция убирают карточку совсем (строка в профиле остаётся).
 */
export function InstallCard() {
  const way = useInstallWay();
  const show = useWorkerPrefs((s) => s.showInstallHint);
  const close = useWorkerPrefs((s) => s.closeInstallHint);
  const [guide, setGuide] = useState(false);
  // Карточка на экране — запоминаем показ: в следующий заход её уже не будет.
  useEffect(() => show(Date.now()), [show]);
  const ios = way === "ios";

  return (
    <section className="card py-2 pr-1 pl-4" aria-label="Установка приложения">
      <div className="flex items-start gap-3">
        <span className="mt-2 shrink-0">
          <LogoMark size={26} />
        </span>
        <div className="min-w-0 flex-1 pt-2">
          <p className="text-[15px] leading-snug font-semibold text-ink">Установите Home Max на телефон</p>
          <p className="mt-0.5 text-[15px] leading-snug text-ink-2">
            {ios ? (
              <>
                Нажмите «Поделиться» <Share size={16} className="inline-block align-[-3px]" aria-hidden />, затем «На экран „Домой“»
              </>
            ) : (
              "Заказы будут открываться в один тап, как обычное приложение"
            )}
          </p>
        </div>
        <IconBtn icon={X} label="Скрыть" onClick={() => close(Date.now())} />
      </div>
      <div className="mt-1 pr-3 pb-1 pl-[38px]">
        {ios ? (
          <WButton variant="secondary" onClick={() => setGuide(true)}>
            Как установить
          </WButton>
        ) : (
          <WButton
            variant="secondary"
            icon={Download}
            onClick={() => {
              runPrompt();
              close(Date.now());
            }}
          >
            Установить
          </WButton>
        )}
      </div>
      {guide && (
        <InstallGuide
          guide="ios"
          onClose={() => {
            setGuide(false);
            close(Date.now());
          }}
        />
      )}
    </section>
  );
}
