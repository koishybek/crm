// Онлайн-оплата заказа (ТЗ п.19.7, п.23.5): сотрудник выставляет счёт на оплату → ссылка провайдера (Freedom Pay,
// CloudPayments) или ссылка магазина Kaspi → «Скопировать» / «Отправить клиенту» (в его мессенджер, как «Клиенту» в заказе)
// → уведомление провайдера POST /pay/<провайдер> (подпись проверяется) → оплата в заказе от имени «Система» тем же путём,
// что «Внести оплату» (lib/money.ts recordPayment → settle). Повтор уведомления ничего не меняет; сумма не та или заказ
// уже не принимает оплату — счёт «Нужна проверка», владельцу — уведомление. Kaspi без API: оплату отмечает сотрудник.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, httpAction, internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./lib/functions";
import { OWNER, requirePerm, requireRole, STAFF } from "./lib/access";
import { audit } from "./lib/audit";
import { randomToken } from "./lib/crypto";
import { notify, nowIso } from "./lib/domain";
import { markError, markOk } from "./lib/health";
import { positiveMoney, recordPayment } from "./lib/money";
import { PAY_ADAPTERS } from "./lib/pay";
import type { PayCreds } from "./lib/pay/types";
import { ProviderError } from "./lib/providerHttp";
import { hitLimit } from "./lib/rateLimit";
import { integrationsKeyIssue, isSealed, openSecret, sealSecret, SecretBoxError } from "./lib/secretBox";
import { loadCatalog } from "./catalog";
import { sendOrderClientText } from "./orderClientChat";
import { replyChannel } from "./clientNotify";
import { env } from "./env";
import { payProvider } from "./schema";
import { ORDER_STATUS } from "../src/data/catalog";
import { paidAmount } from "../src/data/logic";
import { PAYMENT_BLOCKED } from "../src/data/money";
import type { OrderClientSend } from "../src/data/orderClientChat";
import {
  intentView,
  isOnlineProvider,
  kaspiLink,
  kaspiTemplateIssue,
  nextIntentStatus,
  ONLINE_PROVIDERS,
  PAY_INFO,
  PAY_LINK_TTL_MS,
  payWebhookPath,
  type OnlineProvider,
  type OrderPayView,
  type PayIntentEvent,
  type PayIntentInfo,
  type PayProvider,
  type PaySettingsView,
} from "../src/data/payIntents";
import { money } from "../src/lib/format";
import { requireModule } from "./lib/tenant";
import { actionFor, companyQuery, DEFAULT_TENANT } from "./lib/tenantDb";
import { lockText } from "../src/data/plans";

const KEY = { provider: "pay.provider", public: "pay.public", secrets: "pay.secrets", kaspi: "pay.kaspiTemplate" } as const;
const onlineProvider = v.union(...ONLINE_PROVIDERS.map((p) => v.literal(p)));
/** Счетов на сотрудника в час — не кнопка для нажатий подряд. */
const LINKS_PER_HOUR = 30;
/** Сколько счетов показываем в заказе. */
const MAX_INTENTS = 20;
/** Сумма в уведомлении — с копейками («15000.00»): сравниваем с точностью до тиына. */
const SAME_AMOUNT = 0.005;

async function setting(ctx: QueryCtx, key: string) {
  return ctx.db
    .query("settings")
    .withIndex("by_key", (q) => q.eq("key", key))
    .unique();
}

async function putSetting(ctx: MutationCtx, key: string, value: string | null): Promise<void> {
  const row = await setting(ctx, key);
  if (value === null) {
    if (row) await ctx.db.delete(row._id);
  } else if (row) await ctx.db.patch(row._id, { value });
  else await ctx.db.insert("settings", { key, value });
}

