import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import { assertScope, inScope, requireRole, scopeOf, TEAM, type Me } from "./lib/access";
import { almatyStamp, audit, ChangeLog, quote } from "./lib/audit";
import { assertNotErased, cleanPhone, insertClient } from "./clients";
import { log, nextNumber, notify, nowIso, refreshClient, staffIds, TENANT, userActor } from "./lib/domain";
import { toLead, toOrder } from "./lib/dto";
import { cleanCity, cleanMoney, cleanText } from "./lib/limits";
import { loadCatalog } from "./catalog";
import { emitEvent } from "./lib/webhookEvents";
import { aiSummary, source, urgency } from "./schema";
import { LEAD_STATUS, SOURCES, URGENCY } from "../src/data/catalog";
import { deadlineByUrgency } from "../src/data/leadRules";
import { money, shortName } from "../src/lib/format";

const CAP = 2000;
/** Границы полей заявки: описание — до пары страниц, комментарий — до страницы. */
const MAX = { clientName: 120, description: 4000, comment: 2000, address: 300, preferredTime: 120, reason: 200 } as const;

/** Направление заявки — по услуге из справочника. */
async function scoped(ctx: Parameters<typeof requireRole>[0], me: Me) {
  const scope = scopeOf(me);
  const cat = scope ? await loadCatalog(ctx) : null;
  return (serviceId: string) => !scope || inScope(scope, cat!.services.find((s) => s.id === serviceId)?.category ?? "");
}

/** Необязательный текст формы: пустой — undefined, длинный — понятная ошибка. */
const optionalText = (s: string | undefined, max: number, label: string) => (s === undefined ? undefined : cleanText(s, max, label) || undefined);
/** Бюджет клиента: целые тенге; 0 и пусто — «не назван». */
const optionalBudget = (n: number | undefined) => (n === undefined ? undefined : cleanMoney(n, "Бюджет") || undefined);

/**
 * Первое действие сотрудника по заявке (ТЗ п.17, E12): отметка для сроков реакции; claim — заявку из канала, которую
 * никто не вёл, берёт в работу тот, кто по ней действует (этап, отказ, заказ). Правка полей заявку не присваивает.
 */
function touch(l: Doc<"leads">, me: Me, claim: boolean): Partial<Doc<"leads">> {
  return { ...(l.firstActionAt ? {} : { firstActionAt: nowIso() }), ...(claim && !l.operatorId ? { operatorId: me._id } : {}) };
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
    /** Структурные данные обращения (ТЗ п.8): адрес, удобное клиенту время, бюджет (только сотрудникам). */
    address: v.optional(v.string()),
    preferredTime: v.optional(v.string()),
    budget: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const me = await requireRole(ctx, TEAM);
    // У руководителя направления клиентской базы нет: клиента он не выбирает по id, только вводит телефон (аудит M-7).
    if (a.clientId && scopeOf(me)) throw new ConvexError("Руководитель направления не выбирает клиента из базы — укажите телефон");
    const clientName = cleanText(a.clientName, MAX.clientName, "Имя клиента");
    if (!clientName) throw new ConvexError("Укажите клиента");
    const description = cleanText(a.description, MAX.description, "Описание");
    if (!description) throw new ConvexError("Опишите, что нужно сделать");
    const city = cleanCity(a.city);
    const comment = optionalText(a.comment, MAX.comment, "Комментарий");
    const address = optionalText(a.address, MAX.address, "Адрес");
    const preferredTime = optionalText(a.preferredTime, MAX.preferredTime, "Удобное время");
    const budget = optionalBudget(a.budget);
    const svc = (await loadCatalog(ctx)).service(a.serviceId);
    // Звонок привязываем только один раз: повторная заявка из того же звонка — без связи.
    const found = a.callId ? await ctx.db.get(a.callId) : null;
    const call = found && !found.leadId ? found : null;
    assertScope(me, svc.category);
    const phone = cleanPhone(a.phone);
    // ТЗ п.7: ищем клиента по номеру, иначе создаём.
    let client = a.clientId ? await ctx.db.get(a.clientId) : null;
    if (!client) client = await ctx.db.query("clients").withIndex("by_phone", (q) => q.eq("phone", phone)).first();
    if (client) assertNotErased(client);
    const isNewClient = !client;
    const clientId = client?._id ?? (await insertClient(ctx, { name: clientName, phone, city, address, source: a.source }));
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
      // Заявку завёл сотрудник — он её и ведёт; заведение — уже первое действие.
      operatorId: me._id,
      origin: "operator",
      firstActionAt: at,
      createdAt: at,
      comment,
      ai: a.ai,
      callId: call?._id,
      address,
      preferredTime,
      budget,
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
    await notify(ctx, await staffIds(ctx, svc.category), `Новая заявка №${number}: ${svc.label}`, { link: `/leads?open=${id}`, except: me._id, email: { kind: "lead_new" } });
    await emitEvent(ctx, "lead.created", { leadId: id });
    return { id, number };
  },
});

