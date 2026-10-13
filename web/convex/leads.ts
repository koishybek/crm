import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { assertScope, inScope, requireRole, scopeOf, TEAM, type Me } from "./lib/access";
import { audit, ChangeLog, quote } from "./lib/audit";
import { cleanPhone, insertClient } from "./clients";
import { log, nextNumber, notify, nowIso, refreshClient, staffIds, TENANT, userActor } from "./lib/domain";
import { toLead, toOrder } from "./lib/dto";
import { cleanText } from "./lib/limits";
import { loadCatalog } from "./catalog";
import { aiSummary, source, urgency } from "./schema";
import { LEAD_STATUS, SOURCES, URGENCY } from "../src/data/catalog";
import { shortName } from "../src/lib/format";

const CAP = 2000;
/** Границы полей заявки: описание — до пары страниц, комментарий — до страницы. */
const MAX = { clientName: 120, city: 60, description: 4000, comment: 2000, address: 300, reason: 200 } as const;

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
    const clientName = cleanText(a.clientName, MAX.clientName, "Имя клиента");
    if (!clientName) throw new ConvexError("Укажите клиента");
    const description = cleanText(a.description, MAX.description, "Описание");
    if (!description) throw new ConvexError("Опишите, что нужно сделать");
    const city = cleanText(a.city, MAX.city, "Город");
    if (!city) throw new ConvexError("Укажите город");
    const comment = a.comment === undefined ? undefined : cleanText(a.comment, MAX.comment, "Комментарий") || undefined;
    const svc = (await loadCatalog(ctx)).service(a.serviceId);
    // Звонок привязываем только один раз: повторная заявка из того же звонка — без связи.
    const found = a.callId ? await ctx.db.get(a.callId) : null;
    const call = found && !found.leadId ? found : null;
    assertScope(me, svc.category);
    const phone = cleanPhone(a.phone);
    // ТЗ п.7: ищем клиента по номеру, иначе создаём.
    let client = a.clientId ? await ctx.db.get(a.clientId) : null;
    if (!client) client = await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", phone)).first();
    const isNewClient = !client;
    const clientId = client?._id ?? (await insertClient(ctx, { name: clientName, phone, city, source: a.source }));
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
      city,
      description,
      urgency: a.urgency,
      status: "new",
      operatorId: me._id,
      createdAt: at,
      comment,
      ai: a.ai,
      callId: call?._id,
    });
    // Звонок без номера (запись загрузили вручную) получает номер клиента.
    if (call) await ctx.db.patch(call._id, { leadId: id, clientId, clientName: c.name, ...(call.from || call.direction === "out" ? {} : { from: c.phone }) });
    await ctx.db.insert("interactions", { clientId, kind: "lead", channel: a.source, title: "Новая заявка", text: svc.label, at, leadId: id });
    await ctx.db.patch(clientId, { lastActivityAt: at });
    // Одно действие — одна запись: новый клиент, заведённый вместе с заявкой, отмечен в ней же (ТЗ п.27).
    await audit(ctx, me, "lead.created", `Заявка №${number}: ${svc.label} — ${shortName(c.name)}${isNewClient ? " (новый клиент)" : ""}, ${SOURCES[a.source].label}`, {
      entityId: id,
      meta: { source: a.source, serviceId: a.serviceId, city, urgency: a.urgency, clientId, newClient: isNewClient, callId: call?._id, ai: !!a.ai },
    });
    await notify(ctx, await staffIds(ctx, svc.category), `Новая заявка №${number}: ${svc.label}`, { link: `/leads?open=${id}`, except: me._id });
    return { id, number };
  },
});

type LeadPatch = Partial<Pick<Doc<"leads">, "serviceId" | "city" | "description" | "urgency" | "comment">>;

/** Правка заявки. Ничего не поменялось — ни записи, ни шума в журнале. */
export const update = mutation({
  args: { id: v.id("leads"), serviceId: v.optional(v.string()), city: v.optional(v.string()), description: v.optional(v.string()), urgency: v.optional(urgency), comment: v.optional(v.string()) },
  handler: async (ctx, { id, ...input }) => {
    const me = await requireRole(ctx, TEAM);
    const l = await ctx.db.get(id);
    if (!l) throw new ConvexError("Заявка не найдена");
    if (!(await scoped(ctx, me))(l.serviceId)) throw new ConvexError("Это не ваше направление");
    const cat = await loadCatalog(ctx);
    const patch: LeadPatch = {};
    const log = new ChangeLog();

    if (input.serviceId !== undefined && input.serviceId !== l.serviceId) {
      const svc = cat.service(input.serviceId);
      // Руководитель не может «отдать» заявку в чужое направление — как и заказ (orders.updateInfo).
      assertScope(me, svc.category);
      patch.serviceId = svc.id;
      log.add(`услуга ${quote(cat.label(l.serviceId))} → ${quote(svc.label)}`, "serviceId", { from: l.serviceId, to: svc.id });
    }
    if (input.city !== undefined) {
      const city = cleanText(input.city, MAX.city, "Город");
      if (!city) throw new ConvexError("Укажите город");
      if (city !== l.city) {
        patch.city = city;
        log.add(`город ${l.city} → ${city}`, "city", { from: l.city, to: city });
      }
    }
    if (input.urgency !== undefined && input.urgency !== l.urgency) {
      patch.urgency = input.urgency;
      log.add(`срочность ${URGENCY[l.urgency].label} → ${URGENCY[input.urgency].label}`, "urgency", { from: l.urgency, to: input.urgency });
    }
    // Тексты клиента в журнал не копируем — только отметку, что их правили.
    if (input.description !== undefined) {
      const description = cleanText(input.description, MAX.description, "Описание");
      if (!description) throw new ConvexError("Опишите, что нужно сделать");
      if (description !== l.description) {
        patch.description = description;
        log.add("описание", "description", "изменено");
      }
    }
    if (input.comment !== undefined) {
      const comment = cleanText(input.comment, MAX.comment, "Комментарий");
      if (comment !== (l.comment ?? "")) {
        patch.comment = comment || undefined;
        log.add(comment ? "комментарий" : "комментарий удалён", "comment", comment ? "изменено" : "удалено");
      }
    }
    if (log.empty) return;
    await ctx.db.patch(id, patch);
    await audit(ctx, me, "lead.updated", `Заявка №${l.number}: ${log.text()}`, { entityId: id, meta: { changes: log.changes } });
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
    const why = status === "rejected" ? reason?.trim().slice(0, MAX.reason) || "Без причины" : undefined;
    // Повторное нажатие того же этапа ничего не меняет — и в журнал не пишется.
    if (l.status === status && l.rejectReason === why) return;
    await ctx.db.patch(id, { status, rejectReason: why });
    await audit(
      ctx,
      me,
      status === "rejected" ? "lead.rejected" : "lead.status",
      status === "rejected" ? `Заявка №${l.number}: отказ — ${why}` : `Заявка №${l.number}: «${LEAD_STATUS[l.status].label}» → «${LEAD_STATUS[status].label}»`,
      { entityId: id, meta: { from: l.status, to: status, ...(why ? { reason: why } : {}) } },
    );
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
      address: (address === undefined ? undefined : cleanText(address, MAX.address, "Адрес")) || c.address || "",
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
    await audit(ctx, me, "lead.converted", `Заявка №${l.number} → заказ №${l.number}: ${svc.label}`, { entityId: id, meta: { orderId } });
    await refreshClient(ctx, l.clientId);
    return { id: orderId, number: l.number };
  },
});
