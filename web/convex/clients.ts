import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { mutation, query, type MutationCtx } from "./_generated/server";
import { OWNER, requireRole, STAFF } from "./lib/access";
import { audit, ChangeLog, listDiff, listDiffText, maskPhone, quote } from "./lib/audit";
import { nowIso, TENANT } from "./lib/domain";
import { toClient, toInteraction, toLead, toNote, toOrder } from "./lib/dto";
import { cleanText } from "./lib/limits";
import { normalizeLogin } from "./lib/login";
import { assertCanErase, eraseClient } from "./lib/privacy";
import { source } from "./schema";
import { SOURCES } from "../src/data/catalog";
import { phone as fmtPhone, shortName } from "../src/lib/format";

const LIST_LIMIT = 1500;
/** Границы полей карточки клиента. */
const MAX = { name: 120, email: 120, city: 60, address: 300, notes: 2000, note: 2000, tag: 40 } as const;
const MAX_TAGS = 12;
const KIND: Record<Doc<"clients">["kind"], string> = { person: "частное лицо", company: "компания" };

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

/** Обезличенная карточка не меняется: иначе в «удалённого» клиента снова попали бы чьи-то данные. */
export function assertNotErased(c: Pick<Doc<"clients">, "anonymizedAt">): void {
  if (c.anonymizedAt) throw new ConvexError("Данные клиента удалены по его запросу — карточку изменить нельзя. Если он обратился снова, заведите его как нового клиента");
}

/** Необязательное поле формы: пустое — undefined, длинное — понятная ошибка. */
const optionalText = (s: string | undefined, max: number, label: string) => (s === undefined ? undefined : cleanText(s, max, label) || undefined);

/**
 * Теги клиента: без пустых и повторов (регистр не важен), каждый — не длиннее 40 символов, всего — не больше 12.
 * Лишнее не обрезаем молча: человек должен понять, почему тег не добавился.
 */
function cleanTags(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, 100)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.length > MAX.tag) throw new ConvexError(`Тег «${t.slice(0, 20)}…» длиннее ${MAX.tag} символов`);
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  if (out.length > MAX_TAGS || input.length > 100) throw new ConvexError(`Не больше ${MAX_TAGS} тегов`);
  return out;
}

/**
 * Новый клиент — общий шаг для формы, заявки, бота, AI и импорта. Данные из каналов (имя в Telegram,
 * имя от AI) обрезаем по границам молча: заявка клиента не должна теряться из-за длинного имени.
 */
export async function insertClient(ctx: MutationCtx, a: { name: string; kind?: Doc<"clients">["kind"]; phone: string; email?: string; city: string; address?: string; source: Doc<"clients">["source"]; preferredChannel?: Doc<"clients">["source"]; notes?: string }) {
  const at = nowIso();
  const name = a.name.trim().slice(0, MAX.name);
  return ctx.db.insert("clients", {
    tenantId: TENANT,
    name,
    kind: a.kind ?? (/^(ТОО|ИП|АО|ЖК|ОСИ|КСК)\b/.test(name) ? "company" : "person"),
    phone: a.phone,
    email: a.email?.trim().slice(0, MAX.email) || undefined,
    city: a.city.trim().slice(0, MAX.city),
    address: a.address?.trim().slice(0, MAX.address) || undefined,
    source: a.source,
    preferredChannel: a.preferredChannel,
    tags: [],
    notes: a.notes?.trim().slice(0, MAX.notes) || undefined,
    createdAt: at,
    ordersCount: 0,
    activeCount: 0,
    lastActivityAt: at,
  });
}

export const create = mutation({
  args: clientFields,
  handler: async (ctx, a) => {
    const me = await requireRole(ctx, STAFF);
    const name = cleanText(a.name, MAX.name, "Имя");
    if (!name) throw new ConvexError("Укажите имя или название компании");
    const city = cleanText(a.city, MAX.city, "Город");
    if (!city) throw new ConvexError("Укажите город");
    const phone = cleanPhone(a.phone);
    const dup = await ctx.db
      .query("clients")
      .withIndex("by_phone", (q) => q.eq("phone", phone))
      .first();
    if (dup) throw new ConvexError("Клиент с таким телефоном уже есть");
    const id = await insertClient(ctx, {
      ...a,
      name,
      city,
      phone,
      email: optionalText(a.email, MAX.email, "Email"),
      address: optionalText(a.address, MAX.address, "Адрес"),
      notes: optionalText(a.notes, MAX.notes, "Заметки"),
    });
    await audit(ctx, me, "client.created", `Добавлен клиент ${name}`, { entityId: id, meta: { source: a.source, city } });
    return { id, name };
  },
});

