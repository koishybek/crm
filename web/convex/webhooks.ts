// Исходящие вебхуки (ТЗ п.20.7, п.26.7, п.19.10, п.18.9): владелец подписывает свой сервер на события — новая заявка,
// смена статусов, оплата, отзыв. Тело — JSON { id, type, createdAt, data }, подпись — X-HMS-Signature (HMAC-SHA256 с временем,
// lib/webhookEvents.ts). Доставка — через планировщик: до 8 попыток с удвоением паузы; 20 неудач подряд — подписка
// отключается, владелец получает уведомление. Адрес — только публичный https на порту 443 (lib/safeFetch.ts, защита от SSRF).
// Секрет подписи показывается один раз; в базе он зашифрован (lib/secretBox.ts, нужен INTEGRATIONS_KEY).
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { OWNER, requireRole } from "./lib/access";
import { audit } from "./lib/audit";
import { randomToken } from "./lib/crypto";
import { notify, nowIso } from "./lib/domain";
import { markError } from "./lib/health";
import { hitLimit } from "./lib/rateLimit";
import { checkPublicUrl } from "./lib/safeFetch";
import { openSecret, sealSecret, SecretBoxError } from "./lib/secretBox";
import { enqueueEvent, signatureHeader } from "./lib/webhookEvents";
import { env } from "./env";
import { webhookEvent } from "./schema";
import { APP_NAME } from "../src/data/catalog";
import {
  SIGNATURE_HEADER,
  WEBHOOK_DISABLE_AFTER,
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
  type WebhookDeliveryInfo,
  type WebhookEvent,
  type WebhookInfo,
  type WebhooksView,
} from "../src/data/webhookEvents";

const MAX_WEBHOOKS = 10;
const MAX_URL = 500;
/** Пауза перед повтором: 1, 2, 4 … 64 минуты. */
const RETRY_BASE_MS = 60_000;
/** Ждём ответ получателя не дольше 10 секунд. */
const TIMEOUT_MS = 10_000;
/** Журнал доставок храним месяц. */
const KEEP_DELIVERIES_MS = 30 * 86400_000;
const TESTS_PER_MIN = 10;

export const retryDelay = (attempt: number): number => RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1);

const KEY_MISSING = "Чтобы сохранить секрет подписи, задайте ключ шифрования INTEGRATIONS_KEY в окружении Convex (32 случайных байта в base64)";

/** Адрес подписки: публичный https на стандартном порту, без логина в адресе. */
export function checkWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: false, error: "Укажите адрес, куда отправлять события" };
  if (s.length > MAX_URL) return { ok: false, error: `Адрес длиннее ${MAX_URL} символов` };
  const c = checkPublicUrl(s);
  return c.ok ? { ok: true, url: c.url.toString() } : { ok: false, error: `Адрес не подходит: ${c.reason}` };
}

function cleanEvents(events: readonly string[]): WebhookEvent[] {
  const list = WEBHOOK_EVENTS.filter((e) => events.includes(e));
  if (!list.length) throw new ConvexError("Выберите хотя бы одно событие");
  return list;
}

const toInfo = (w: Doc<"webhooks">): WebhookInfo => ({
  id: w._id,
  url: w.url,
  events: w.events.filter((e): e is WebhookEvent => e !== "webhook.test"),
  description: w.description,
  active: w.active,
  failures: w.failures,
  createdAt: w.createdAt,
  disabledAt: w.disabledAt,
  disabledReason: w.disabledReason,
  lastDeliveryAt: w.lastDeliveryAt,
  lastError: w.lastError,
});

const toDelivery = (d: Doc<"webhookDeliveries">): WebhookDeliveryInfo => ({
  id: d._id,
  webhookId: d.webhookId,
  event: d.event,
  status: d.status,
  attempts: d.attempts,
  responseCode: d.responseCode,
  error: d.error,
  createdAt: d.createdAt,
  deliveredAt: d.deliveredAt,
  nextAt: d.nextAt,
});