function parseJson(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object") return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

interface PayState {
  provider: OnlineProvider | null;
  config: Record<string, string>;
  sealed: string | null;
  kaspiTemplate: string | null;
}

async function loadState(ctx: QueryCtx): Promise<PayState> {
  const [p, pub, sec, kaspi] = await Promise.all([setting(ctx, KEY.provider), setting(ctx, KEY.public), setting(ctx, KEY.secrets), setting(ctx, KEY.kaspi)]);
  return { provider: p && isOnlineProvider(p.value) ? p.value : null, config: parseJson(pub?.value), sealed: sec?.value ?? null, kaspiTemplate: kaspi?.value ?? null };
}

async function openCreds(state: PayState): Promise<PayCreds> {
  if (!state.sealed) throw new ConvexError("Ключи онлайн-оплаты не сохранены");
  try {
    return { ...state.config, ...parseJson((await openSecret(state.sealed, "pay.credentials")).value) };
  } catch (e) {
    if (e instanceof SecretBoxError) throw new ConvexError(e.reason === "key" ? "Не задан ключ шифрования INTEGRATIONS_KEY" : "Ключи онлайн-оплаты не расшифровываются — введите их заново");
    throw e;
  }
}

/** Какие способы выставить счёт доступны сейчас. */
const available = (s: PayState): PayProvider[] => [...(s.provider && s.sealed ? [s.provider] : []), ...(s.kaspiTemplate ? (["kaspi"] as const) : [])];

export const _state = internalQuery({ args: {}, handler: (ctx): Promise<PayState> => loadState(ctx) });

// ── Настройки владельца ──────────────────────────────────────────────────────

export const settings = query({
  args: {},
  handler: async (ctx): Promise<PaySettingsView> => {
    const me = await requireRole(ctx, OWNER);
    const s = await loadState(ctx);
    return { provider: s.provider, config: s.config, hasSecrets: !!s.sealed, kaspiTemplate: s.kaspiTemplate, keyIssue: integrationsKeyIssue(), siteUrl: env("CONVEX_SITE_URL") ?? null, company: companyQuery(me.tenantId) ? me.tenantId : null };
  },
});

function cleanFields(provider: OnlineProvider, raw: Record<string, string>, keepSecrets: boolean): { pub: Record<string, string>; secret: Record<string, string> } {
  const pub: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const f of PAY_INFO[provider].fields) {
    let value = (raw[f.key] ?? "").trim();
    if (value.length > 200) throw new ConvexError(`${f.label}: слишком длинное значение`);
    if (f.options) value = f.options.some((o) => o.value === value) ? value : f.options[0]!.value;
    if (!value) {
      if (f.optional || (f.secret && keepSecrets)) continue;
      throw new ConvexError(`Заполните поле «${f.label}»`);
    }
    if (f.key === "merchantId" && !/^\d{1,12}$/.test(value)) throw new ConvexError("ID магазина Freedom Pay — только цифры");
    (f.secret ? secret : pub)[f.key] = value;
  }
  return { pub, secret };
}

/** Подключить провайдера онлайн-оплаты. Секреты можно не вводить повторно для того же провайдера. */
export const save = action({
  args: { provider: onlineProvider, fields: v.record(v.string(), v.string()) },
  handler: async (ctx, { provider, fields }): Promise<void> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    const state: PayState = await ctx.runQuery(internal.payments._state, {});
    const same = state.provider === provider && !!state.sealed;
    const { pub, secret } = cleanFields(provider, fields, same);
    let merged = secret;
    if (same && PAY_INFO[provider].fields.some((f) => f.secret && !secret[f.key])) {
      const old = await openCreds(state);
      merged = Object.fromEntries(PAY_INFO[provider].fields.filter((f) => f.secret).map((f) => [f.key, secret[f.key] ?? old[f.key] ?? ""]));
    }
    let sealed: string;
    try {
      sealed = await sealSecret(JSON.stringify(merged), "pay.credentials");
    } catch (e) {
      if (e instanceof SecretBoxError) throw new ConvexError(integrationsKeyIssue() ?? "Не задан ключ шифрования INTEGRATIONS_KEY");
      throw e;
    }
    await ctx.runMutation(internal.payments._save, { provider, config: JSON.stringify(pub), sealed });
  },
});

