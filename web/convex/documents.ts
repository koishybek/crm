// Документы по заказу (ТЗ п.19.9): «Счёт на оплату» и «Акт выполненных работ». Реквизиты компании — в настройках
// владельца; номер — сквозной по виду документа (префикс и старт — настройка); при выпуске сохраняется снимок (реквизиты,
// покупатель, строки, суммы, сумма прописью) — повторная печать совпадает с первой. Печать — страница /docs/<вид>/<заказ>
// (браузер → «Сохранить как PDF»). Клиенту — ссылка /d/<токен> на страницу только для чтения: в базе хэш токена и срок.
import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { OWNER, requirePerm, requireRole, STAFF } from "./lib/access";
import { audit } from "./lib/audit";
import { randomToken, sha256Hex } from "./lib/crypto";
import { nowIso } from "./lib/domain";
import { hitLimit } from "./lib/rateLimit";
import { loadCatalog } from "./catalog";
import { replyChannel } from "./clientNotify";
import { sendOrderClientText } from "./orderClientChat";
import { env } from "./env";
import { documentKind } from "./schema";
import { ORDER_STATUS } from "../src/data/catalog";
import {
  ACT_STATUSES,
  cleanRequisites,
  DOC_KIND,
  DOC_LINK_TTL_MS,
  docDate,
  docLabel,
  INVOICE_BLOCKED,
  requisitesIssues,
  sumInWords,
  type CompanyRequisites,
  type DocumentData,
  type DocumentKind,
  type DocumentSnapshot,
  type OrderDocumentInfo,
} from "../src/data/documents";
import { netReceived } from "../src/data/money";
import type { OrderClientSend } from "../src/data/orderClientChat";
import { money } from "../src/lib/format";

const REQUISITES_KEY = "company.requisites";
/** Ссылок клиенту на сотрудника в час. */
const SHARES_PER_HOUR = 60;

async function loadRequisites(ctx: QueryCtx): Promise<CompanyRequisites | null> {
  const row = await ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", REQUISITES_KEY))
    .unique();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as CompanyRequisites;
  } catch {
    return null;
  }
}

const requisites = v.object({
  name: v.string(),
  bin: v.string(),
  address: v.string(),
  bank: v.string(),
  iik: v.string(),
  bik: v.string(),
  kbe: v.string(),
  director: v.string(),
  phone: v.optional(v.string()),
  vatNote: v.optional(v.string()),
  invoicePrefix: v.optional(v.string()),
  actPrefix: v.optional(v.string()),
  invoiceStart: v.optional(v.number()),
  actStart: v.optional(v.number()),
});

/** Реквизиты для карточки «Документы» (владелец) и подсказка, чего не хватает. */
export const getRequisites = query({
  args: {},
  handler: async (ctx): Promise<{ requisites: CompanyRequisites | null; issues: string[] }> => {
    await requireRole(ctx, OWNER);
    const r = await loadRequisites(ctx);
    return { requisites: r, issues: r ? requisitesIssues(r) : ["Реквизиты компании не заполнены"] };
  },
});

export const saveRequisites = mutation({
  args: { requisites },
  handler: async (ctx, a): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const r = cleanRequisites(a.requisites);
    const issues = requisitesIssues(r);
    if (issues.length) throw new ConvexError(issues[0]!);
    const row = await ctx.db
      .query("settings")
      .withIndex("by_key", (q) => q.eq("key", REQUISITES_KEY))
      .unique();
    const value = JSON.stringify(r);
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("settings", { key: REQUISITES_KEY, value });
    // Уже выпущенные документы не меняются — у них свой снимок.
    await audit(ctx, me, "settings.requisites", `Реквизиты компании для документов: ${r.name}, БИН ${r.bin}`, { entityId: REQUISITES_KEY });
  },
});

// ── Выпуск ───────────────────────────────────────────────────────────────────

/** Следующий номер документа вида: сквозной счётчик, не меньше стартового номера из настроек. */
async function nextDocNumber(ctx: MutationCtx, kind: DocumentKind, start: number | undefined): Promise<number> {
  const name = `doc:${kind}`;
  const c = await ctx.db
    .query("counters")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique();
  const value = Math.max((c?.value ?? 0) + 1, start ?? 1);
  if (c) await ctx.db.patch(c._id, { value });
  else await ctx.db.insert("counters", { name, value });
  return value;
}

