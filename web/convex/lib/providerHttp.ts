// Запросы к API провайдеров (АТС, платежи): таймаут, разбор ответа, ошибки по-русски без секретов и персональных данных.
// Адреса провайдеров зашиты в адаптерах (не приходят снаружи) — SSRF-проверка нужна только ссылкам на файлы (lib/safeFetch.ts).

/** Отказ провайдера или сети — текст можно показать владельцу и сотруднику (без ключей, номеров и сумм). */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderResponse {
  status: number;
  text: string;
}

const TIMEOUT_MS = 15_000;

/** Запрос к провайдеру с таймаутом. Сеть недоступна или нет ответа вовремя — ProviderError. */
export async function providerFetch(url: string, init: RequestInit, label: string, timeoutMs = TIMEOUT_MS): Promise<ProviderResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return { status: res.status, text: await res.text() };
  } catch {
    throw new ProviderError(ctrl.signal.aborted ? `${label}: сервер не ответил вовремя` : `${label}: сервер недоступен`);
  } finally {
    clearTimeout(timer);
  }
}

/** JSON-ответ объектом; не JSON — ProviderError с кодом ответа. */
export function jsonObject(r: ProviderResponse, label: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(r.text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // ниже — общий ответ
  }
  throw new ProviderError(`${label}: неожиданный ответ сервера (HTTP ${r.status})`);
}

/** Строковое поле ответа или undefined. */
export const str = (o: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = o?.[key];
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
};

/** Тело вебхука → плоские поля. form-urlencoded (и multipart) — как есть («callDetails[billsec]»), JSON — с той же скобочной записью вложенных полей. */
export function flatFields(raw: string, contentType: string): Map<string, string> | null {
  const out = new Map<string, string>();
  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const walk = (prefix: string, v: unknown, depth: number) => {
      if (depth > 4) return;
      if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(prefix ? `${prefix}[${k}]` : k, x, depth + 1);
      } else if (v !== null && v !== undefined) out.set(prefix, String(v));
    };
    walk("", parsed, 0);
    return out;
  }
  for (const [k, v] of new URLSearchParams(raw)) out.set(k, v);
  return out;
}

/** То же, что flatFields, плюс multipart/form-data (так шлёт уведомления Freedom Pay). Файлы в уведомлениях не нужны — пропускаем. */
export async function bodyFields(raw: string, contentType: string): Promise<Map<string, string> | null> {
  if (!contentType.includes("multipart/form-data")) return flatFields(raw, contentType);
  try {
    const form = await new Response(raw, { headers: { "content-type": contentType } }).formData();
    const out = new Map<string, string>();
    form.forEach((v, k) => {
      if (typeof v === "string") out.set(k, v);
    });
    return out;
  } catch {
    return null;
  }
}

/** Поле из плоских полей без пробелов по краям; пустое — undefined. */
export const field = (f: Map<string, string>, ...keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = f.get(k)?.trim();
    if (v) return v;
  }
  return undefined;
};
