// Уведомления на телефон — web push (ТЗ п.23.6). Сотрудник или мастер включает их в меню профиля: браузер выдаёт
// подписку (адрес push-сервиса и ключи шифрования), сервер её хранит. notify (lib/domain.ts) ставит отправку,
// если подписка есть: сообщение шифруется по RFC 8291, сервер подписывается VAPID (RFC 8292) — lib/webpush.ts.
// Подписка, которую push-сервис больше не знает (404/410), удаляется. Ключи — VAPID_* (scripts/setup-vapid.mjs).
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { currentUser } from "./lib/access";
import { audit } from "./lib/audit";
import { nowIso } from "./lib/domain";
import { encryptPush, fromB64url, isPushEndpoint, validKeys, vapidAuthorization, vapidConfig } from "./lib/webpush";
import { pushMessage, type PushState } from "../src/data/push";

/** Устройств на человека — не больше: телефон, планшет, пара компьютеров. Старые вытесняются. */
const MAX_PER_USER = 5;
/** Сколько push-сервис хранит сообщение, если телефон офлайн: сутки. */
const TTL_S = 86400;
const TIMEOUT_MS = 15_000;

async function me(ctx: Parameters<typeof currentUser>[0]) {
  const u = await currentUser(ctx);
  if (!u) throw new ConvexError("Нужно войти");
  return u;
}

/** Ключ для браузера и есть ли на сервере подписка этого браузера (endpoint — из pushManager.getSubscription()). */
export const state = query({
  args: { endpoint: v.optional(v.string()) },
  handler: async (ctx, { endpoint }): Promise<PushState> => {
    const u = await currentUser(ctx);
    const vapid = vapidConfig();
    if (!u || !vapid) return { configured: !!vapid, subscribed: false };
    const sub = endpoint
      ? await ctx.db
          .query("pushSubscriptions")
          .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
          .first()
      : null;
    return { configured: true, publicKey: vapid.publicKey, subscribed: !!sub && sub.userId === u._id };
  },
});

export const subscribe = mutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string() },
  handler: async (ctx, a): Promise<void> => {
    const u = await me(ctx);
    if (!vapidConfig()) throw new ConvexError("Уведомления на телефон ещё не настроены владельцем");
    if (!isPushEndpoint(a.endpoint)) throw new ConvexError("Этот браузер не поддерживается для уведомлений — откройте приложение в Chrome, Safari, Firefox или Edge");
    if (!validKeys(a.p256dh, a.auth)) throw new ConvexError("Браузер выдал неверную подписку — попробуйте ещё раз");
    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", a.endpoint))
      .first();
    // Тот же браузер, другой вход — подписка переходит к тому, кто вошёл сейчас.
    if (existing) {
      await ctx.db.patch(existing._id, { userId: u._id, p256dh: a.p256dh, auth: a.auth });
      if (existing.userId === u._id) return;
    } else {
      await ctx.db.insert("pushSubscriptions", { userId: u._id, endpoint: a.endpoint, p256dh: a.p256dh, auth: a.auth, createdAt: nowIso() });
    }
    const mine = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", u._id))
      .collect();
    for (const old of mine.sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1)).slice(MAX_PER_USER)) await ctx.db.delete(old._id);
    await audit(ctx, u, "user.pushOn", "Включены уведомления на телефон", { entityId: u._id });
  },
});

/** Выключить на этом устройстве (и при выходе из аккаунта). Чужую подписку не трогаем. */
export const unsubscribe = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }): Promise<void> => {
    const u = await me(ctx);
    const sub = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .first();
    if (!sub || sub.userId !== u._id) return;
    await ctx.db.delete(sub._id);
    await audit(ctx, u, "user.pushOff", "Выключены уведомления на телефон", { entityId: u._id });
  },
});

export const _subs = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    // Отключённому — ничего, даже если подписка осталась.
    if (!user || user.active === false) return [];
    const subs = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return subs.map((s) => ({ id: s._id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth }));
  },
});

export const _result = internalMutation({
  args: { ok: v.array(v.id("pushSubscriptions")), gone: v.array(v.id("pushSubscriptions")) },
  handler: async (ctx, { ok, gone }): Promise<void> => {
    const at = nowIso();
    for (const id of ok) if (await ctx.db.get(id)) await ctx.db.patch(id, { lastOkAt: at });
    for (const id of gone) if (await ctx.db.get(id)) await ctx.db.delete(id);
  },
});

type Outcome = "ok" | "gone" | "failed";

/** Отправить одно сообщение на все устройства человека. */
export const send = internalAction({
  args: { userId: v.id("users"), text: v.string(), link: v.optional(v.string()) },
  handler: async (ctx, { userId, text, link }): Promise<Outcome[]> => {
    const vapid = vapidConfig();
    if (!vapid) return [];
    const subs: { id: Id<"pushSubscriptions">; endpoint: string; p256dh: string; auth: string }[] = await ctx.runQuery(internal.push._subs, { userId });
    const payload = new TextEncoder().encode(JSON.stringify(pushMessage(text, link)));
    const results: Outcome[] = [];
    const ok: Id<"pushSubscriptions">[] = [];
    const gone: Id<"pushSubscriptions">[] = [];
    for (const s of subs) {
      // Подписку проверяли при сохранении; повторно — на случай старых строк: к чужим адресам не ходим.
      if (!isPushEndpoint(s.endpoint) || !validKeys(s.p256dh, s.auth)) {
        gone.push(s.id);
        results.push("gone");
        continue;
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      try {
        const body = await encryptPush(payload, fromB64url(s.p256dh)!, fromB64url(s.auth)!);
        const res = await fetch(s.endpoint, {
          method: "POST",
          headers: { Authorization: await vapidAuthorization(vapid, s.endpoint), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: String(TTL_S), Urgency: "high" },
          body,
          signal: ctrl.signal,
        });
        if (res.ok) {
          ok.push(s.id);
          results.push("ok");
        } else if (res.status === 404 || res.status === 410) {
          // Подписка истекла или человек отозвал разрешение — больше не шлём.
          gone.push(s.id);
          results.push("gone");
        } else {
          console.warn(`Web push: HTTP ${res.status} от ${new URL(s.endpoint).hostname}`);
          results.push("failed");
        }
      } catch (e) {
        console.warn(`Web push: ${e instanceof Error && e.name === "AbortError" ? "таймаут" : "ошибка сети"} (${new URL(s.endpoint).hostname})`);
        results.push("failed");
      } finally {
        clearTimeout(timer);
      }
    }
    if (ok.length || gone.length) await ctx.runMutation(internal.push._result, { ok, gone });
    return results;
  },
});
