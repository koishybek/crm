// Права ключей публичного API (ТЗ п.20.7, п.26.7): что ключ может делать. Общие для сервера (convex/apiKeys.ts,
// convex/publicApi.ts) и карточки «API и сайт».

export const API_SCOPES = ["leads:write", "leads:read", "orders:read", "services:read"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_LABEL: Record<ApiScope, { label: string; hint: string }> = {
  "leads:write": { label: "Создавать заявки", hint: "POST /api/v1/leads" },
  "leads:read": { label: "Статус своих заявок", hint: "GET /api/v1/leads/{номер}" },
  "orders:read": { label: "Статус заказов", hint: "GET /api/v1/orders/{номер} — без контактов и денег" },
  "services:read": { label: "Справочник услуг", hint: "GET /api/v1/services" },
};

/** Ключи, созданные до появления прав, работали только с заявками — так и остаётся. */
export const LEGACY_SCOPES: readonly ApiScope[] = ["leads:write", "leads:read"];

export const isApiScope = (s: string): s is ApiScope => (API_SCOPES as readonly string[]).includes(s);

/** Права ключа из базы: неизвестные значения отбрасываем, нет поля — права старого ключа. */
export const scopesOf = (stored: readonly string[] | undefined): ApiScope[] => (stored ? stored.filter(isApiScope) : [...LEGACY_SCOPES]);
