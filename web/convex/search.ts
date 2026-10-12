import { v } from "convex/values";
import { query } from "./_generated/server";
import { inScope, requireRole, scopeOf, TEAM } from "./lib/access";
import { normalizeLogin } from "./lib/login";
import { loadCatalog } from "./catalog";
import { phone as fmtPhone } from "../src/lib/format";

type Hit = { key: string; group: string; title: string; sub: string; to: string };

/** Поиск в шапке: клиенты (имя/телефон), заказы и заявки (номер). */
export const global = query({
  args: { q: v.string() },
  handler: async (ctx, { q }): Promise<Hit[]> => {
    const scope = scopeOf(await requireRole(ctx, TEAM));
    const s = q.trim();
    if (s.length < 2) return [];
    const digits = s.replace(/\D/g, "");
    const out: Hit[] = [];
    const cat = await loadCatalog(ctx);
    if (scope) {
      // Руководитель направления клиентскую базу не видит — только номера своих заказов и заявок.
    } else if (digits.length >= 10) {
      const c = await ctx.db.query("clients").withIndex("by_phone", (x) => x.eq("phone", normalizeLogin(digits))).first();
      if (c) out.push({ key: c._id, group: "Клиенты", title: c.name, sub: `${fmtPhone(c.phone)} · ${c.city}`, to: `/clients/${c._id}` });
    } else if (!/^\d+$/.test(s)) {
      for (const c of await ctx.db.query("clients").withSearchIndex("search_name", (x) => x.search("name", s)).take(5)) {
        out.push({ key: c._id, group: "Клиенты", title: c.name, sub: `${fmtPhone(c.phone)} · ${c.city}`, to: `/clients/${c._id}` });
      }
    }
    if (/^\d{2,6}$/.test(digits) && digits.length < 7) {
      const n = Number(digits);
      const o = await ctx.db.query("orders").withIndex("by_number", (x) => x.eq("number", n)).first();
      if (o && inScope(scope, o.category)) out.push({ key: o._id, group: "Заказы", title: `Заказ №${o.number}`, sub: `${o.clientName} · ${cat.label(o.serviceId)}`, to: `/orders/${o._id}` });
      const l = await ctx.db.query("leads").withIndex("by_number", (x) => x.eq("number", n)).first();
      if (l && !l.orderId && inScope(scope, cat.services.find((x) => x.id === l.serviceId)?.category ?? "")) out.push({ key: l._id, group: "Заявки", title: `Заявка №${l.number}`, sub: `${l.clientName} · ${cat.label(l.serviceId)}`, to: `/leads?open=${l._id}` });
    }
    return out;
  },
});