export const _save = internalMutation({
  args: { provider: onlineProvider, config: v.string(), sealed: v.string() },
  handler: async (ctx, { provider, config, sealed }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    if (!isSealed(sealed)) throw new ConvexError("Ключи онлайн-оплаты должны быть зашифрованы");
    const before = (await setting(ctx, KEY.provider))?.value;
    await putSetting(ctx, KEY.provider, provider);
    await putSetting(ctx, KEY.public, config);
    await putSetting(ctx, KEY.secrets, sealed);
    const label = PAY_INFO[provider].label;
    await audit(ctx, me, "integration.payProvider", before === provider ? `Онлайн-оплата: обновлены ключи ${label}` : `Онлайн-оплата: подключён ${label}`, { entityId: "payments", meta: { provider, previous: before ?? null } });
  },
});

export const disable = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const before = (await setting(ctx, KEY.provider))?.value;
    if (!before) return;
    for (const key of [KEY.provider, KEY.public, KEY.secrets]) await putSetting(ctx, key, null);
    await audit(ctx, me, "integration.payProvider", `Онлайн-оплата: ${isOnlineProvider(before) ? PAY_INFO[before].label : before} отключён, ключи удалены`, { entityId: "payments", meta: { provider: before, disabled: true } });
  },
});

/** Ссылка магазина Kaspi (шаблон). Пусто — убрать. */
export const setKaspi = mutation({
  args: { template: v.string() },
  handler: async (ctx, { template }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const t = template.trim();
    if (t.length > 500) throw new ConvexError("Ссылка слишком длинная");
    if (t) {
      const issue = kaspiTemplateIssue(t);
      if (issue) throw new ConvexError(issue);
    }
    await putSetting(ctx, KEY.kaspi, t || null);
    await audit(ctx, me, "integration.payProvider", t ? "Онлайн-оплата: сохранена ссылка магазина Kaspi" : "Онлайн-оплата: ссылка Kaspi убрана", { entityId: "payments", meta: { provider: "kaspi", disabled: !t } });
  },
});

// ── Счета по заказу ──────────────────────────────────────────────────────────

async function toInfo(ctx: QueryCtx, x: Doc<"paymentIntents">, names: Map<string, string>): Promise<PayIntentInfo> {
  if (!names.has(x.createdBy)) names.set(x.createdBy, (await ctx.db.get(x.createdBy))?.name ?? "Сотрудник");
  return {
    id: x._id,
    provider: x.provider,
    amount: x.amount,
    status: x.status,
    url: x.status === "created" ? x.url : undefined,
    createdAt: x.createdAt,
    expiresAt: x.expiresAt,
    sentAt: x.sentAt,
    paidAt: x.paidAt,
    error: x.error,
    reportedAmount: x.reportedAmount,
    createdByName: names.get(x.createdBy)!,
  };
}

/** Счета заказа и доступные способы — для блока денег в карточке заказа. Владелец и операторы. */
export const forOrder = query({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }): Promise<OrderPayView | null> => {
    await requirePerm(ctx, "money.view", STAFF);
    if (!(await ctx.db.get(orderId))) return null;
    const rows = await ctx.db
      .query("paymentIntents")
      .withIndex("by_order", (q) => q.eq("orderId", orderId))
      .order("desc")
      .take(MAX_INTENTS);
    const names = new Map<string, string>();
    const intents: PayIntentInfo[] = [];
    for (const x of rows) intents.push(await toInfo(ctx, x, names));
    return { providers: available(await loadState(ctx)), intents };
  },
});

interface Prepared {
  intentId: Id<"paymentIntents">;
  /** Ссылка уже есть (Kaspi или прежний неоплаченный счёт на ту же сумму) — провайдера не зовём. */
  ready: boolean;
  invoiceId: string;
  amount: number;
  description: string;
  state: PayState;
  /** Компания счёта — в адрес уведомления провайдера (?c=…). */
  tenantId: string;
}

