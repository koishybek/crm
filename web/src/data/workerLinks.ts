// Ссылки наружу из кабинета мастера: звонок, карты, поддержка. Чистые функции — проверяются тестами.
import { digits } from "../lib/format";

/** Телефон поддержки (офис компании): профиль, экран заказа, экран ошибки. */
export const SUPPORT_PHONE = "+7 727 345 00 00";

/** «8 701 123 45 67», «+7 (701) 123-45-67», «7011234567» → «tel:+77011234567». Странный формат — как есть. */
export function telHref(raw: string): string {
  let d = digits(raw);
  if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
  if (d.length === 10) d = `7${d}`;
  return d.length === 11 ? `tel:+${d}` : `tel:${d}`;
}

export const SUPPORT_TEL = telHref(SUPPORT_PHONE);

// Квартира, подъезд, этаж, домофон и офис путают геопоиск — для карт отрезаем хвост, начиная с них.
const UNIT_TAIL = /,\s*(?:кв(?:\.|артира)?\s*№?\s*\d|подъезд|под\.\s*\d|этаж|эт\.\s*\d|домофон|офис|оф\.\s*\d)[\s\S]*$/iu;

/** Адрес для карт: «мкр. Самал-2, д. 58, кв. 14, подъезд 2» → «мкр. Самал-2, д. 58»; город в начале убираем. */
export function mapAddress(city: string, address: string): string {
  const addr = address.replace(UNIT_TAIL, "").trim();
  const cityPrefix = new RegExp(`^${city.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*,\\s*`, "iu");
  return city.trim() ? addr.replace(cityPrefix, "").trim() : addr;
}

/** Города, для которых 2ГИС открывает поиск сразу в нужном городе (проверены по сайту 2gis.kz). */
const TWO_GIS_SLUG: Record<string, string> = { алматы: "almaty", астана: "astana", шымкент: "shymkent", караганда: "karaganda" };

const query = (city: string, address: string) => {
  const addr = mapAddress(city, address);
  return addr ? `${city.trim()}, ${addr}` : city.trim();
};

/** Поиск адреса в 2ГИС. Город не из списка — запрос «город, адрес» без города в пути. */
export function twoGisUrl(city: string, address: string): string {
  const slug = TWO_GIS_SLUG[city.trim().toLowerCase()];
  const addr = mapAddress(city, address);
  if (slug && addr) return `https://2gis.kz/${slug}/search/${encodeURIComponent(addr)}`;
  return `https://2gis.kz/search/${encodeURIComponent(query(city, address))}`;
}

/** Поиск адреса в Яндекс Картах (параметр text документирован). */
export function yandexMapsUrl(city: string, address: string): string {
  return `https://yandex.kz/maps/?text=${encodeURIComponent(query(city, address))}`;
}

export type MapApp = "2gis" | "yandex";

export const MAP_APPS: Record<MapApp, { label: string; url: (city: string, address: string) => string }> = {
  "2gis": { label: "2ГИС", url: twoGisUrl },
  yandex: { label: "Яндекс Карты", url: yandexMapsUrl },
};
