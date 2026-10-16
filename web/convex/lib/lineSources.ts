// Источник по номеру, на который позвонили (колл-трекинг): номер АТС в объявлениях OLX → звонки на него — «OLX».
// Владелец задаёт пары «номер → источник» в «Настройки → Телефония»; заявка из такого звонка получает этот источник,
// и аналитика по источникам видит трафик OLX, а не общий «Телефон».
import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "./functions";
import { SOURCES } from "../../src/data/catalog";
import type { SourceId } from "../../src/data/types";

export const LINE_SOURCES_KEY = "pbx.lineSources";
/** Номеров с источником — с запасом на несколько линий (OLX, сайт, реклама). */
export const MAX_LINES = 20;

/** Номер линии — только цифры; казахстанский «8…» → «7…» (провайдеры присылают по-разному). */
export function normLine(raw: string | undefined | null): string {
  const d = (raw ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("8") ? `7${d.slice(1)}` : d;
}

export const isSourceId = (s: string): s is SourceId => Object.prototype.hasOwnProperty.call(SOURCES, s);

export function parseLineSources(raw: string | undefined): Record<string, SourceId> {
  if (!raw) return {};
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object") return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [string, SourceId] => typeof e[1] === "string" && isSourceId(e[1])));
  } catch {
    return {};
  }
}

export async function lineSources(ctx: QueryCtx): Promise<Record<string, SourceId>> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", LINE_SOURCES_KEY))
    .unique();
  return parseLineSources(row?.value);
}

/** Источник звонка: входящий на номер из списка — его источник; остальные — «Телефон». */
export function sourceOf(c: Pick<Doc<"calls">, "direction" | "to">, lines: Record<string, SourceId>): SourceId {
  if (c.direction !== "in") return "phone";
  return lines[normLine(c.to)] ?? "phone";
}