/** Короткая запись адреса для журнала и уведомлений: только хост — в пути и параметрах бывают токены. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "адрес";
  }
};

function keyIssue(): string | null {
  return env("INTEGRATIONS_KEY") ? null : KEY_MISSING;
}

export const list = query({
  args: {},
  handler: async (ctx): Promise<WebhooksView> => {
    await requireRole(ctx, OWNER);
    const hooks = await ctx.db.query("webhooks").order("desc").take(MAX_WEBHOOKS * 2);
    const deliveries = await ctx.db.query("webhookDeliveries").withIndex("by_created").order("desc").take(30);
    return { webhooks: hooks.map(toInfo), deliveries: deliveries.map(toDelivery), keyIssue: keyIssue() };
  },
});

/** Новая подписка. Секрет возвращается один раз — дальше в базе только шифртекст. */
export const create = action({
  args: { url: v.string(), events: v.array(v.string()), description: v.optional(v.string()) },
  handler: async (ctx, a): Promise<{ id: Id<"webhooks">; secret: string }> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    const url = checkWebhookUrl(a.url);
    if (!url.ok) throw new ConvexError(url.error);
    const events = cleanEvents(a.events);
    const secret = `whsec_${randomToken(32)}`;
    let sealed: string;
    try {
      sealed = await sealSecret(secret, "webhook.secret");
    } catch (e) {
      if (e instanceof SecretBoxError) throw new ConvexError(KEY_MISSING);
      throw e;
    }
    const id = await ctx.runMutation(internal.webhooks._create, { url: url.url, events, secret: sealed, description: a.description });
    return { id, secret };
  },
});

export const _create = internalMutation({
  args: { url: v.string(), events: v.array(webhookEvent), secret: v.string(), description: v.optional(v.string()) },
  handler: async (ctx, a): Promise<Id<"webhooks">> => {
    const me = await requireRole(ctx, OWNER);
    if ((await ctx.db.query("webhooks").take(MAX_WEBHOOKS + 1)).length >= MAX_WEBHOOKS) throw new ConvexError(`Подписок уже ${MAX_WEBHOOKS} — удалите ненужные`);
    const description = a.description?.trim().slice(0, 80) || undefined;
    const id = await ctx.db.insert("webhooks", { url: a.url, events: a.events, secret: a.secret, description, active: true, failures: 0, createdAt: nowIso(), createdBy: me._id });
    await audit(ctx, me, "integration.webhook", `Подписка на события: ${hostOf(a.url)} (${a.events.join(", ")})`, { entityId: id, meta: { host: hostOf(a.url), events: a.events } });
    return id;
  },
});

async function ownWebhook(ctx: MutationCtx, id: Id<"webhooks">): Promise<Doc<"webhooks">> {
  const w = await ctx.db.get(id);
  if (!w) throw new ConvexError("Подписка не найдена");
  return w;
}

/** События подписки и включение. Включение после автоотключения сбрасывает счётчик неудач. */
export const update = mutation({
  args: { id: v.id("webhooks"), events: v.optional(v.array(v.string())), active: v.optional(v.boolean()) },
  handler: async (ctx, a): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const w = await ownWebhook(ctx, a.id);
    const patch: Partial<Doc<"webhooks">> = {};
    if (a.events) patch.events = cleanEvents(a.events);
    if (a.active !== undefined && a.active !== w.active) {
      patch.active = a.active;
      if (a.active) Object.assign(patch, { failures: 0, disabledAt: undefined, disabledReason: undefined });
    }
    if (!Object.keys(patch).length) return;
    await ctx.db.patch(w._id, patch);
    const what = patch.active === true ? "включена" : patch.active === false ? "выключена" : "события изменены";
    await audit(ctx, me, "integration.webhook", `Подписка ${hostOf(w.url)}: ${what}`, { entityId: w._id, meta: { active: patch.active, events: patch.events } });
  },
});

