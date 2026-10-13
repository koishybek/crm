// Настройки кабинета мастера на этом устройстве: когда смотрел ленту, какие карты открывать, подсказки
// (Telegram, «Как брать заказы», установка приложения) и сколько раз открывал кабинет.
// localStorage бывает недоступен (приватный режим) — тогда живём без памяти: все обращения в try/catch.
import { create } from "zustand";
import type { MapApp } from "./workerLinks";

const KEY = {
  feedSeenAt: "hm.feedSeenAt",
  mapApp: "hm.mapApp",
  tgBannerHiddenAt: "hm.tgBannerHiddenAt",
  visits: "hm.visits",
  installHintAt: "hm.installHintAt",
  onboarded: "hm.onboarded",
} as const;

/**
 * Подсказка «Установите Home Max на телефон» в ленте показывается один раз:
 * new — ещё не показывали; showing — показана в этот заход и видна до «Скрыть» (не пропадает при переходах
 * между вкладками); done — показана в прошлый заход, скрыта или мастер уже нажал «Установить».
 */
export type InstallHint = "new" | "showing" | "done";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Хранилище недоступно — настройка проживёт до перезагрузки страницы.
  }
}

const readTime = (key: string): number | null => {
  const n = Number(read(key));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const readCount = (key: string): number => {
  const n = Number(read(key));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

const readMapApp = (): MapApp | null => {
  const v = read(KEY.mapApp);
  return v === "2gis" || v === "yandex" ? v : null;
};

/** Заход считаем один раз за загрузку страницы: повторный монтаж каркаса — не новый заход. */
let visitCounted = false;

interface WorkerPrefs {
  /** Когда мастер последний раз видел ленту (мс) — от этого считается счётчик на вкладке «Заказы». */
  feedSeenAt: number | null;
  /** Карты для «Маршрута»; null — спрашивать каждый раз. */
  mapApp: MapApp | null;
  tgBannerHiddenAt: number | null;
  /** Сколько раз мастер открывал кабинет на этом устройстве. */
  visits: number;
  installHint: InstallHint;
  /** Нажал «Понятно» в «Как брать заказы». */
  onboarded: boolean;
  markFeedSeen: (at: number) => void;
  setMapApp: (app: MapApp | null) => void;
  hideTgBanner: (at: number) => void;
  countVisit: () => void;
  /** Подсказка об установке появилась на экране: запоминаем, чтобы в следующий заход её уже не было. */
  showInstallHint: (at: number) => void;
  /** «Скрыть» или «Установить» — подсказка больше не нужна. */
  closeInstallHint: (at: number) => void;
  finishOnboarding: () => void;
}

export const useWorkerPrefs = create<WorkerPrefs>()((set, get) => ({
  feedSeenAt: readTime(KEY.feedSeenAt),
  mapApp: readMapApp(),
  tgBannerHiddenAt: readTime(KEY.tgBannerHiddenAt),
  visits: readCount(KEY.visits),
  installHint: read(KEY.installHintAt) === null ? "new" : "done",
  onboarded: read(KEY.onboarded) === "1",
  markFeedSeen: (at) => {
    write(KEY.feedSeenAt, String(at));
    set({ feedSeenAt: at });
  },
  setMapApp: (app) => {
    write(KEY.mapApp, app);
    set({ mapApp: app });
  },
  hideTgBanner: (at) => {
    write(KEY.tgBannerHiddenAt, String(at));
    set({ tgBannerHiddenAt: at });
  },
  countVisit: () => {
    if (visitCounted) return;
    visitCounted = true;
    const visits = readCount(KEY.visits) + 1;
    write(KEY.visits, String(visits));
    set({ visits });
  },
  showInstallHint: (at) => {
    if (get().installHint !== "new") return;
    write(KEY.installHintAt, String(at));
    set({ installHint: "showing" });
  },
  closeInstallHint: (at) => {
    if (get().installHint === "new") write(KEY.installHintAt, String(at));
    set({ installHint: "done" });
  },
  finishOnboarding: () => {
    write(KEY.onboarded, "1");
    set({ onboarded: true });
  },
}));

/** Баннер «Подключите Telegram» после «Скрыть» не показываем неделю. */
export const TG_BANNER_PAUSE_MS = 7 * 86400_000;
