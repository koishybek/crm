// Service worker (public/sw.js, ТЗ п.23.6): уведомления на телефон и офлайн-оболочка. Регистрируется только после
// входа сотрудника или мастера (Guard в App.tsx): публичные страницы — форма заявки и отзыв — его не ставят.
// В разработке (vite dev) не регистрируется: кеш файлов сборки мешал бы горячей перезагрузке.
import { useEffect } from "react";

let registering: Promise<ServiceWorkerRegistration | null> | null = null;

export const swSupported = (): boolean => typeof navigator !== "undefined" && "serviceWorker" in navigator;

/** Регистрация (один раз за сеанс); null — браузер не умеет или сборка для разработки. */
export function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!swSupported() || !import.meta.env.PROD) return Promise.resolve(null);
  registering ??= navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((e: unknown) => {
    console.warn("Service worker не зарегистрирован", e instanceof Error ? e.name : "");
    registering = null;
    return null;
  });
  return registering;
}

/** Для каркаса после входа: зарегистрировать, когда человек вошёл. */
export function useServiceWorker(signedIn: boolean): void {
  useEffect(() => {
    if (signedIn) void registerServiceWorker();
  }, [signedIn]);
}