export const remove = mutation({
  args: { id: v.id("webhooks") },
  handler: async (ctx, { id }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const w = await ownWebhook(ctx, id);
    await ctx.db.delete(id);
    // Журнал доставок удалённой подписки больше не нужен; хвост (если он длинный) уберёт очистка по сроку.
    const rows = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_webhook", (q) => q.eq("webhookId", id))
      .take(500);
    for (const r of rows) await ctx.db.delete(r._id);
    await audit(ctx, me, "integration.webhookRemoved", `Подписка на события удалена: ${hostOf(w.url)}`, { entityId: id, meta: { host: hostOf(w.url) } });
  },
});

/** «Отправить тестовое событие»: одна попытка, без повторов и без счёта неудач подписки. */
export const sendTest = mutation({
  args: { id: v.id("webhooks") },
  handler: async (ctx, { id }): Promise<Id<"webhookDeliveries">> => {
    const me = await requireRole(ctx, OWNER);
    const w = await ownWebhook(ctx, id);
    if (!(await hitLimit(ctx, `webhookTest:${me._id}`, TESTS_PER_MIN, 60_000))) throw new ConvexError("Слишком много проверок подряд — подождите минуту");
    const [deliveryId] = await enqueueEvent(ctx, [w], "webhook.test", { message: `Проверка подписки ${APP_NAME}`, webhookId: w._id }, true);
    return deliveryId!;
  },
});

// ── Доставка ─────────────────────────────────────────────────────────────────

type Job = { url: string; secret: string; body: string; event: string; eventId: string; attempt: number };

/** Взять доставку в работу. Подписку выключили или удалили — доставка закрывается без отправки. */
export const _claim = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }): Promise<Job | null> => {
    const d = await ctx.db.get(deliveryId);
    if (!d || d.status !== "pending") return null;
    const w = await ctx.db.get(d.webhookId);
    if (!w || (!w.active && !d.test)) {
      await ctx.db.patch(d._id, { status: "failed", nextAt: undefined, error: w ? "Подписка выключена — событие не отправлено" : "Подписка удалена" });
      return null;
    }
    return { url: w.url, secret: w.secret, body: d.body, event: d.event, eventId: d.eventId, attempt: d.attempts + 1 };
  },
});

export type PostResult = { ok: true; code: number } | { ok: false; code?: number; error: string };

