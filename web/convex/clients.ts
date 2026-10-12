import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { requireRole, STAFF } from "./lib/access";
import { nowIso, TENANT } from "./lib/domain";
import { toClient, toInteraction, toLead, toNote, toOrder } from "./lib/dto";
import { normalizeLogin } from "./lib/login";
import { source } from "./schema";

const LIST_LIMIT = 1500;

/** Список клиентов: самые «живые» сверху. Поиск по имени — через поисковый индекс, по телефону — точный. */
export const list = query({
  args: { q: v.optional(v.string()) },
  handler: async (ctx, { q }) => {
    await requireRole(ctx, STAFF);
    const s = (q ?? "").trim();
    if (s) {
      const digits = s.replace(/\D/g, "");
      if (digits.length >= 10) {
        const phone = normalizeLogin(digits);
        const hit = await ctx.db
          .query("clients")
          .withIndex("by_phone", (x) => x.eq("phone", phone))
          .collect();
        return hit.map(toClient);
      }
      const found = await ctx.db
        .query("clients")
        .withSearchIndex("search_name", (x) => x.search("name", s))
        .take(100);
      return found.map(toClient);
    }
    const rows = await ctx.db.query("clients").withIndex("by_activity").order("desc").take(LIST_LIMIT);
    return rows.map(toClient);
  },
});

export const detail = query({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => {
    await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    if (!c) return null;
    const [orders, leads, interactions, notes] = await Promise.all([
      ctx.db.query("orders").withIndex("by_client", (q) => q.eq("clientId", id)).order("desc").take(200),
      ctx.db.query("leads").withIndex("by_client", (q) => q.eq("clientId", id)).order("desc").take(200),
      ctx.db.query("interactions").withIndex("by_client", (q) => q.eq("clientId", id)).order("desc").take(100),
      ctx.db.query("clientNotes").withIndex("by_client", (q) => q.eq("clientId", id)).order("desc").take(50),
    ]);
    return { client: toClient(c), orders: orders.map(toOrder), leads: leads.map(toLead), interactions: interactions.map(toInteraction), notes: notes.map(toNote) };
  },
});

/** Карточка без истории — для форм. */
export const get = query({
  args: { id: v.id("clients") },
  handler: async (ctx, { id }) => {
    await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    return c ? toClient(c) : null;
  },
});

/** Найти клиента по телефону (подсказка в форме заявки). */
export const byPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    await requireRole(ctx, STAFF);
    const p = normalizeLogin(phone);
    if (p.length !== 11) return null;
    const c = await ctx.db
      .query("clients")
      .withIndex("by_phone", (q) => q.eq("phone", p))
      .first();
    return c ? toClient(c) : null;
  },
});

const clientFields = {
  name: v.string(),
  kind: v.optional(v.union(v.literal("person"), v.literal("company"))),
  phone: v.string(),
  email: v.optional(v.string()),
  city: v.string(),
  address: v.optional(v.string()),
  source,
  preferredChannel: v.optional(source),
  notes: v.optional(v.string()),
};

export function cleanPhone(raw: string): string {
  const p = normalizeLogin(raw);
  if (!/^7\d{10}$/.test(p)) throw new ConvexError("Укажите телефон полностью");
  return p;
}

export async function insertClient(ctx: MutationCtx, a: { name: string; kind?: Doc<"clients">["kind"]; phone: string; email?: string; city: string; address?: string; source: Doc<"clients">["source"]; preferredChannel?: Doc<"clients">["source"]; notes?: string }) {
  const at = nowIso();
  return ctx.db.insert("clients", {
    tenantId: TENANT,
    name: a.name.trim(),
    kind: a.kind ?? (/^(ТОО|ИП|АО|ЖК|ОСИ|КСК)\b/.test(a.name.trim()) ? "company" : "person"),
    phone: a.phone,
    email: a.email?.trim() || undefined,
    city: a.city,
    address: a.address?.trim() || undefined,
    source: a.source,
    preferredChannel: a.preferredChannel,
    tags: [],
    notes: a.notes?.trim() || undefined,
    createdAt: at,
    ordersCount: 0,
    activeCount: 0,
    lastActivityAt: at,
  });
}

export const create = mutation({
  args: clientFields,
  handler: async (ctx, a) => {
    await requireRole(ctx, STAFF);
    if (!a.name.trim()) throw new ConvexError("Укажите имя или название компании");
    const phone = cleanPhone(a.phone);
    const dup = await ctx.db
      .query("clients")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (dup) throw new ConvexError("Клиент с таким телефоном уже есть");
    const id = await insertClient(ctx, { ...a, phone });
    return { id, name: a.name.trim() };
  },
});

export const update = mutation({
  args: { id: v.id("clients"), ...clientFields, tags: v.optional(v.array(v.string())) },
  handler: async (ctx, { id, ...a }) => {
    await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Клиент не найден");
    const phone = cleanPhone(a.phone);
    if (phone !== c.phone) {
      const dup = await ctx.db
        .query("clients")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .first();
      if (dup && dup._id !== id) throw new ConvexError("Клиент с таким телефоном уже есть");
    }
    const name = a.name.trim() || c.name;
    await ctx.db.patch(id, {
      name,
      kind: a.kind ?? c.kind,
      phone,
      email: a.email?.trim() || undefined,
      city: a.city,
      address: a.address?.trim() || undefined,
      source: a.source,
      preferredChannel: a.preferredChannel,
      notes: a.notes?.trim() || undefined,
      tags: a.tags ?? c.tags,
    });
    // Имя и телефон скопированы в заявки и заказы — обновляем копии.
    if (name !== c.name || phone !== c.phone) {
      for (const l of await ctx.db.query("leads").withIndex("by_client", (q) => q.eq("clientId", id)).collect()) await ctx.db.patch(l._id, { clientName: name, clientPhone: phone });
      for (const o of await ctx.db.query("orders").withIndex("by_client", (q) => q.eq("clientId", id)).collect()) await ctx.db.patch(o._id, { clientName: name, clientPhone: phone });
    }
  },
});

export const setTags = mutation({
  args: { id: v.id("clients"), tags: v.array(v.string()) },
  handler: async (ctx, { id, tags }) => {
    await requireRole(ctx, STAFF);
    await ctx.db.patch(id, { tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12) });
  },
});

export const addNote = mutation({
  args: { clientId: v.id("clients"), text: v.string() },
  handler: async (ctx, { clientId, text }) => {
    const me = await requireRole(ctx, STAFF);
    if (!text.trim()) throw new ConvexError("Пустой комментарий");
    await ctx.db.insert("clientNotes", { clientId, authorId: me._id, text: text.trim().slice(0, 2000), at: nowIso() });
  },
});