export const _prepare = internalMutation({
  args: { orderId: v.id("orders"), provider: payProvider, amount: v.optional(v.number()) },
  handler: async (ctx, a): Promise<Prepared> => {
    const me = await requirePerm(ctx, "payments.add", STAFF);
    await requireModule(ctx, me.tenantId, "online_payments");
    const o = await ctx.db.get(a.orderId);
    if (!o) throw new ConvexError("Заказ не найден");
    const blocked = PAYMENT_BLOCKED[o.status];
    if (blocked) throw new ConvexError(blocked);
    const owed = o.clientPrice - paidAmount(o);
    if (owed <= 0) throw new ConvexError("По заказу нет долга — счёт выставлять не на что");
    const amount = a.amount === undefined ? owed : positiveMoney(a.amount, "Счёт");
    if (amount > owed) throw new ConvexError(`Счёт не больше долга клиента: ${money(owed)}`);
    const state = await loadState(ctx);
    if (!available(state).includes(a.provider)) throw new ConvexError(`${PAY_INFO[a.provider].label} не подключён — «Настройки → Онлайн-оплата»`);
    const now = Date.now();
    // Неоплаченный действующий счёт на ту же сумму — тот же: две ссылки на один долг путают клиента.
    const open = (
      await ctx.db
        .query("paymentIntents")
        .withIndex("by_order", (q) => q.eq("orderId", o._id))
        .order("desc")
        .take(MAX_INTENTS)
    ).find((x) => x.provider === a.provider && x.amount === amount && x.url && intentView(x.status, x.expiresAt, now) === "created");
    const cat = await loadCatalog(ctx);
    const description = `Заказ №${o.number}: ${cat.label(o.serviceId)}`.slice(0, 200);
    if (open) return { intentId: open._id, ready: true, invoiceId: open.invoiceId, amount, description, state, tenantId: me.tenantId };
    if (!(await hitLimit(ctx, `paylink:${me._id}`, LINKS_PER_HOUR, 3600_000))) throw new ConvexError("Слишком много счетов подряд — попробуйте позже");
    const at = nowIso();
    const invoiceId = `hms-${o.number}-${randomToken(6)}`;
    const kaspi = a.provider === "kaspi";
    const intentId = await ctx.db.insert("paymentIntents", {
      orderId: o._id,
      provider: a.provider,
      invoiceId,
      amount,
      status: "created",
      url: kaspi ? kaspiLink(state.kaspiTemplate!, amount, o.number) : undefined,
      createdAt: at,
      createdBy: me._id,
      expiresAt: new Date(now + PAY_LINK_TTL_MS).toISOString(),
      updatedAt: at,
    });
    await audit(ctx, me, "order.paymentLink", `Заказ №${o.number}: выставлен счёт на оплату ${money(amount)} (${PAY_INFO[a.provider].label})`, { entityId: o._id, meta: { intentId, provider: a.provider, amount } });
    return { intentId, ready: kaspi, invoiceId, amount, description, state, tenantId: me.tenantId };
  },
});

export const _linked = internalMutation({
  args: { intentId: v.id("paymentIntents"), url: v.optional(v.string()), externalId: v.optional(v.string()), error: v.optional(v.string()) },
  handler: async (ctx, { intentId, url, externalId, error }): Promise<void> => {
    const x = await ctx.db.get(intentId);
    if (!x) return;
    if (url) {
      await ctx.db.patch(intentId, { url, externalId, updatedAt: nowIso() });
      await markOk(ctx, "payments", `Счёт ${PAY_INFO[x.provider].label} создан`);
    } else {
      await ctx.db.patch(intentId, { status: "failed", error: error?.slice(0, 300), updatedAt: nowIso() });
      await markError(ctx, "payments", error ?? "Счёт не создан");
    }
  },
});