/** POST подписанного события. Перенаправления не проходим: адрес подписки должен быть конечным. */
export async function postEvent(job: Job, secret: string, deliveryId: string, now = Date.now()): Promise<PostResult> {
  const check = checkPublicUrl(job.url);
  if (!check.ok) return { ok: false, error: `Адрес отклонён: ${check.reason}` };
  const t = Math.floor(now / 1000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(check.url.toString(), {
      method: "POST",
      redirect: "manual",
      signal: ctrl.signal,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "HomeMaxService-Webhooks/1",
        "X-HMS-Event": job.event,
        "X-HMS-Event-Id": job.eventId,
        "X-HMS-Delivery": deliveryId,
        "X-HMS-Attempt": String(job.attempt),
        [SIGNATURE_HEADER]: signatureHeader(secret, job.body, t),
      },
      body: job.body,
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return { ok: false, code: res.status || undefined, error: "Получатель ответил перенаправлением — укажите конечный адрес" };
    return res.ok ? { ok: true, code: res.status } : { ok: false, code: res.status, error: `Получатель ответил HTTP ${res.status}` };
  } catch {
    return { ok: false, error: ctrl.signal.aborted ? "Получатель не ответил за 10 секунд" : "Получатель недоступен" };
  } finally {
    clearTimeout(timer);
  }
}

export const _deliver = internalAction({
  args: { deliveryId: v.id("webhookDeliveries") },
  handler: async (ctx, { deliveryId }): Promise<void> => {
    const job = await ctx.runMutation(internal.webhooks._claim, { deliveryId });
    if (!job) return;
    let secret: string;
    try {
      secret = (await openSecret(job.secret, "webhook.secret")).value;
    } catch {
      console.warn(`webhooks: секрет подписки не расшифрован (доставка ${deliveryId})`);
      await ctx.runMutation(internal.webhooks._result, { deliveryId, ok: false, error: "Секрет подписи не расшифровывается: проверьте INTEGRATIONS_KEY" });
      return;
    }
    const r = await postEvent(job, secret, deliveryId);
    // Адрес и тело в лог не пишем — только id доставки и код.
    if (!r.ok) console.warn(`webhooks: доставка ${deliveryId} не удалась (попытка ${job.attempt}, код ${r.code ?? "—"})`);
    await ctx.runMutation(internal.webhooks._result, r.ok ? { deliveryId, ok: true, code: r.code } : { deliveryId, ok: false, code: r.code, error: r.error });
  },
});

async function disable(ctx: MutationCtx, w: Doc<"webhooks">, failures: number): Promise<void> {
  const reason = `${failures} неудачных попыток доставки подряд`;
  await ctx.db.patch(w._id, { active: false, failures, disabledAt: nowIso(), disabledReason: reason });
  const owners = (await ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect()).map((u) => u._id);
  const text = `Вебхук ${hostOf(w.url)} отключён: ${reason}. Проверьте сервер получателя и включите подписку снова в «Настройках → API и сайт»`;
  await notify(ctx, owners, text, { link: "/settings", tone: "bad" });
  await audit(ctx, "Система", "integration.webhookDisabled", `Подписка ${hostOf(w.url)} отключена: ${reason}`, { entityId: w._id, meta: { failures } });
  await markError(ctx, "api", `Вебхук ${hostOf(w.url)} отключён: ${reason}`);
}

/** Старые доставки — понемногу при каждой завершённой. */
async function prune(ctx: MutationCtx): Promise<void> {
  const before = new Date(Date.now() - KEEP_DELIVERIES_MS).toISOString();
  const old = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_created", (q) => q.lt("createdAt", before))
    .take(20);
  for (const d of old) await ctx.db.delete(d._id);
}

export const _result = internalMutation({
  args: { deliveryId: v.id("webhookDeliveries"), ok: v.boolean(), code: v.optional(v.number()), error: v.optional(v.string()) },
  handler: async (ctx, a): Promise<void> => {
    const d = await ctx.db.get(a.deliveryId);
    if (!d || d.status !== "pending") return;
    const w = await ctx.db.get(d.webhookId);
    const attempts = d.attempts + 1;
    const at = nowIso();
    if (a.ok) {
      await ctx.db.patch(d._id, { status: "ok", attempts, responseCode: a.code, error: undefined, nextAt: undefined, deliveredAt: at });
      if (w && !d.test) await ctx.db.patch(w._id, { failures: 0, lastDeliveryAt: at, lastError: undefined });
      await prune(ctx);
      return;
    }
    const error = (a.error ?? "Не доставлено").slice(0, 200);
    const final = !!d.test || attempts >= WEBHOOK_MAX_ATTEMPTS || !w || !w.active;
    if (final) {
      await ctx.db.patch(d._id, { status: "failed", attempts, responseCode: a.code, error, nextAt: undefined });
      await prune(ctx);
    } else {
      const delay = retryDelay(attempts);
      await ctx.db.patch(d._id, { attempts, responseCode: a.code, error, nextAt: new Date(Date.now() + delay).toISOString() });
      await ctx.scheduler.runAfter(delay, internal.webhooks._deliver, { deliveryId: d._id });
    }
    if (!w || d.test || !w.active) return;
    const failures = w.failures + 1;
    if (failures >= WEBHOOK_DISABLE_AFTER) await disable(ctx, w, failures);
    else await ctx.db.patch(w._id, { failures, lastError: error });
  },
});