/** Заявку, которая стала заказом или закрыта отказом, сервер не правит (E24): иначе заявка и заказ разойдутся. */
function assertEditable(l: Doc<"leads">): void {
  if (l.status === "converted") throw new ConvexError("По заявке уже создан заказ — правьте заказ");
  if (l.status === "rejected") throw new ConvexError("Заявка закрыта отказом — сначала верните её в работу");
}

/**
 * «Взять в работу» (E12): заявку из канала (бот, сайт, API, WhatsApp, OLX, AI) никто не ведёт, пока её не возьмёт
 * оператор. Новая заявка переходит в «Квалификацию». Взятую другим — не перехватываем.
 */
export const take = mutation({
  args: { id: v.id("leads") },
  handler: async (ctx, { id }) => {
    const me = await requireRole(ctx, TEAM);
    const l = await ctx.db.get(id);
    if (!l) throw new ConvexError("Заявка не найдена");
    if (!(await scoped(ctx, me))(l.serviceId)) throw new ConvexError("Это не ваше направление");
    assertEditable(l);
    if (l.operatorId === me._id) return;
    if (l.operatorId) {
      const who = await ctx.db.get(l.operatorId);
      throw new ConvexError(`Заявку уже ведёт ${who?.name ? shortName(who.name) : "другой сотрудник"}`);
    }
    const status = l.status === "new" ? "qualifying" : l.status;
    await ctx.db.patch(id, { operatorId: me._id, status, ...touch(l, me, false) });
    if (status !== l.status) await emitEvent(ctx, "lead.status_changed", { leadId: id, from: l.status });
    const waited = Date.now() - Date.parse(l.createdAt);
    await audit(ctx, me, "lead.taken", `Заявка №${l.number}: взята в работу${status !== l.status ? `, «${LEAD_STATUS[l.status].label}» → «${LEAD_STATUS[status].label}»` : ""}`, {
      entityId: id,
      meta: { origin: l.origin, waitedMin: Math.max(0, Math.round(waited / 60_000)), ...(status !== l.status ? { from: l.status, to: status } : {}) },
    });
  },
});

type LeadPatch = Partial<Pick<Doc<"leads">, "serviceId" | "city" | "description" | "urgency" | "comment" | "address" | "preferredTime" | "budget">>;