/** «Выставить счёт на оплату»: ссылка у провайдера (или ссылка Kaspi). Возвращает счёт для карточки заказа. */
export const createLink = action({
  args: { orderId: v.id("orders"), provider: payProvider, amount: v.optional(v.number()) },
  handler: async (ctx, a): Promise<{ intentId: Id<"paymentIntents">; url: string }> => {
    const p: Prepared = await ctx.runMutation(internal.payments._prepare, a);
    if (p.ready) {
      const ready = await ctx.runQuery(internal.payments._intent, { id: p.intentId });
      if (ready?.url) return { intentId: p.intentId, url: ready.url };
    }
    if (!isOnlineProvider(a.provider)) throw new ConvexError("Ссылка на оплату не получена");
    const site = env("CONVEX_SITE_URL");
    if (!site) throw new ConvexError("У сервера не задан адрес (CONVEX_SITE_URL) — провайдеру некуда слать уведомление об оплате");
    try {
      const creds = await openCreds(p.state);
      const link = await PAY_ADAPTERS[a.provider].createPaymentLink(creds, {
        invoiceId: p.invoiceId,
        amount: p.amount,
        description: p.description,
        resultUrl: `${site}${payWebhookPath(a.provider)}${companyQuery(p.tenantId)}`,
        lifetimeSeconds: Math.round(PAY_LINK_TTL_MS / 1000),
      });
      await ctx.runMutation(internal.payments._linked, { intentId: p.intentId, url: link.url, externalId: link.externalId });
      return { intentId: p.intentId, url: link.url };
    } catch (e) {
      const error = e instanceof ProviderError ? e.message : e instanceof ConvexError ? String(e.data) : `${PAY_INFO[a.provider].label}: счёт не создан`;
      console.warn(`Онлайн-оплата: счёт не создан (${a.provider})`);
      await ctx.runMutation(internal.payments._linked, { intentId: p.intentId, error });
      throw new ConvexError(error);
    }
  },
});

export const _intent = internalQuery({ args: { id: v.id("paymentIntents") }, handler: (ctx, { id }) => ctx.db.get(id) });

async function staffIntent(ctx: MutationCtx, id: Id<"paymentIntents">) {
  const me = await requirePerm(ctx, "payments.add", STAFF);
  const x = await ctx.db.get(id);
  if (!x) throw new ConvexError("Счёт не найден");
  const o = await ctx.db.get(x.orderId);
  if (!o) throw new ConvexError("Заказ не найден");
  return { me, x, o };
}

/** Отменить неоплаченный счёт (ссылка в карточке больше не показывается). Пришедшую потом оплату система всё равно примет. */
export const cancel = mutation({
  args: { id: v.id("paymentIntents") },
  handler: async (ctx, { id }): Promise<void> => {
    const { me, x, o } = await staffIntent(ctx, id);
    const to = nextIntentStatus(x.status, "cancel");
    if (!to) throw new ConvexError(x.status === "paid" ? "Счёт уже оплачен" : "Счёт уже закрыт");
    await ctx.db.patch(id, { status: to, updatedAt: nowIso() });
    await audit(ctx, me, "order.paymentLink", `Заказ №${o.number}: отменён счёт на оплату ${money(x.amount)} (${PAY_INFO[x.provider].label})`, { entityId: o._id, meta: { intentId: id, cancelled: true } });
  },
});

/** «Отправить клиенту»: ссылка на оплату — в его мессенджер тем же путём, что «Клиенту» в заказе. OLX ссылки не пропускает. */
export const send = mutation({
  args: { id: v.id("paymentIntents") },
  handler: async (ctx, { id }): Promise<OrderClientSend> => {
    const { me, x, o } = await staffIntent(ctx, id);
    if (x.status !== "created" || !x.url || intentView(x.status, x.expiresAt, Date.now()) !== "created") throw new ConvexError("Этот счёт уже не действует — выставьте новый");
    const conv = await replyChannel(ctx, o.clientId);
    if (conv?.channel === "olx") return { sent: false, reason: "OLX не пропускает ссылки — скопируйте ссылку и отправьте клиенту в WhatsApp или Telegram" };
    const text = `Счёт на оплату заказа №${o.number}: ${money(x.amount)}.\nОплатить: ${x.url}`;
    const r = await sendOrderClientText(ctx, me, o, text);
    if (r.sent) await ctx.db.patch(id, { sentAt: nowIso(), updatedAt: nowIso() });
    await audit(ctx, me, "order.paymentLink", `Заказ №${o.number}: ссылка на оплату ${money(x.amount)} ${r.sent ? "отправлена клиенту" : "не отправлена — клиент не на связи в мессенджерах"}`, { entityId: o._id, meta: { intentId: id, sent: r.sent } });
    return r;
  },
});