export const update = mutation({
  args: { id: v.id("clients"), ...clientFields, tags: v.optional(v.array(v.string())) },
  handler: async (ctx, { id, ...a }) => {
    const me = await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Клиент не найден");
    assertNotErased(c);
    const phone = cleanPhone(a.phone);
    if (phone !== c.phone) {
      const dup = await ctx.db
        .query("clients")
        .withIndex("by_phone", (q) => q.eq("phone", phone))
        .first();
      if (dup && dup._id !== id) throw new ConvexError("Клиент с таким телефоном уже есть");
    }
    const city = cleanText(a.city, MAX.city, "Город");
    if (!city) throw new ConvexError("Укажите город");
    const next = {
      name: cleanText(a.name, MAX.name, "Имя") || c.name,
      kind: a.kind ?? c.kind,
      phone,
      email: optionalText(a.email, MAX.email, "Email"),
      city,
      address: optionalText(a.address, MAX.address, "Адрес"),
      source: a.source,
      preferredChannel: a.preferredChannel,
      notes: optionalText(a.notes, MAX.notes, "Заметки"),
      tags: a.tags ? cleanTags(a.tags) : c.tags,
    };

    // Что поменялось — человеку в журнал. Контакты в деталях — только отметкой или последними цифрами телефона.
    const log = new ChangeLog();
    const channel = (s: Doc<"clients">["preferredChannel"]) => (s ? SOURCES[s].label : "не указан");
    if (next.name !== c.name) log.add(`имя ${quote(c.name)} → ${quote(next.name)}`, "name", "изменено");
    if (next.kind !== c.kind) log.add(`тип ${KIND[c.kind]} → ${KIND[next.kind]}`, "kind", { from: c.kind, to: next.kind });
    if (next.phone !== c.phone) log.add(`телефон ${fmtPhone(c.phone)} → ${fmtPhone(next.phone)}`, "phone", { from: maskPhone(c.phone), to: maskPhone(next.phone) });
    if (next.email !== c.email) log.add("email", "email", "изменено");
    if (next.city !== c.city) log.add(`город ${c.city} → ${next.city}`, "city", { from: c.city, to: next.city });
    if (next.address !== c.address) log.add(`адрес ${quote(c.address)} → ${quote(next.address)}`, "address", "изменено");
    if (next.source !== c.source) log.add(`источник ${SOURCES[c.source].label} → ${SOURCES[next.source].label}`, "source", { from: c.source, to: next.source });
    if (next.preferredChannel !== c.preferredChannel) log.add(`способ связи ${channel(c.preferredChannel)} → ${channel(next.preferredChannel)}`, "preferredChannel", { from: c.preferredChannel, to: next.preferredChannel });
    if (next.notes !== c.notes) log.add("заметки", "notes", "изменено");
    const tags = listDiff(c.tags, next.tags);
    if (tags.added.length || tags.removed.length) log.add(`теги ${listDiffText(tags)}`, "tags", tags);
    if (log.empty) return;

    await ctx.db.patch(id, next);
    // Имя и телефон скопированы в заявки и заказы — обновляем копии.
    if (next.name !== c.name || phone !== c.phone) {
      for (const l of await ctx.db.query("leads").withIndex("by_client", (q) => q.eq("clientId", id)).collect()) await ctx.db.patch(l._id, { clientName: next.name, clientPhone: phone });
      for (const o of await ctx.db.query("orders").withIndex("by_client", (q) => q.eq("clientId", id)).collect()) await ctx.db.patch(o._id, { clientName: next.name, clientPhone: phone });
    }
    await audit(ctx, me, "client.updated", `Клиент ${shortName(next.name)}: ${log.text()}`, { entityId: id, meta: { changes: log.changes } });
  },
});

export const setTags = mutation({
  args: { id: v.id("clients"), tags: v.array(v.string()) },
  handler: async (ctx, { id, tags }) => {
    const me = await requireRole(ctx, STAFF);
    const c = await ctx.db.get(id);
    if (!c) throw new ConvexError("Клиент не найден");
    assertNotErased(c);
    const next = cleanTags(tags);
    const diff = listDiff(c.tags, next);
    if (!diff.added.length && !diff.removed.length) return;
    await ctx.db.patch(id, { tags: next });
    await audit(ctx, me, "client.tags", `Клиент ${shortName(c.name)}: теги ${listDiffText(diff)}`, { entityId: id, meta: diff });
  },
});

export const addNote = mutation({
  args: { clientId: v.id("clients"), text: v.string() },
  handler: async (ctx, { clientId, text }) => {
    const me = await requireRole(ctx, STAFF);
    const c = await ctx.db.get(clientId);
    if (!c) throw new ConvexError("Клиент не найден");
    assertNotErased(c);
    const body = cleanText(text, MAX.note, "Комментарий");
    if (!body) throw new ConvexError("Пустой комментарий");
    const noteId = await ctx.db.insert("clientNotes", { clientId, authorId: me._id, text: body, at: nowIso() });
    // Текст комментария в журнал не копируем — он остаётся в карточке клиента.
    await audit(ctx, me, "client.note", `Клиент ${shortName(c.name)}: добавлен комментарий`, { entityId: clientId, meta: { noteId } });
  },
});

/**
 * Удаление персональных данных по запросу клиента (ТЗ п.26) — только владелец и только с вводом телефона клиента.
 * Контакты, записи звонков, расшифровки и переписка удаляются безвозвратно; номера и суммы заказов остаются.
 */
export const anonymize = mutation({
  args: { clientId: v.id("clients"), confirmPhone: v.string() },
  handler: async (ctx, { clientId, confirmPhone }) => {
    const me = await requireRole(ctx, OWNER);
    const c = await ctx.db.get(clientId);
    if (!c) throw new ConvexError("Клиент не найден");
    if (c.anonymizedAt) throw new ConvexError("Данные этого клиента уже удалены");
    if (normalizeLogin(confirmPhone.slice(0, 40)) !== c.phone) throw new ConvexError("Телефон не совпадает — данные не удалены");
    const [leads, orders] = await Promise.all([
      ctx.db.query("leads").withIndex("by_client", (q) => q.eq("clientId", clientId)).collect(),
      ctx.db.query("orders").withIndex("by_client", (q) => q.eq("clientId", clientId)).collect(),
    ]);
    assertCanErase(leads, orders);
    const n = await eraseClient(ctx, c, leads, orders);
    // В журнале — только факт и счётчики: ни имени, ни телефона, ни текстов.
    await audit(
      ctx,
      me,
      "client.anonymized",
      `Данные клиента удалены по его запросу: контакты, записи звонков (${n.recordings}), переписка (${n.messages} сообщ.), комментарии (${n.notes}); номера и суммы заказов (${n.orders}) сохранены`,
      { entityId: clientId, meta: { ...n } },
    );
    return n;
  },
});
