// Справочник районов на сервере (ТЗ п.12.3): хранится в settings («districts», JSON), пока владелец его не правил —
// районы по умолчанию из src/data/cities.ts. Район заказа, заявки и мастера — только из справочника его города.
import { ConvexError } from "convex/values";
import type { QueryCtx } from "./functions";
import { canonicalDistrict, DEFAULT_DISTRICTS, districtKey, districtsOf, DISTRICT_LIMITS, normalizeCity, type DistrictMap } from "../../src/data/cities";

export const DISTRICTS_KEY = "districts";

const defaults = (): DistrictMap => Object.fromEntries(Object.entries(DEFAULT_DISTRICTS).map(([c, list]) => [c, [...list]]));

/** Справочник из настроек; запись испорчена или её нет — районы по умолчанию. */
export async function loadDistricts(ctx: QueryCtx): Promise<DistrictMap> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", DISTRICTS_KEY))
    .unique();
  if (!row) return defaults();
  try {
    const parsed: unknown = JSON.parse(row.value);
    const r = cleanDistrictMap(parsed);
    return r.ok ? r.map : defaults();
  } catch {
    return defaults();
  }
}

/**
 * Справочник от владельца: города — в едином написании, районы — без пустых и повторов, в пределах лимитов.
 * Город без районов из справочника убирается.
 */
export function cleanDistrictMap(input: unknown): { ok: true; map: DistrictMap } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "Неверный формат справочника" };
  const out: DistrictMap = {};
  for (const [rawCity, rawList] of Object.entries(input as Record<string, unknown>)) {
    const city = normalizeCity(rawCity).slice(0, 60);
    if (!city) continue;
    if (!Array.isArray(rawList)) return { ok: false, error: `${city}: список районов — массив названий` };
    const list: string[] = [];
    for (const item of rawList) {
      if (typeof item !== "string") return { ok: false, error: `${city}: название района — текст` };
      const name = item.normalize("NFC").replace(/\s+/g, " ").trim();
      if (!name) continue;
      if (name.length > DISTRICT_LIMITS.name) return { ok: false, error: `${city}: название района длиннее ${DISTRICT_LIMITS.name} символов` };
      if (!list.some((d) => districtKey(d) === districtKey(name))) list.push(name);
    }
    if (list.length > DISTRICT_LIMITS.perCity) return { ok: false, error: `${city}: районов не больше ${DISTRICT_LIMITS.perCity}` };
    if (!list.length) continue;
    out[city] = [...(out[city] ?? []), ...list.filter((d) => !(out[city] ?? []).some((x) => districtKey(x) === districtKey(d)))];
  }
  if (Object.keys(out).length > DISTRICT_LIMITS.cities) return { ok: false, error: `Городов с районами не больше ${DISTRICT_LIMITS.cities}` };
  return { ok: true, map: out };
}

/** Район в написании справочника или отказ с причиной. */
function strictDistrict(map: DistrictMap, city: string, raw: string): string {
  const found = canonicalDistrict(map, city, raw);
  if (!found) throw new ConvexError(districtsOf(map, city).length ? `Района «${raw.slice(0, DISTRICT_LIMITS.name)}» нет в справочнике города ${city}` : `Для города ${city} районы не заданы`);
  return found;
}

/** Район из формы: пусто — без района; не из справочника города — понятный отказ. */
export async function districtFor(ctx: QueryCtx, city: string, raw: string | undefined): Promise<string | undefined> {
  const s = (raw ?? "").trim();
  return s ? strictDistrict(await loadDistricts(ctx), city, s) : undefined;
}

/** Район из автоматического источника (AI-разбор, канал): не из справочника — просто без района. */
export async function districtOrNone(ctx: QueryCtx, city: string, raw: string | undefined): Promise<string | undefined> {
  if (!raw?.trim()) return undefined;
  return canonicalDistrict(await loadDistricts(ctx), city, raw) ?? undefined;
}

/** Районы мастера: только из справочника его города, без повторов. Пусто — весь город. */
export async function executorDistricts(ctx: QueryCtx, city: string, input: readonly string[] | undefined): Promise<string[]> {
  const items = (input ?? []).map((s) => s.trim()).filter(Boolean);
  if (!items.length) return [];
  const map = await loadDistricts(ctx);
  const out: string[] = [];
  for (const raw of items.slice(0, DISTRICT_LIMITS.perCity)) {
    const d = strictDistrict(map, city, raw);
    if (!out.includes(d)) out.push(d);
  }
  return out;
}