// ── Уведомление провайдера ───────────────────────────────────────────────────

export type NoticeOutcome = "unknown" | "ignored" | "duplicate" | "paid" | "failed" | "review";

async function owners(ctx: QueryCtx): Promise<Id<"users">[]> {
  return (
    await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", "owner"))
      .collect()
  ).map((u) => u._id);
}

/**
 * Итог оплаты от провайдера (подпись уже проверена). Идемпотентно: «Оплачен» и «Нужна проверка» не меняются. Оплата —
 * recordPayment от имени «Система» (способ «Карта»): тот же расчёт долга и статуса, что у «Внести оплату».
 */
export const _notice = internalMutation({
  args: {
    provider: onlineProvider,
    invoiceId: v.string(),
    externalId: v.optional(v.string()),
    status: v.union(v.literal("paid"), v.literal("failed"), v.literal("pending")),
    amount: v.number(),
    currency: v.string(),
  },
  handler: async (ctx, n): Promise<NoticeOutcome> => {
    const x = await ctx.db
      .query("paymentIntents")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", n.invoiceId))
      .unique();
    const label = PAY_INFO[n.provider].label;
    if (!x || x.provider !== n.provider) {
      await markError(ctx, "payments", `${label}: уведомление по неизвестному счёту`);
      return "unknown";
    }
    if (n.status === "pending") return "ignored";
    const o = await ctx.db.get(x.orderId);
    const at = nowIso();
    let event: PayIntentEvent = n.status;
    let error: string | undefined;
    if (n.status === "paid") {
      const valid = Number.isFinite(n.amount) && n.amount >= 0;
      if (!valid || Math.abs(n.amount - x.amount) > SAME_AMOUNT || n.currency.toUpperCase() !== "KZT") {
        event = "mismatch";
        error = `Сумма в уведомлении ${valid ? `${n.amount} ${n.currency}` : "не указана"}, а счёт — на ${money(x.amount)}: оплата не внесена, проверьте в кабинете ${label}`;
      } else if (!o || PAYMENT_BLOCKED[o.status]) {
        event = "blocked";
        error = `Оплата пришла, но заказ ${o ? "уже не принимает оплату" : "удалён"}: проверьте и оформите возврат в кабинете ${label}`;
      }
    }
    const to = nextIntentStatus(x.status, event);
    if (!to) return x.status === "paid" && event === "paid" ? "duplicate" : "ignored";
    if (to === "failed") {
      await ctx.db.patch(x._id, { status: to, externalId: n.externalId ?? x.externalId, error: "Оплата не прошла (отказ банка или клиент не завершил оплату)", updatedAt: at });
      return "failed";
    }
    if (to === "review") {
      await ctx.db.patch(x._id, { status: to, externalId: n.externalId ?? x.externalId, reportedAmount: Number.isFinite(n.amount) && n.amount >= 0 ? n.amount : undefined, error, updatedAt: at });
      await markError(ctx, "payments", `${label}: ${error}`);
      const num = o ? `№${o.number}` : "";
      await audit(ctx, "Система", "order.paymentOnline", `Заказ ${num}: онлайн-оплата требует проверки — ${error}`, { entityId: x.orderId, meta: { intentId: x._id, provider: n.provider, amount: n.amount, currency: n.currency, expected: x.amount, event } });
      await notify(ctx, [...(await owners(ctx)), x.createdBy], `Онлайн-оплата по заказу ${num} требует проверки`, { link: `/orders/${x.orderId}`, tone: "bad" });
      return "review";
    }
    // to === "paid": деньги — тем же путём, что «Внести оплату».
    const order = o!;
    const r = await recordPayment(ctx, order, { amount: x.amount, method: "card", at, note: `Онлайн-оплата ${label}, счёт ${x.invoiceId}` }, { type: "system" });
    await ctx.db.patch(x._id, { status: "paid", paidAt: at, paymentId: r.payment.id, externalId: n.externalId ?? x.externalId, error: undefined, updatedAt: at });
    const moved = r.settled ? `; статус «${ORDER_STATUS[r.settled.from].label}» → «${ORDER_STATUS[r.settled.to].label}»` : "";
    await audit(ctx, "Система", "order.payment", `Заказ №${order.number}: онлайн-оплата ${money(x.amount)} (${label}), оплачено ${money(r.paid)} из ${money(order.clientPrice)}${moved}`, {
      entityId: order._id,
      meta: { paymentId: r.payment.id, intentId: x._id, provider: n.provider, amount: x.amount, paid: r.paid, clientPrice: order.clientPrice, ...(r.over > 0 ? { overpay: r.over } : {}), ...(r.settled ? { status: r.settled } : {}) },
    });
    await notify(ctx, [...(await owners(ctx)), x.createdBy], `Онлайн-оплата по заказу №${order.number}: ${money(x.amount)}`, { link: `/orders/${order._id}`, tone: "ok", email: { kind: "payment" } });
    await markOk(ctx, "payments", `Оплата ${label} принята`);
    return "paid";
  },
});