/** Правка заявки. Ничего не поменялось — ни записи, ни шума в журнале. */
export const update = mutation({
  args: {
    id: v.id("leads"),
    serviceId: v.optional(v.string()),
    city: v.optional(v.string()),
    description: v.optional(v.string()),
    urgency: v.optional(urgency),
    comment: v.optional(v.string()),
    address: v.optional(v.string()),
    preferredTime: v.optional(v.string()),
    /** null — бюджет убрать. */
    budget: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, { id, ...input }) => {
    const me = await requireRole(ctx, TEAM);
    const l = await ctx.db.get(id);
    if (!l) throw new ConvexError("Заявка не найдена");
    if (!(await scoped(ctx, me))(l.serviceId)) throw new ConvexError("Это не ваше направление");
    assertEditable(l);
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
      const city = cleanCity(input.city);
      if (city !== l.city) {
        patch.city = city;
        log.add(`город ${l.city} → ${city}`, "city", { from: l.city, to: city });
      }
    }
    if (input.urgency !== undefined && input.urgency !== l.urgency) {
      patch.urgency = input.urgency;
      log.add(`срочность ${URGENCY[l.urgency].label} → ${URGENCY[input.urgency].label}`, "urgency", { from: l.urgency, to: input.urgency });
    }
    // Тексты клиента (описание, адрес, удобное время) в журнал не копируем — только отметку, что их правили.
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
    if (input.address !== undefined) {
      const address = optionalText(input.address, MAX.address, "Адрес");
      if (address !== l.address) {
        patch.address = address;
        log.add(address ? "адрес" : "адрес удалён", "address", address ? "изменено" : "удалено");
      }
    }
    if (input.preferredTime !== undefined) {
      const preferredTime = optionalText(input.preferredTime, MAX.preferredTime, "Удобное время");
      if (preferredTime !== l.preferredTime) {
        patch.preferredTime = preferredTime;
        log.add(preferredTime ? "удобное время" : "удобное время удалено", "preferredTime", preferredTime ? "изменено" : "удалено");
      }
    }
    if (input.budget !== undefined) {
      const budget = input.budget === null ? undefined : optionalBudget(input.budget);
      if (budget !== l.budget) {
        patch.budget = budget;
        log.add(`бюджет ${l.budget ? money(l.budget) : "—"} → ${budget ? money(budget) : "—"}`, "budget", { from: l.budget ?? null, to: budget ?? null });
      }
    }
    if (log.empty) return;
    await ctx.db.patch(id, { ...patch, ...touch(l, me, false) });
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
    await ctx.db.patch(id, { status, rejectReason: why, ...touch(l, me, true) });
    if (status !== l.status) await emitEvent(ctx, "lead.status_changed", { leadId: id, from: l.status });
    await audit(
      ctx,
      me,
      status === "rejected" ? "lead.rejected" : "lead.status",
      status === "rejected" ? `Заявка №${l.number}: отказ — ${why}` : `Заявка №${l.number}: «${LEAD_STATUS[l.status].label}» → «${LEAD_STATUS[status].label}»`,
      { entityId: id, meta: { from: l.status, to: status, ...(why ? { reason: why } : {}) } },
    );
  },
});

/**
 * Заявка → заказ. Номер сохраняется. Цена 0 — оператор указывает её следующим шагом. Адрес — из формы, из заявки
 * (AI-разбор обращения) или из карточки клиента; срок — из формы или по срочности (E27); удобное клиенту время —
 * в истории заказа подсказкой.
 */
export const convert = mutation({
  args: { id: v.id("leads"), address: v.optional(v.string()), deadline: v.optional(v.string()) },
  handler: async (ctx, { id, address, deadline }) => {
    const me = await requireRole(ctx, TEAM);
    const l = await ctx.db.get(id);
    if (!l) throw new ConvexError("Заявка не найдена");
    if (l.orderId) throw new ConvexError("Заказ уже создан");
    if (l.status === "rejected") throw new ConvexError("Заявка закрыта отказом — сначала верните её в работу");
    const c = (await ctx.db.get(l.clientId))!;
    const svc = (await loadCatalog(ctx)).service(l.serviceId);
    assertScope(me, svc.category);
    let due = deadlineByUrgency(l.urgency, Date.now());
    if (deadline !== undefined) {
      const t = Date.parse(deadline);
      if (!Number.isFinite(t)) throw new ConvexError("Неверная дата срока");
      due = new Date(t).toISOString();
    }
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
      address: (address === undefined ? undefined : cleanText(address, MAX.address, "Адрес")) || l.address || c.address || "",
      deadline: due,
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
      // Метки рекламы и кампания переходят в заказ (ТЗ п.28.5): выручка кампании считается по заказам.
      ...(l.utm ? { utm: l.utm } : {}),
      ...(l.campaign ? { campaign: l.campaign } : {}),
    });
    await ctx.db.patch(l._id, { status: "converted", orderId, ...touch(l, me, true) });
    await emitEvent(ctx, "lead.status_changed", { leadId: l._id, from: l.status });
    await emitEvent(ctx, "order.created", { orderId });
    const hint = l.preferredTime ? `. Клиенту удобно: ${l.preferredTime}` : "";
    await log(ctx, orderId, "created", `Заказ создан из заявки, срок ${almatyStamp(due)}${hint}`, userActor(me._id));
    await audit(ctx, me, "lead.converted", `Заявка №${l.number} → заказ №${l.number}: ${svc.label}`, { entityId: id, meta: { orderId, deadline: due, deadlineBy: deadline === undefined ? l.urgency : "manual" } });
    await refreshClient(ctx, l.clientId);
    return { id: orderId, number: l.number };
  },
});
