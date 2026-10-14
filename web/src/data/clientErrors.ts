// Ошибки интерфейса для «Состояния системы» (ТЗ п.26.5): что отправляем на сервер и как вычищаем данные людей.
// Правила общие для браузера (src/data/errorReporting.ts) и сервера (convex/clientErrors.ts) — сервер чистит ещё раз.

export const CLIENT_ERROR_MAX = { message: 300, path: 200, build: 40 } as const;

export type ClientErrorKind = "error" | "rejection";

/** Строка списка в «Состоянии системы». */
export interface ClientErrorRow {
  id: string;
  message: string;
  path: string;
  build: string;
  kind: ClientErrorKind;
  role?: string;
  count: number;
  firstAt: string;
  lastAt: string;
}

/**
 * Текст ошибки без персональных данных: адреса почты, номера телефонов, длинные токены и параметры ссылок
 * заменяются метками. Управляющие символы — пробелы, длина — с потолком.
 */
export function scrubErrorText(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(https?:\/\/[^\s?#'"()]+)[?#][^\s'"()]*/g, "$1")
    .replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu, "[email]")
    .replace(/[A-Za-z0-9_-]{32,}/g, "[токен]")
    .replace(/\+?\d[\d\s()-]{6,}\d/g, "[номер]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CLIENT_ERROR_MAX.message);
}

/** Путь экрана без параметров и якоря; номера телефонов в пути — меткой. */
export function scrubErrorPath(raw: string): string {
  const path = raw.split(/[?#]/)[0] ?? "";
  const clean = path.startsWith("/") ? path : "/";
  return clean.replace(/\+?\d[\d-]{6,}\d/g, "[номер]").slice(0, CLIENT_ERROR_MAX.path);
}

/** Версия сборки: буквы, цифры, «.», «-», «_». */
export const scrubBuild = (raw: string): string => raw.replace(/[^\w.-]/g, "").slice(0, CLIENT_ERROR_MAX.build) || "unknown";

/** Шум, который не про наше приложение: расширения браузера, кросс-доменные «Script error.», ResizeObserver. */
export function ignoredError(message: string, source?: string): boolean {
  if (!message.trim()) return true;
  if (/^Script error\.?$/i.test(message.trim())) return true;
  if (/ResizeObserver loop/i.test(message)) return true;
  return !!source && /^(chrome|moz|safari|safari-web)-extension:/i.test(source);
}