async function snapshot(ctx: QueryCtx, o: Doc<"orders">, kind: DocumentKind, r: CompanyRequisites): Promise<DocumentData> {
  const client = await ctx.db.get(o.clientId);
  const cat = await loadCatalog(ctx);
  const total = o.clientPrice;
  return {
    seller: { name: r.name, bin: r.bin, address: r.address, bank: r.bank, iik: r.iik, bik: r.bik, kbe: r.kbe, director: r.director, ...(r.phone ? { phone: r.phone } : {}) },
    buyer: { name: client?.name ?? o.clientName, phone: client?.phone ?? o.clientPhone, ...(o.address ? { address: `${o.city}, ${o.address}` } : {}) },
    orderNumber: o.number,
    lines: [{ name: cat.label(o.serviceId), qty: 1, unit: "усл.", price: total, sum: total }],
    total,
    totalWords: sumInWords(total),
    paid: Math.max(0, netReceived(o)),
    vatNote: r.vatNote || "Без НДС",
    basis: kind === "invoice" ? `Заказ №${o.number}` : `Заказ №${o.number} от ${docDate(o.createdAt)}`,
  };
}

const toInfo = (d: Doc<"documents">): OrderDocumentInfo => ({
  id: d._id,
  kind: d.kind,
  label: d.label,
  date: d.date,
  total: d.total,
  replaced: !!d.replacedAt,
  sentAt: d.sentAt,
  linkExpiresAt: d.publicExpiresAt,
});

const current = (ctx: QueryCtx, orderId: Id<"orders">, kind: DocumentKind) =>
  ctx.db
    .query("documents")
    .withIndex("by_order", (q) => q.eq("orderId", orderId).eq("kind", kind))
    .order("desc")
    .first();

/**
 * Выпустить документ. Уже есть действующий того же вида — возвращаем его (номер не тратим); reissue — новый номер,
 * прежний помечается заменённым (цена изменилась, клиент просит заново).
 */
export const issue = mutation({
  args: { orderId: v.id("orders"), kind: documentKind, reissue: v.optional(v.boolean()) },
  handler: async (ctx, { orderId, kind, reissue }): Promise<Id<"documents">> => {
    const me = await requirePerm(ctx, "money.view", STAFF);
    const o = await ctx.db.get(orderId);
    if (!o) throw new ConvexError("Заказ не найден");
    if (kind === "act" && !ACT_STATUSES.includes(o.status)) throw new ConvexError(`Акт выпускают, когда работа сдана, а заказ — «${ORDER_STATUS[o.status].label}»`);
    if (kind === "invoice" && INVOICE_BLOCKED.includes(o.status)) throw new ConvexError(`Заказ «${ORDER_STATUS[o.status].label}» — счёт по нему не выставить`);
    if (o.clientPrice <= 0) throw new ConvexError("Сначала укажите цену клиента");
    const prev = await current(ctx, orderId, kind);
    if (prev && !prev.replacedAt && !reissue) return prev._id;
    const r = await loadRequisites(ctx);
    const issues = r ? requisitesIssues(r) : ["Реквизиты компании не заполнены"];
    if (!r || issues.length) throw new ConvexError(`${issues[0]} — «Настройки → Документы»`);
    const number = await nextDocNumber(ctx, kind, kind === "invoice" ? r.invoiceStart : r.actStart);
    const at = nowIso();
    const data = await snapshot(ctx, o, kind, r);
    const label = docLabel(kind === "invoice" ? r.invoicePrefix : r.actPrefix, number);
    const id = await ctx.db.insert("documents", { orderId, kind, number, label, date: at, total: data.total, data, createdAt: at, createdBy: me._id });
    if (prev && !prev.replacedAt) await ctx.db.patch(prev._id, { replacedAt: at, publicTokenHash: undefined, publicExpiresAt: undefined });
    await audit(ctx, me, "order.document", `Заказ №${o.number}: ${DOC_KIND[kind].short.toLowerCase()} №${label} на ${money(data.total)}${prev ? ` (взамен №${prev.label})` : ""}`, {
      entityId: orderId,
      meta: { documentId: id, kind, number, total: data.total, ...(prev ? { replaces: prev._id } : {}) },
    });
    return id;
  },
});

