import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { assertScope, inScope, requireRole, scopeOf, TEAM, type Me } from "./lib/access";
import { cleanPhone, insertClient } from "./clients";
import { log, nextNumber, notify, nowIso, refreshClient, staffIds, TENANT, userActor } from "./lib/domain";
import { toLead, toOrder } from "./lib/dto";
import { loadCatalog } from "./catalog";
import { aiSummary, source, urgency } from "./schema";

const CAP = 2000;

/** Направление заявки — по услуге из справочника. */
async function scoped(ctx: Parameters<typeof requireRole>[0], me: Me) {
  const scope = scopeOf(me);
  const cat = scope ? await loadCatalog(ctx) : null;
  return (serviceId: string) => !scope || inScope(scope, cat!.services.find((s) => s.id === serviceId)?.category ?? "");
}

/** Заявки с даты from (ISO) + заказы, созданные из них (для статуса «В работе / Завершена»). */
export const list = query({
  args: { from: v.optional(v.string()) },
  handler: async (ctx, { from }) => {
    const visible = await scoped(ctx, await requireRole(ctx, TEAM));
    const all = await ctx.db
      .query("leads")
      .withIndex("by_created", (q) => (from ? q.gte("createdAt", from) : q))
      .order("desc")
      .take(CAP);
    const leads = all.filter((l) => visible(l.serviceId));
    const orders = await Promise.all(leads.filter((l) => l.orderId).map((l) => ctx.db.get(l.orderId!)));
    return { leads: leads.map(toLead), orders: orders.filter((o) => o !== null).map(toOrder), capped: all.length === CAP };
  },
});

/** Сколько заявок ждут ответа и на квалификации — за всё время (для карточек на экране «Заявки»). */
export const openCounts = query({
  args: {},
  handler: async (ctx) => {
    const visible = await scoped(ctx, await requireRole(ctx, TEAM));
    const count = async (status: "new" | "qualifying" | "waiting") => (await ctx.db.query("leads").withIndex("by_status", (q) => q.eq("status", status)).collect()).filter((l) => visible(l.serviceId)).length;
    return { new: await count("new"), qualifying: (await count("qualifying")) + (await count("waiting")) };
  },
});

export const get = query({
  args: { id: v.id("leads") },
  handler: async (ctx, { id }) => {
    const visible = await scoped(ctx, await requireRole(ctx, TEAM));
    const l = await ctx.db.get(id);
    if (!l || !visible(l.serviceId)) return null;
    const order = l.orderId ? await ctx.db.get(l.orderId) : null;
    return { lead: toLead(l), order: order ? toOrder(order) : null };
  },
});

export const create = mutation({
  args: {
    clientId: v.optional(v.id("clients")),
    clientName: v.string(),
    phone: v.string(),
    source,
    serviceId: v.string(),
    city: v.string(),
    description: v.string(),
    urgency,
    comment: v.optional(v.string()),
    /** AI-разбор (из звонка или вставленного сообщения) — оператор его видел и подтвердил. */
    ai: v.optional(aiSummary),
    callId: v.optional(v.id("calls")),
  },
  handler: async (ctx, a) => {
    const me = await requireRole(ctx, TEAM);
    if (!a.clientName.trim()) throw new ConvexError("Укажите клиента");
    if (!a.description.trim()) throw new ConvexError("Опишите, что нужно сделать");
    const svc = (await loadCatalog(ctx)).service(a.serviceId);
    // Звонок привязываем только один раз: повторная заявка из того же звонка — без связи.
    const found = a.callId ? await ctx.db.get(a.callId) : null;
    const call = found && !found.leadId ? found : null;
    assertScope(me, svc.category);
    const phone = cleanPhone(a.phone);
    // ТЗ п.7: ищем клиента по номеру, иначе создаём.
    let client = a.clientId ? await ctx.db.get(a.clientId) : null;
    if (!client) client = await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", phone)).first();
    const clientId = client?._id ?? (await insertClient(ctx, { name: a.clientName, phone, city: a.city, source: a.source }));
    const c = (await ctx.db.get(clientId))!;
    const at = nowIso();
    const number = await nextNumber(ctx);
    const id = await ctx.db.insert("leads", {
      tenantId: TENANT,
      number,
      clientId,
      clientName: c.name,
      clientPhone: c.phone,
      source: a.source,
      serviceId: a.serviceId,
      city: a.city,
      description: a.description.trim(),
      urgency: a.urgency,
      status: "new",
      operatorId: me._id,
      createdAt: at,
      comment: a.comment?.trim() || undefined,
      ai: a.ai,
      callId: call?._id,
    });
    // Звонок без номера (запись загрузили вручную) получает номер клиента.
    if (call) await ctx.db.patch(call._id, { leadId: id, clientId, clientName: c.name, ...(call.from || call.direction === "out" ? {} : { from: c.phone }) });
    await ctx.db.insert("interactions", { clientId, kind: "lead", channel: a.source, title: "Новая заявка", text: svc.label, at, leadId: id });
    await ctx.db.patch(clientId, { lastActivityAt: at });
    await notify(ctx, await staffIds(ctx, svc.category), `Новая заявка №${number}: ${svc.label}`, { link: `/leads?open=${id}`, except: me._id });
    return { id, number };
  },
});

