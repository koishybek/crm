// Импорт из Excel: таблицу разбирает браузер, сюда приходят готовые строки.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, mutation } from "./_generated/server";
import { currentUser, requirePerm, STAFF } from "./lib/access";
import { audit } from "./lib/audit";
import { insertClient } from "./clients";
import { normalizeLogin } from "./lib/login";
import { normalizePhone } from "./lib/phone";
import { createLogin } from "./users";
import { SOURCES, type Category } from "../src/data/catalog";
import { normalizeCity } from "../src/data/cities";
import type { CategoryId, SourceId } from "../src/data/types";

const sourceOf = (s: string | undefined): SourceId => {
  const t = (s ?? "").trim().toLowerCase();
  const hit = (Object.keys(SOURCES) as SourceId[]).find((k) => k === t || SOURCES[k].label.toLowerCase() === t);
  return hit ?? "phone";
};

/** Клиенты: имя, телефон, город, адрес, источник. Дубли по телефону пропускаем. */
export const clients = mutation({
  args: { rows: v.array(v.object({ name: v.string(), phone: v.string(), city: v.optional(v.string()), address: v.optional(v.string()), source: v.optional(v.string()), email: v.optional(v.string()) })) },
  handler: async (ctx, { rows }) => {
    const me = await requirePerm(ctx, "clients.view", STAFF);
    if (rows.length > 1000) throw new ConvexError("Не больше 1000 строк за раз");
    let added = 0;
    let duplicates = 0;
    const skipped: string[] = [];
    for (const r of rows) {
      const phone = normalizePhone(r.phone.slice(0, 40));
      if (!r.name.trim() || !phone) {
        skipped.push(`${r.name || "без имени"}: неверный телефон`);
        continue;
      }
      if (await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", phone)).first()) {
        skipped.push(`${r.name}: уже есть`);
        duplicates++;
        continue;
      }
      // Город — в едином написании (E11): «г. Алматы», «almaty» → «Алматы»; не указан — Алматы.
      const city = normalizeCity(r.city).slice(0, 60) || "Алматы";
      await insertClient(ctx, { name: r.name, phone, city, address: r.address, source: sourceOf(r.source), email: r.email });
      added++;
    }
    // Одна запись на импорт — только числа: сами клиенты и их телефоны остаются в базе, не в журнале.
    await audit(ctx, me, "system.import", `Импорт клиентов из Excel: добавлено ${added}, пропущено ${skipped.length}${duplicates ? ` (уже были — ${duplicates})` : ""}`, {
      meta: { kind: "clients", rows: rows.length, added, skipped: skipped.length, duplicates },
    });
    return { added, skipped };
  },
});

/** Итог импорта исполнителей — из action, у которого нет ctx.db. Автор — владелец, запустивший импорт (его сессия передаётся сюда). */
export const _executorsImported = internalMutation({
  args: { rows: v.number(), created: v.number(), skipped: v.number() },
  handler: async (ctx, a) => {
    await audit(ctx, (await currentUser(ctx)) ?? "Система", "system.import", `Импорт исполнителей из Excel: создано ${a.created}, пропущено ${a.skipped}`, {
      meta: { kind: "executors", ...a },
    });
  },
});

const categoryOf = (categories: Category[], s: string): CategoryId | null => {
  const t = s.trim().toLowerCase();
  if (!t) return null;
  return categories.find((c) => c.id === t || c.label.toLowerCase() === t || c.label.toLowerCase().startsWith(t))?.id ?? null;
};

/** Исполнители: ФИО, телефон, город, специализации (через запятую), навыки. Каждому — логин и пароль. */
export const executors = action({
  args: { rows: v.array(v.object({ name: v.string(), phone: v.string(), city: v.string(), categories: v.string(), skills: v.optional(v.string()) })) },
  handler: async (ctx, { rows }): Promise<{ created: { name: string; login: string; password: string }[]; skipped: string[] }> => {
    const role = await ctx.runQuery(internal.users._viewerRole, {});
    if (role !== "owner") throw new ConvexError("Импорт исполнителей — только владелец");
    if (rows.length > 200) throw new ConvexError("Не больше 200 строк за раз");
    const categories = await ctx.runQuery(internal.catalog._categories, {});
    const created: { name: string; login: string; password: string }[] = [];
    const skipped: string[] = [];
    for (const r of rows) {
      const phone = normalizeLogin(r.phone);
      const cats = r.categories.split(/[,;]/).map((x) => categoryOf(categories, x)).filter((c): c is CategoryId => !!c);
      if (!r.name.trim() || !/^7\d{10}$/.test(phone) || !cats.length) {
        skipped.push(`${r.name || "без имени"}: нужен телефон и хотя бы одна специализация`);
        continue;
      }
      try {
        await ctx.runMutation(internal.executors._insert, {
          name: r.name,
          phone,
          city: normalizeCity(r.city).slice(0, 60) || "Алматы",
          categories: [...new Set(cats)],
          skills: (r.skills ?? "").split(/[,;]/).map((s) => s.trim()).filter(Boolean),
          cooperation: "freelance",
        });
      } catch (e) {
        skipped.push(`${r.name}: ${e instanceof ConvexError ? String(e.data) : "ошибка"}`);
        continue;
      }
      const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
      const password = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join("");
      await createLogin(ctx, phone, password);
      created.push({ name: r.name.trim(), login: phone, password });
    }
    // Каждый новый мастер уже записан в журнал (executor.created); здесь — итог импорта, без паролей.
    await ctx.runMutation(internal.imports._executorsImported, { rows: rows.length, created: created.length, skipped: skipped.length });
    return { created, skipped };
  },
});
