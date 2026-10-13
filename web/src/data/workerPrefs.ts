// Настройки кабинета мастера на этом устройстве: когда смотрел ленту, какие карты открывать,
// скрытый баннер Telegram. localStorage бывает недоступен (приватный режим) — тогда живём без памяти.
import { create } from "zustand";
import type { MapApp } from "./workerLinks";

const KEY = { feedSeenAt: "hm.feedSeenAt", mapApp: "hm.mapApp", tgBannerHiddenAt: "hm.tgBannerHiddenAt" } as const;

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

const readMapApp = (): MapApp | null => {
  const v = read(KEY.mapApp);
  return v === "2gis" || v === "yandex" ? v : null;
};

interface WorkerPrefs {
  /** Когда мастер последний раз видел ленту (мс) — от этого считается счётчик на вкладке «Заказы». */
  feedSeenAt: number | null;
  /** Карты для «Маршрута»; null — спрашивать каждый раз. */
  mapApp: MapApp | null;
  tgBannerHiddenAt: number | null;
  markFeedSeen: (at: number) => void;
  setMapApp: (app: MapApp | null) => void;
  hideTgBanner: (at: number) => void;
}

export const useWorkerPrefs = create<WorkerPrefs>()((set) => ({
  feedSeenAt: readTime(KEY.feedSeenAt),
  mapApp: readMapApp(),
  tgBannerHiddenAt: readTime(KEY.tgBannerHiddenAt),
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
}));

/** Баннер «Подключите Telegram» после «Скрыть» не показываем неделю. */
export const TG_BANNER_PAUSE_MS = 7 * 86400_000;
