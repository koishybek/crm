// Сбор ошибок интерфейса (ТЗ п.26.5): window.onerror и необработанные отказы промисов → convex/clientErrors.ts.
// Только текст ошибки, путь экрана без параметров и версия сборки (правила — src/data/clientErrors.ts).
// Не больше 5 отчётов за загрузку страницы и без повторов — плюс лимиты на сервере.
import { api } from "../../convex/_generated/api";
import { convex } from "./convex";
import { ignoredError, scrubBuild, scrubErrorPath, scrubErrorText, type ClientErrorKind } from "./clientErrors";

declare const __APP_BUILD__: string | undefined;

const MAX_PER_PAGE = 5;
const sent = new Set<string>();

/** Версия сборки: задаётся при vite build (vite.config.ts), в разработке — «dev». */
export const appBuild = (): string => (typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "dev");

function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  return "Неизвестная ошибка";
}

export function reportClientError(raw: string, kind: ClientErrorKind, source?: string): void {
  if (ignoredError(raw, source)) return;
  const message = scrubErrorText(raw);
  const path = scrubErrorPath(window.location.pathname);
  const key = `${kind}|${message}|${path}`;
  if (!message || sent.has(key) || sent.size >= MAX_PER_PAGE) return;
  sent.add(key);
  // Отчёт об ошибке не должен сам ронять интерфейс: сбой отправки — молча.
  convex.mutation(api.clientErrors.report, { message, path, build: scrubBuild(appBuild()), kind }).catch(() => undefined);
}

let installed = false;

export function installErrorReporting(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    // Ошибки загрузки картинок и скриптов приходят без error и message — это не сбой кода.
    if (!e.message && !e.error) return;
    reportClientError(e.error ? errorMessage(e.error) : e.message, "error", e.filename);
  });
  window.addEventListener("unhandledrejection", (e) => reportClientError(errorMessage(e.reason), "rejection"));
}
