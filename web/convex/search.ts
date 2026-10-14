import { v } from "convex/values";
import { query } from "./_generated/server";
import { can, inScope, requireRole, scopeOf, TEAM } from "./lib/access";
import { normalizePhone } from "./lib/phone";
import { loadCatalog } from "./catalog";
import { phone as fmtPhone } from "../src/lib/format";

type Hit = { key: string; group: string; title: string; sub: string; to: string };

/** Поиск в шапке: клиенты (имя/телефон), заказы и заявки (номер). */
export const global = query({
  args: { q: v.string() },
  handler: async (ctx, { q }): Promise<Hit[]> => {
    const me = await requireRole(ctx, TEAM);
    const scope = scopeOf(me);
    const s = q.trim();
    if (s.length < 2) return [];
    const digits = s.replace(/\D/g, "");
    const out: Hit[] = [];
    const cat = await loadCatalog(ctx);
    if (!can(me, "clients.view")) {
      // Без права на клиентскую базу (руководитель направления по умолчанию) — только номера своих заказов и заявок.
    } else if (digits.length >= 8 && normalizePhone(s)) {
      const c = await ctx.db.query("clients").withIndex("by_phone", (x) => x.eq("phone", normalizePhone(s)!)).first();
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
