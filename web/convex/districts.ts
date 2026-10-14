// Справочник районов городов (ТЗ п.12.3 «территория»): читают сотрудники (формы заявки, заказа и мастера),
// правит владелец в «Настройках». Мастера и заказы со старыми районами не трогаем: район, которого больше нет
// в справочнике, просто перестаёт предлагаться в формах.
import { ConvexError, v } from "convex/values";
import { mutation, query } from "./lib/functions";
import { OWNER, requireRole, TEAM } from "./lib/access";
import { audit, listDiff, listDiffText } from "./lib/audit";
import { cleanDistrictMap, DISTRICTS_KEY, loadDistricts } from "./lib/districts";
import { DEFAULT_DISTRICTS, fromDistrictList, toDistrictList, type DistrictList, type DistrictMap } from "../src/data/cities";

/** Справочник: города с районами. */
export const list = query({
  args: {},
  handler: async (ctx): Promise<DistrictList> => {
    await requireRole(ctx, TEAM);
    return toDistrictList(await loadDistricts(ctx));
  },
});

/** Сохранить справочник целиком (только владелец); null — вернуть районы по умолчанию. Изменения — в журнал. */
export const save = mutation({
  args: { list: v.union(v.array(v.object({ city: v.string(), districts: v.array(v.string()) })), v.null()) },
  handler: async (ctx, { list }): Promise<DistrictList> => {
    const me = await requireRole(ctx, OWNER);
    if (list && list.length > 50) throw new ConvexError("Слишком много городов");
    const r = cleanDistrictMap(list ? fromDistrictList(list) : DEFAULT_DISTRICTS);
    if (!r.ok) throw new ConvexError(r.error);
    const before = await loadDistricts(ctx);
    const changes = cityChanges(before, r.map);
    if (!changes.length) return toDistrictList(before);
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", DISTRICTS_KEY))
      .unique();
    const value = JSON.stringify(r.map);
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key: DISTRICTS_KEY, value });
    await audit(ctx, me, "settings.districts", `Справочник районов ${list === null ? "сброшен к районам по умолчанию" : "изменён"}: ${changes.join("; ")}`.slice(0, 500), {
      meta: { cities: Object.keys(r.map).length },
    });
    return toDistrictList(r.map);
  },
});

/** «Алматы: +«Новый», −«Старый»» — что поменялось по городам. */
function cityChanges(before: DistrictMap, after: DistrictMap): string[] {
  const cities = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const out: string[] = [];
  for (const city of cities) {
    const d = listDiff(before[city] ?? [], after[city] ?? []);
    if (!d.added.length && !d.removed.length) continue;
    out.push(`${city}: ${listDiffText(d)}`);
  }
  return out;
}
