// Установка кабинета мастера на телефон (PWA). Android, Chrome и Edge присылают событие beforeinstallprompt —
// по нему открываем системное окно установки в один тап. На iPhone такого события нет: там подсказка
// «Поделиться → На экран „Домой“», на Android без события — «меню браузера → Установить приложение».
// Событие приходит рано, иногда до загрузки экранов мастера, поэтому слушаем его с запуска приложения
// (listenForInstall вызывает каркас кабинета). Подсказки показывают только экраны мастера — сотрудникам никогда.
import { create } from "zustand";
import type { InstallHint } from "./workerPrefs";

export type InstallPlatform = "ios" | "android" | "other";

/** Как предложить установку: системным окном, инструкцией для iPhone или для Android; null — не предлагаем. */
export type InstallWay = "prompt" | "ios" | "android" | null;

/** Событие beforeinstallprompt (Chromium): в стандартных типах DOM его нет. */
export interface InstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const isInstallPrompt = (e: Event): e is InstallPromptEvent => typeof (e as { prompt?: unknown }).prompt === "function" && "userChoice" in e;

/** Платформа по userAgent. iPadOS 13+ представляется компьютером Mac, но с сенсорным экраном. */
export function installPlatform(userAgent: string, maxTouchPoints = 0): InstallPlatform {
  if (/iPhone|iPad|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) return "ios";
  if (/Android/i.test(userAgent)) return "android";
  return "other";
}

export interface InstallState {
  /** Открыто как установленное приложение (с иконки на экране). */
  standalone: boolean;
  /** Установили в этом сеансе (событие appinstalled или «Установить» в системном окне). */
  installed: boolean;
  /** Браузер прислал beforeinstallprompt — можно открыть системное окно. */
  canPrompt: boolean;
  platform: InstallPlatform;
}

export function installWay(s: InstallState): InstallWay {
  if (s.standalone || s.installed) return null;
  if (s.canPrompt) return "prompt";
  if (s.platform === "ios" || s.platform === "android") return s.platform;
  return null;
}

/**
 * Встроенный браузер приложения (Telegram, Instagram, Facebook, Google): «На экран „Домой“» в нём нет.
 * На iPhone такие браузеры обычно не пишут «Safari/» в userAgent, на Android помечены «; wv)».
 */
export function isInAppBrowser(userAgent: string): boolean {
  if (/FBAN|FBAV|Instagram|Telegram|Line\/|GSA\/|; wv\)/i.test(userAgent)) return true;
  return /iPhone|iPad|iPod/i.test(userAgent) && !/Safari\//.test(userAgent);
}

/** Карточка в ленте — с третьего открытия кабинета: в первые заходы мастеру важнее разобраться с заказами. */
export const INSTALL_CARD_FROM_VISIT = 3;

export interface InstallCardState {
  way: InstallWay;
  platform: InstallPlatform;
  inApp: boolean;
  visits: number;
  hint: InstallHint;
}

/**
 * Карточка «Установите Home Max на телефон» в ленте — один раз, только на телефоне и только там, где
 * установка в один тап (Android) или короткая инструкция сработает сразу (iPhone в браузере, не внутри
 * Telegram). Строка «Установить приложение» в профиле остаётся и после карточки.
 */
export function showInstallCard(s: InstallCardState): boolean {
  return s.hint !== "done" && !s.inApp && s.platform !== "other" && (s.way === "prompt" || s.way === "ios") && s.visits >= INSTALL_CARD_FROM_VISIT;
}

function isStandalone(): boolean {
  try {
    return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

export const useInstall = create<{ prompt: InstallPromptEvent | null; installed: boolean; standalone: boolean }>()(() => ({
  prompt: null,
  installed: false,
  standalone: typeof window !== "undefined" && isStandalone(),
}));

let listening = false;

/** Слушать предложение установки с запуска приложения. Повторные вызовы ничего не делают. */
export function listenForInstall(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("beforeinstallprompt", (e) => {
    if (!isInstallPrompt(e)) return;
    // Своё предложение вместо мини-панели браузера: мастеру — в ленте и профиле, команде — нигде
    // (сотрудники при желании ставят приложение из меню браузера).
    e.preventDefault();
    useInstall.setState({ prompt: e });
  });
  window.addEventListener("appinstalled", () => useInstall.setState({ prompt: null, installed: true }));
}

/** busy — системное окно уже открыто (повторное нажатие). */
export type InstallOutcome = "accepted" | "dismissed" | "unavailable" | "busy";

let prompting = false;

/**
 * Системное окно установки. Вызывать прямо из обработчика нажатия: браузер открывает его только по жесту.
 * Событие одноразовое — после ответа ждём следующего (браузер пришлёт его при следующем заходе).
 */
export async function promptInstall(): Promise<InstallOutcome> {
  const e = useInstall.getState().prompt;
  if (!e) return "unavailable";
  if (prompting) return "busy";
  prompting = true;
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    useInstall.setState(outcome === "accepted" ? { prompt: null, installed: true } : { prompt: null });
    return outcome;
  } catch (err) {
    useInstall.setState({ prompt: null });
    console.warn("Установка приложения: системное окно не открылось", err instanceof Error ? err.name : "");
    return "unavailable";
  } finally {
    prompting = false;
  }
}
