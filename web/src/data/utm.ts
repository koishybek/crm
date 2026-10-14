// Рекламные метки и кампании (ТЗ п.6.6, п.28.5): одно правило чтения utm_* для формы /zayavka, приёма заявки с сайта
// и публичного API. Кампания заявки — явно заданная (поле campaign в API) или utm_campaign.

export const UTM_KEYS = ["source", "medium", "campaign", "content", "term"] as const;
export type UtmKey = (typeof UTM_KEYS)[number];
export type Utm = Partial<Record<UtmKey, string>>;

/** Длина одной метки: длиннее — обрезаем (рекламные системы не шлют больше). */
export const UTM_MAX = 100;

/**
 * Значение метки: строка без управляющих символов, без «=», «+», «-», «@» в начале (метки уходят в выгрузки CSV —
 * Excel принял бы их за формулу), не длиннее UTM_MAX. Пустое и не строка — undefined.
 */
export function cleanUtmValue(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/^[\s=+\-@]+/, "").replace(/\s+/g, " ").trim().slice(0, UTM_MAX).trim();
  return s || undefined;
}

const compact = (u: Utm): Utm | undefined => (UTM_KEYS.some((k) => u[k] !== undefined) ? u : undefined);

/**
 * Метки из тела запроса: плоские поля utm_source… (форма сайта) и/или объект utm { source, … } (API).
 * Плоское поле важнее вложенного. Ничего нет — undefined.
 */
export function utmFromRecord(body: Record<string, unknown>): Utm | undefined {
  const nested = body.utm && typeof body.utm === "object" && !Array.isArray(body.utm) ? (body.utm as Record<string, unknown>) : {};
  const out: Utm = {};
  for (const k of UTM_KEYS) {
    const v = cleanUtmValue(body[`utm_${k}`]) ?? cleanUtmValue(nested[k]) ?? cleanUtmValue(nested[`utm_${k}`]);
    if (v !== undefined) out[k] = v;
  }
  return compact(out);
}

/** Метки из адреса страницы («?utm_source=instagram&utm_campaign=ac-oct»). Сниппет встраивания передаёт в iframe адрес родителя. */
export function utmFromSearch(search: string): Utm | undefined {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const out: Utm = {};
  for (const k of UTM_KEYS) {
    const v = cleanUtmValue(params.get(`utm_${k}`));
    if (v !== undefined) out[k] = v;
  }
  return compact(out);
}

/** Плоские поля utm_* для отправки формы. */
export const utmParams = (u: Utm | undefined): Record<string, string> =>
  Object.fromEntries(UTM_KEYS.filter((k) => u?.[k] !== undefined).map((k) => [`utm_${k}`, u![k]!]));

/** Кампания обращения: явно заданная или utm_campaign. */
export const campaignOf = (utm: Utm | undefined, explicit?: string): string | undefined => cleanUtmValue(explicit) ?? utm?.campaign;

/** «utm_source=instagram, utm_campaign=ac-oct» — для комментария заявки и подсказок. */
export const utmText = (u: Utm | undefined): string =>
  UTM_KEYS.filter((k) => u?.[k] !== undefined)
    .map((k) => `utm_${k}=${u![k]}`)
    .join(", ");