const MAX_BODY = 64 * 1024;

/** POST /pay/<провайдер>: проверка подписи адаптером → _notice → ответ провайдеру (Freedom Pay — подписанный XML). */
export function payWebhook(provider: OnlineProvider) {
  return httpAction(async (raw, request) => {
    const label = PAY_INFO[provider].label;
    // Компания — из адреса уведомления (?c=…, его задаём при создании счёта); без него — компания по умолчанию (как до SaaS).
    // Подпись провайдера проверяется ключами этой компании: чужое уведомление не пройдёт.
    const company = new URL(request.url).searchParams.get("c");
    const tenantId = company ? await raw.runQuery(internal.site._publicTenant, { company }) : DEFAULT_TENANT;
    if (!tenantId) return new Response("unknown company", { status: 404 });
    const ctx = actionFor(raw, tenantId);
    const reject = async (status: number, why: string) => {
      await ctx.runMutation(internal.health._mark, { key: "payments", ok: false, note: why });
      return new Response("rejected", { status });
    };
    if (!(await ctx.runQuery(internal.tenants._hasModule, { module: "online_payments" }))) return reject(403, lockText("online_payments"));
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return reject(413, `${label}: слишком большое уведомление`);
    const body = await request.text();
    if (body.length > MAX_BODY) return reject(413, `${label}: слишком большое уведомление`);
    const state: PayState = await ctx.runQuery(internal.payments._state, {});
    if (state.provider !== provider || !state.sealed) return reject(409, `${label} прислал уведомление, но в настройках он не подключён`);
    let creds: PayCreds;
    try {
      creds = await openCreds(state);
    } catch (e) {
      return reject(503, e instanceof ConvexError ? String(e.data) : "Ключи онлайн-оплаты не открываются");
    }
    const url = new URL(request.url);
    const r = await PAY_ADAPTERS[provider].verifyWebhook(creds, { body, contentType: request.headers.get("content-type") ?? "", headers: request.headers, path: url.pathname });
    if (!r.ok) return reject(r.status, r.why);
    let outcome: NoticeOutcome;
    try {
      outcome = await ctx.runMutation(internal.payments._notice, { provider, ...r.notice, amount: Number.isFinite(r.notice.amount) ? r.notice.amount : -1 });
    } catch (e) {
      console.error(`Онлайн-оплата ${provider}: уведомление не сохранено: ${e instanceof Error ? e.name : "ошибка"}`);
      // 500 — провайдер повторит уведомление позже.
      return reject(500, `${label}: уведомление не сохранено — внутренняя ошибка`);
    }
    const reply = r.reply(outcome !== "review" && outcome !== "unknown");
    return new Response(reply.body, { status: reply.status, headers: { "Content-Type": reply.contentType } });
  });
}
