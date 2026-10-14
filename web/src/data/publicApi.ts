// Заявка с сайта и публичный API: адрес HTTP-эндпоинтов Convex, отправка формы /zayavka, ключи API и сайты (владелец).
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ApiScope } from "./apiScopes";
import { convex, run, type Result } from "./convex";

/**
 * Адрес HTTP-эндпоинтов Convex (…convex.site). Берём из VITE_CONVEX_SITE_URL, иначе выводим из адреса базы
 * (…convex.cloud → …convex.site) — их выставляет `convex deploy` при сборке.
 */
export function siteUrl(): string | null {
  const explicit = (import.meta.env.VITE_CONVEX_SITE_URL as string | undefined)?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const cloud = (import.meta.env.VITE_CONVEX_URL as string | undefined)?.trim();
  return cloud && /\.convex\.cloud\/?$/.test(cloud) ? cloud.replace(/\.convex\.cloud\/?$/, ".convex.site") : null;
}

export interface PublicLeadInput {
  name: string;
  phone: string;
  serviceId?: string;
  city?: string;
  description: string;
  consent: boolean;
  /** Когда открыли форму (мс) — сервер отсекает ботов, которые «заполняют» её мгновенно. */
  startedAt: number;
  /** Поле-ловушка: человек его не видит и не заполняет. */
  website: string;
  utm: Record<string, string>;
}

const errorOf = (body: unknown): string | null =>
  body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;

/** POST /public/lead — тот же эндпоинт, что и для форм на сайте компании. */
export async function submitPublicLead(input: PublicLeadInput): Promise<Result<{ number: number }>> {
  const base = siteUrl();
  if (!base) return { ok: false, error: "Форма временно недоступна — позвоните нам, пожалуйста" };
  const { utm, ...fields } = input;
  try {
    const res = await fetch(`${base}/public/lead`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...fields, ...utm }) });
    const body: unknown = await res.json().catch(() => null);
    const number = body && typeof body === "object" ? (body as { number?: unknown }).number : undefined;
    if (res.ok && typeof number === "number") return { ok: true, value: { number } };
    return { ok: false, error: errorOf(body) ?? "Не получилось отправить заявку — попробуйте ещё раз" };
  } catch {
    return { ok: false, error: "Нет связи с сервером — проверьте интернет и попробуйте ещё раз" };
  }
}

// ── Владелец: ключи API и сайты компании ────────────────────────────────────
export const createApiKey = (name: string, scopes: ApiScope[]) => run(convex.mutation(api.apiKeys.create, { name, scopes }));
export const setApiServicePrices = (enabled: boolean) => run(convex.mutation(api.apiKeys.setServicePrices, { enabled }));
export const revokeApiKey = (id: string) => run(convex.mutation(api.apiKeys.revoke, { id: id as Id<"apiKeys"> }));
export const saveSiteOrigins = (origins: string[]) => run(convex.mutation(api.site.setOrigins, { origins }));