export const update = mutation({
  args: { id: v.id("leads"), serviceId: v.optional(v.string()), city: v.optional(v.string()), description: v.optional(v.string()), urgency: v.optional(urgency), comment: v.optional(v.string()) },
  handler: async (ctx, { id, ...patch }) => {
    const me = await requireRole(ctx, TEAM);
    const l = await ctx.db.get(id);
    if (!l) throw new ConvexError("Заявка не найдена");
    if (!(await scoped(ctx, me))(l.serviceId)) throw new ConvexError("Это не ваше направление");
    if (patch.serviceId) (await loadCatalog(ctx)).service(patch.serviceId);
    await ctx.db.patch(id, Object.fromEntries(Object.entries(patch).filter(([, x]) => x !== undefined)));
  },
});

export const setStatus = mutation({
  args: { id: v.id("leads"), status: v.union(v.literal("new"), v.literal("qualifying"), v.literal("waiting"), v.literal("rejected")), reason: v.optional(v.string()) },
  handler: async (ctx, { id, status, reason }) => {
    const me = await requireRole(ctx, TEAM);
    const l = await ctx.db.get(id);
    if (!l) throw new ConvexError("Заявка не найдена");
    if (!(await scoped(ctx, me))(l.serviceId)) throw new ConvexError("Это не ваше направление");
    if (l.status === "converted") throw new ConvexError("По заявке уже создан заказ");
    await ctx.db.patch(id, { status, rejectReason: status === "rejected" ? (reason ?? "Без причины") : undefined });
  },
});

/** Заявка → заказ. Номер сохраняется. Цена 0 — оператор указывает её следующим шагом. */
export const convert = mutation({
  args: { id: v.id("leads"), address: v.optional(v.string()) },
  handler: async (ctx, { id, address }) => {
    const me = await requireRole(ctx, TEAM);
    const l = await ctx.db.get(id);
    if (!l) throw new ConvexError("Заявка не найдена");
    if (l.orderId) throw new ConvexError("Заказ уже создан");
    const c = (await ctx.db.get(l.clientId))!;
    const svc = (await loadCatalog(ctx)).service(l.serviceId);
    assertScope(me, svc.category);
    const dl = new Date(Date.now() + 86400_000);
    dl.setUTCHours(7, 0, 0, 0); // 12:00 по Алматы
    const orderId = await ctx.db.insert("orders", {
      tenantId: TENANT,
      number: l.number,
      clientId: l.clientId,
      clientName: c.name,
      clientPhone: c.phone,
      leadId: l._id,
      source: l.source,
      serviceId: l.serviceId,
      category: svc.category,
      description: l.description,
      city: l.city,
      address: address ?? c.address ?? "",
      deadline: dl.toISOString(),
      priority: l.urgency,
      status: "new",
      clientPrice: 0,
      payoutMode: "percent",
      payoutValue: svc.payoutPct,
      payments: [],
      payoutPaid: false,
      createdAt: nowIso(),
      createdBy: me._id,
      files: [],
    });
    await ctx.db.patch(l._id, { status: "converted", orderId });
    await log(ctx, orderId, "created", "Заказ создан из заявки", userActor(me._id));
    await refreshClient(ctx, l.clientId);
    return { id: orderId, number: l.number };
  },
});