/** Документы заказа для карточки. */
export const forOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<OrderDocumentInfo[]> => {
    await requirePerm(ctx, "money.view", STAFF);
    const rows = await ctx.db
      .query("documents")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .order("desc")
      .take(30);
    return rows.map(toInfo);
  },
});

/** Последний документ вида для печатной страницы /docs/<вид>/<заказ>: снимок, как выпущен. null — ещё не выпускали. */
export const latest = query({
  args: { orderId: v.id("orders"), kind: documentKind },
  handler: async (ctx, { orderId, kind }): Promise<(DocumentSnapshot & { id: string; replaced: boolean; orderStatus: string }) | null> => {
    await requirePerm(ctx, "money.view", STAFF);
    const o = await ctx.db.get(orderId);
    if (!o) return null;
    const d = await current(ctx, orderId, kind);
    return d ? { id: d._id, kind: d.kind, label: d.label, date: d.date, data: d.data, replaced: !!d.replacedAt, orderStatus: o.status } : null;
  },
});

/**
 * Ссылка клиенту на документ (только чтение, 30 дней). send — сразу отправить в его мессенджер тем же путём, что
 * «Клиенту» в заказе; иначе — только ссылка для копирования. Новая ссылка заменяет прежнюю (в базе — только хэш).
 */
export const share = mutation({
  args: { id: v.id("documents"), send: v.boolean() },
  handler: async (ctx, { id, send }): Promise<{ url: string; delivery: OrderClientSend | null }> => {
    const me = await requirePerm(ctx, "money.view", STAFF);
    const d = await ctx.db.get(id);
    if (!d) throw new ConvexError("Документ не найден");
    if (d.replacedAt) throw new ConvexError("Документ заменён новым — отправьте актуальный");
    const o = await ctx.db.get(d.orderId);
    if (!o) throw new ConvexError("Заказ не найден");
    const app = env("APP_URL")?.replace(/\/+$/, "");
    if (!app) throw new ConvexError("Не задан адрес приложения (APP_URL) — клиенту нечего открыть");
    if (!(await hitLimit(ctx, `docshare:${me._id}`, SHARES_PER_HOUR, 3600_000))) throw new ConvexError("Слишком много ссылок подряд — попробуйте позже");
    const token = randomToken(32);
    const expires = new Date(Date.now() + DOC_LINK_TTL_MS).toISOString();
    await ctx.db.patch(id, { publicTokenHash: sha256Hex(token), publicExpiresAt: expires });
    const url = `${app}/d/${token}`;
    let delivery: OrderClientSend | null = null;
    if (send) {
      const c = await replyChannel(ctx, o.clientId);
      delivery =
        c?.channel === "olx"
          ? { sent: false, reason: "OLX не пропускает ссылки — скопируйте ссылку и отправьте клиенту в WhatsApp или Telegram" }
          : await sendOrderClientText(ctx, me, o, `${DOC_KIND[d.kind].title} №${d.label} по заказу №${o.number}: ${url}`);
      if (delivery.sent) await ctx.db.patch(id, { sentAt: nowIso() });
    }
    await audit(ctx, me, "order.document", `Заказ №${o.number}: ссылка на ${DOC_KIND[d.kind].short.toLowerCase()} №${d.label}${send ? (delivery?.sent ? " отправлена клиенту" : " не отправлена — клиент не на связи") : " скопирована"}`, {
      entityId: o._id,
      meta: { documentId: id, sent: delivery?.sent ?? false, expiresAt: expires },
    });
    return { url, delivery };
  },
});

/** Публичная страница документа по ссылке клиента: только снимок документа — ни id заказа, ни других данных. */
export const publicView = query({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<DocumentSnapshot | null> => {
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return null;
    const d = await ctx.db
      .query("documents")
      .withIndex("by_public_token", (q) => q.eq("publicTokenHash", sha256Hex(token)))
      .unique();
    if (!d || d.replacedAt || !d.publicExpiresAt || d.publicExpiresAt < nowIso()) return null;
    return { kind: d.kind, label: d.label, date: d.date, data: d.data };
  },
});
