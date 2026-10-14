// «Уведомления на телефон» (web push, ТЗ п.23.6): подписка браузера → convex/push.ts. Каждое действие — Result.
import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { convex, run, type Result } from "./convex";
import { registerServiceWorker, swSupported } from "./serviceWorker";
import { installPlatform } from "./workerInstall";
import type { PushState } from "./push";

export type PushAvailability = "ok" | "unsupported" | "ios-install" | "denied";

/** Что мешает включить уведомления на этом устройстве. На iPhone push работает только у установленного приложения. */
export function pushAvailability(): PushAvailability {
  if (typeof window === "undefined") return "unsupported";
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (!swSupported() || !("PushManager" in window) || !("Notification" in window)) {
    return installPlatform(navigator.userAgent, navigator.maxTouchPoints) === "ios" && !standalone ? "ios-install" : "unsupported";
  }
  return Notification.permission === "denied" ? "denied" : "ok";
}

const keyBytes = (b64url: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(b64url.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Подписка этого браузера и есть ли она на сервере; refresh — перечитать после включения/выключения. */
export function usePushState(): { state: PushState | undefined; refresh: () => void } {
  const [endpoint, setEndpoint] = useState<string | undefined>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    currentSubscription()
      .then((s) => alive && setEndpoint(s?.endpoint))
      .catch(() => alive && setEndpoint(undefined));
    return () => {
      alive = false;
    };
  }, [tick]);
  const state = useQuery(api.push.state, endpoint ? { endpoint } : {});
  return { state, refresh: () => setTick((t) => t + 1) };
}

export async function enablePush(publicKey: string): Promise<Result<unknown>> {
  try {
    const reg = await registerServiceWorker();
    if (!reg) return { ok: false, error: "Этот браузер не поддерживает уведомления" };
    if ((await Notification.requestPermission()) !== "granted") return { ok: false, error: "Уведомления запрещены — разрешите их в настройках браузера для этого сайта" };
    await navigator.serviceWorker.ready;
    const key = keyBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    // Подписка на старый ключ сервера (ключи сменили) — пересоздаём.
    if (sub && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey).join() !== key.join()) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const json = sub.toJSON();
    if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return { ok: false, error: "Браузер не выдал подписку — попробуйте ещё раз" };
    return await run(convex.mutation(api.push.subscribe, { endpoint: json.endpoint, p256dh: json.keys.p256dh, auth: json.keys.auth }));
  } catch (e) {
    console.warn("Web push: подписка не оформлена", e instanceof Error ? e.name : "");
    return { ok: false, error: "Не получилось включить уведомления — попробуйте ещё раз" };
  }
}

export async function disablePush(): Promise<Result<unknown>> {
  try {
    const sub = await currentSubscription();
    if (!sub) return { ok: true, value: undefined };
    const r = await run(convex.mutation(api.push.unsubscribe, { endpoint: sub.endpoint }));
    await sub.unsubscribe();
    return r;
  } catch {
    return { ok: false, error: "Не получилось выключить уведомления — попробуйте ещё раз" };
  }
}

/** Перед выходом из аккаунта: уведомления этого человека не должны приходить на устройство после выхода. */
export async function pushBeforeSignOut(): Promise<void> {
  await Promise.race([disablePush(), new Promise((r) => setTimeout(r, 3000))]);
}
