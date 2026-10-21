// Провайдеры облачных АТС (ТЗ п.19.1, п.22.1, п.5.7): Binotel, Zadarma, OnlinePBX. Владелец выбирает провайдера и вводит
// ключи в «Настройки → Телефония» (ключи — зашифрованы INTEGRATIONS_KEY, обратно не показываются), вставляет в АТС адрес
// /pbx/<провайдер>?key=<ключ АТС>. Вебхук провайдера → проверка ключа и подписи → calls._ingest (тот же путь, что
// у /pbx/events) → запись разговора по API провайдера → хранилище → AI. Звонок из карточки — calls.dial.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, httpAction, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx, type MutationCtx, type QueryCtx } from "./lib/functions";
import { OWNER, requireRole, STAFF } from "./lib/access";
import { audit, maskPhone } from "./lib/audit";

import { dropFile } from "./lib/files";
import { markError, markOk } from "./lib/health";
import { hitLimit } from "./lib/rateLimit";
import { PBX_ADAPTERS } from "./lib/pbx";
import type { PbxCreds, PbxSession, RecordingRef } from "./lib/pbx/types";
import { ProviderError } from "./lib/providerHttp";
import { fetchPublicFile } from "./lib/safeFetch";
import { integrationsKeyIssue, isSealed, openSecret, sealSecret, SecretBoxError } from "./lib/secretBox";
import { normalizeLogin } from "./lib/login";
import { RECORDING_MAX_BYTES } from "./ai";
import { env } from "./env";
import { cleanExtension, cleanPbxDomain, isPbxProvider, KCELL_DOMAIN, ONLINEPBX_DOMAIN, PBX_INFO, PBX_PROVIDERS, type DialResult, type PbxDialState, type PbxProvider, type PbxSettingsView } from "../src/data/pbx";
import { ROLE_LABEL } from "../src/data/catalog";
import { actionFor } from "./lib/tenantDb";
import { lockText } from "../src/data/plans";
import { requireModuleAction } from "./lib/tenant";
import { isSourceId, LINE_SOURCES_KEY, lineSources, MAX_LINES, normLine } from "./lib/lineSources";
import { SOURCES } from "../src/data/catalog";

const KEY = { provider: "pbx.provider", public: "pbx.public", secrets: "pbx.secrets", session: "pbx.sessionKey" } as const;
const pbxProvider = v.union(...PBX_PROVIDERS.map((p) => v.literal(p)));
/** Попыток скачать запись: провайдер мог ещё не выложить файл. */
const RECORDING_ATTEMPTS = 3;
const RECORDING_RETRY_MS = 2 * 60_000;
/** Звонков из карточки на сотрудника в минуту — защита от залипшей кнопки. */
const DIALS_PER_MINUTE = 10;

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

function parsePublic(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== "object") return {};
    return Object.fromEntries(Object.entries(o as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

export interface PbxState {
  provider: PbxProvider | null;
  config: Record<string, string>;
  sealed: string | null;
  session: string | null;
}

async function loadState(ctx: QueryCtx): Promise<PbxState> {
  const [p, pub, sec, ses] = await Promise.all([setting(ctx, KEY.provider), setting(ctx, KEY.public), setting(ctx, KEY.secrets), setting(ctx, KEY.session)]);
  const provider = p && isPbxProvider(p.value) ? p.value : null;
  return { provider, config: parsePublic(pub?.value), sealed: sec?.value ?? null, session: ses?.value ?? null };
}

/** Ключи подключения целиком (несекретные + расшифрованные секретные). Без ключа шифрования — ConvexError с причиной. */
async function openCreds(state: PbxState): Promise<PbxCreds> {
  if (!state.sealed) throw new ConvexError("Ключи АТС не сохранены");
  try {
    return { ...state.config, ...parsePublic((await openSecret(state.sealed, "pbx.credentials")).value) };
  } catch (e) {
    if (e instanceof SecretBoxError) throw new ConvexError(e.reason === "key" ? "Не задан ключ шифрования INTEGRATIONS_KEY" : "Ключи АТС не расшифровываются — введите их заново");
    throw e;
  }
}

async function openSession(state: PbxState): Promise<PbxSession> {
  if (!state.session) return { value: null };
  try {
    return { value: (await openSecret(state.session, "pbx.session")).value };
  } catch {
    return { value: null };
  }
}

/** Сессия API сменилась (OnlinePBX вошёл заново) — сохраняем зашифрованной. */
async function keepSession(ctx: ActionCtx, before: PbxSession, after: PbxSession): Promise<void> {
  if (before.value === after.value) return;
  const sealed = after.value ? await sealSecret(after.value, "pbx.session").catch(() => null) : null;
  await ctx.runMutation(internal.pbx._saveSession, { sealed });
}

export const _state = internalQuery({ args: {}, handler: (ctx): Promise<PbxState> => loadState(ctx) });

export const _saveSession = internalMutation({
  args: { sealed: v.union(v.string(), v.null()) },
  handler: async (ctx, { sealed }) => {
    if (sealed !== null && !isSealed(sealed)) throw new ConvexError("Сессия АТС должна быть зашифрована");
    await putSetting(ctx, KEY.session, sealed);
  },
});

// ── Настройки владельца ──────────────────────────────────────────────────────

export const settings = query({
  args: {},
  handler: async (ctx): Promise<PbxSettingsView> => {
    await requireRole(ctx, OWNER);
    const s = await loadState(ctx);
    const staff = (await ctx.db.query("users").collect()).filter((u) => u.role && u.role !== "executor" && u.active !== false);
    return {
      provider: s.provider,
      config: s.config,
      hasSecrets: !!s.sealed,
      keyIssue: integrationsKeyIssue(),
      siteUrl: env("CONVEX_SITE_URL") ?? null,
      hasPbxSecret: !!(await setting(ctx, "pbxSecret")),
      staff: staff.map((u) => ({ id: u._id, name: u.name ?? "Сотрудник", role: ROLE_LABEL[u.role!], extension: u.pbxExtension ?? null })),
      lines: Object.entries(await lineSources(ctx)).map(([number, source]) => ({ number, source })),
    };
  },
});

/** Проверка полей: обязательные заполнены, домен OnlinePBX — вида company.onpbx.ru, длина разумная. */
function cleanFields(provider: PbxProvider, raw: Record<string, string>, keepSecrets: boolean): { pub: Record<string, string>; secret: Record<string, string> } {
  const pub: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const f of PBX_INFO[provider].fields) {
    const value = (raw[f.key] ?? "").trim();
    if (value.length > 200) throw new ConvexError(`${f.label}: слишком длинное значение`);
    if (!value) {
      if (f.optional || (f.secret && keepSecrets)) continue;
      throw new ConvexError(`Заполните поле «${f.label}»`);
    }
    const domain = f.key === "domain" ? cleanPbxDomain(value) : null;
    if (domain !== null && provider === "onlinepbx" && !ONLINEPBX_DOMAIN.test(domain)) throw new ConvexError("Домен АТС — вида company.onpbx.ru");
    if (domain !== null && provider === "kcell" && !KCELL_DOMAIN.test(domain)) throw new ConvexError("Адрес АТС Kcell — вида company.vpbx.kcell.kz");
    if (f.key === "companyId" && !/^\d{1,12}$/.test(value)) throw new ConvexError("Номер компании Binotel — только цифры");
    (f.secret ? secret : pub)[f.key] = domain ?? value;
  }
  return { pub, secret };
}

/**
 * Подключить провайдера. Секретные поля можно оставить пустыми, если провайдер тот же, — остаются прежние.
 * Шифруем в action (Web Crypto), сохраняет мутация от имени владельца.
 */
export const save = action({
  args: { provider: pbxProvider, fields: v.record(v.string(), v.string()) },
  handler: async (ctx, { provider, fields }): Promise<void> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    await requireModuleAction(ctx, "telephony");
    const state: PbxState = await ctx.runQuery(internal.pbx._state, {});
    const same = state.provider === provider && !!state.sealed;
    const { pub, secret } = cleanFields(provider, fields, same);
    let merged = secret;
    if (same && PBX_INFO[provider].fields.some((f) => f.secret && !secret[f.key])) {
      const old = await openCreds(state);
      merged = Object.fromEntries(PBX_INFO[provider].fields.filter((f) => f.secret).map((f) => [f.key, secret[f.key] ?? old[f.key] ?? ""]));
    }
    let sealed: string;
    try {
      sealed = await sealSecret(JSON.stringify(merged), "pbx.credentials");
    } catch (e) {
      if (e instanceof SecretBoxError) throw new ConvexError(integrationsKeyIssue() ?? "Не задан ключ шифрования INTEGRATIONS_KEY");
      throw e;
    }
    await ctx.runMutation(internal.pbx._save, { provider, config: JSON.stringify(pub), sealed });
  },
});

export const _save = internalMutation({
  args: { provider: pbxProvider, config: v.string(), sealed: v.string() },
  handler: async (ctx, { provider, config, sealed }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    if (!isSealed(sealed)) throw new ConvexError("Ключи АТС должны быть зашифрованы");
    const before = (await setting(ctx, KEY.provider))?.value;
    await putSetting(ctx, KEY.provider, provider);
    await putSetting(ctx, KEY.public, config);
    await putSetting(ctx, KEY.secrets, sealed);
    await putSetting(ctx, KEY.session, null);
    // Адрес для АТС содержит ключ АТС — без него провайдер не сможет присылать события.
    if (!(await setting(ctx, "pbxSecret"))) {
      const value = Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => b.toString(16).padStart(2, "0")).join("");
      await ctx.db.insert("settings", { key: "pbxSecret", value });
    }
    const label = PBX_INFO[provider].label;
    await audit(ctx, me, "integration.pbxProvider", before === provider ? `Телефония: обновлены ключи ${label}` : `Телефония: подключён провайдер ${label}`, { entityId: "pbx", meta: { provider, previous: before ?? null } });
  },
});

export const disable = mutation({
  args: {},
  handler: async (ctx): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const before = (await setting(ctx, KEY.provider))?.value;
    if (!before) return;
    for (const key of Object.values(KEY)) await putSetting(ctx, key, null);
    await audit(ctx, me, "integration.pbxProvider", `Телефония: провайдер ${isPbxProvider(before) ? PBX_INFO[before].label : before} отключён, ключи удалены`, { entityId: "pbx", meta: { provider: before, disabled: true } });
  },
});

/** Внутренний номер сотрудника. Один номер — один сотрудник: иначе входящий привязался бы не к тому. */
export const setExtension = mutation({
  args: { userId: v.id("users"), extension: v.string() },
  handler: async (ctx, { userId, extension }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    const u = await ctx.db.get(userId);
    if (!u || !u.role || u.role === "executor") throw new ConvexError("Сотрудник не найден");
    const ext = cleanExtension(extension);
    if (ext === "invalid") throw new ConvexError("Внутренний номер — от 1 до 8 цифр");
    if ((u.pbxExtension ?? null) === ext) return;
    if (ext) {
      const taken = await ctx.db
        .query("users")
        .withIndex("by_pbx_extension", (q) => q.eq("pbxExtension", ext))
        .first();
      if (taken && taken._id !== userId) throw new ConvexError(`Номер ${ext} уже у сотрудника ${taken.name ?? ""}`.trim());
    }
    await ctx.db.patch(userId, { pbxExtension: ext ?? undefined });
    await audit(ctx, me, "user.pbxExtension", ext ? `${u.name ?? "Сотрудник"}: внутренний номер АТС ${ext}` : `${u.name ?? "Сотрудник"}: внутренний номер АТС снят`, { entityId: userId, meta: { extension: ext } });
  },
});

/**
 * Источник по номеру линии (колл-трекинг): звонки на номер из объявлений OLX — заявки с источником «OLX».
 * Список заменяется целиком; пустой — все звонки «Телефон».
 */
export const setLines = mutation({
  args: { lines: v.array(v.object({ number: v.string(), source: v.string() })) },
  handler: async (ctx, { lines }): Promise<void> => {
    const me = await requireRole(ctx, OWNER);
    if (lines.length > MAX_LINES) throw new ConvexError(`Не больше ${MAX_LINES} номеров`);
    const map: Record<string, keyof typeof SOURCES> = {};
    for (const l of lines) {
      const number = normLine(l.number);
      if (!/^\d{7,15}$/.test(number)) throw new ConvexError(`Номер «${l.number.slice(0, 30)}» — от 7 до 15 цифр`);
      if (!isSourceId(l.source)) throw new ConvexError("Неизвестный источник");
      if (map[number]) throw new ConvexError(`Номер ${number} указан дважды`);
      map[number] = l.source;
    }
    if (JSON.stringify(await lineSources(ctx)) === JSON.stringify(map)) return;
    await putSetting(ctx, LINE_SOURCES_KEY, Object.keys(map).length ? JSON.stringify(map) : null);
    const text = Object.entries(map).map(([n, s]) => `${maskPhone(n)} → ${SOURCES[s].label}`).join(", ");
    await audit(ctx, me, "integration.pbxLines", text ? `Телефония: источники по номерам — ${text}` : "Телефония: источники по номерам сняты", { entityId: "pbx", meta: { lines: Object.keys(map).length } });
  },
});

/** «Проверить подключение»: безобидный запрос к API провайдера. Итог — в «Состоянии системы». */
export const check = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    const state: PbxState = await ctx.runQuery(internal.pbx._state, {});
    if (!state.provider) throw new ConvexError("Провайдер АТС не выбран");
    const creds = await openCreds(state);
    const before = await openSession(state);
    const session = { ...before };
    try {
      const note = await PBX_ADAPTERS[state.provider].check(creds, session);
      await keepSession(ctx, before, session);
      await ctx.runMutation(internal.health._mark, { key: "pbx", ok: true, note });
      return note;
    } catch (e) {
      const text = e instanceof ProviderError ? e.message : "проверка не удалась";
      await ctx.runMutation(internal.health._mark, { key: "pbx", ok: false, note: text });
      throw new ConvexError(text);
    }
  },
});

// ── Звонок из карточки ───────────────────────────────────────────────────────

/** Можно ли звонить через АТС — для кнопки «Позвонить через АТС». */
export const dialState = query({
  args: {},
  handler: async (ctx): Promise<PbxDialState> => {
    const me = await requireRole(ctx, STAFF);
    const s = await loadState(ctx);
    if (!s.provider || !s.sealed) return { enabled: false, provider: null, reason: "АТС не подключена — звонок с телефона" };
    if (!me.pbxExtension) return { enabled: false, provider: s.provider, reason: "У вас не указан внутренний номер АТС — звонок с телефона" };
    return { enabled: true, provider: s.provider };
  },
});

export interface DialStart {
  state: PbxState | null;
  extension: string | null;
  phone: string;
}

/** Начало звонка: сотрудник, лимит, номер клиента (11 цифр), настройки АТС. */
export const _dialStart = internalMutation({
  args: { phone: v.string() },
  handler: async (ctx, { phone }): Promise<DialStart> => {
    const me = await requireRole(ctx, STAFF);
    const p = normalizeLogin(phone.replace(/[^\d+]/g, ""));
    if (!/^7\d{10}$/.test(p)) throw new ConvexError("Неверный номер телефона");
    if (!(await hitLimit(ctx, `dial:${me._id}`, DIALS_PER_MINUTE, 60_000))) throw new ConvexError("Слишком много звонков подряд — подождите минуту");
    const state = await loadState(ctx);
    return { state: state.provider && state.sealed ? state : null, extension: me.pbxExtension ?? null, phone: p };
  },
});

export const _dialed = internalMutation({
  args: { provider: pbxProvider, phone: v.string(), ok: v.boolean(), error: v.optional(v.string()), context: v.optional(v.string()) },
  handler: async (ctx, a): Promise<void> => {
    const me = await requireRole(ctx, STAFF);
    const label = PBX_INFO[a.provider].label;
    if (a.ok) await markOk(ctx, "pbx", `Звонок через ${label}`);
    else await markError(ctx, "pbx", `Звонок через ${label}: ${a.error ?? "ошибка"}`);
    await audit(ctx, me, "call.dial", a.ok ? `Звонок через АТС ${label} на номер ${maskPhone(a.phone)}${a.context ? ` (${a.context})` : ""}` : `Звонок через АТС ${label} не начат: ${a.error ?? "ошибка"}`, {
      entityId: "pbx",
      meta: { provider: a.provider, ok: a.ok },
    });
  },
});

/** Звонок через АТС: АТС звонит сотруднику на внутренний номер и соединяет с клиентом; не подключено — tel: с телефона. */
export async function dialHandler(ctx: ActionCtx, phone: string, context?: string): Promise<DialResult> {
  // Звонок через АТС — модуль «Телефония» (ТЗ §24.3).
  await requireModuleAction(ctx, "telephony");
  const start: DialStart = await ctx.runMutation(internal.pbx._dialStart, { phone });
  const href = `tel:+${start.phone}`;
  if (!start.state?.provider) return { mode: "tel", href, reason: "АТС не подключена — звоните с телефона" };
  if (!start.extension) return { mode: "tel", href, reason: "У вас не указан внутренний номер АТС — звоните с телефона" };
  const provider = start.state.provider;
  const creds = await openCreds(start.state);
  const before = await openSession(start.state);
  const session = { ...before };
  try {
    await PBX_ADAPTERS[provider].dial(creds, session, start.extension, start.phone);
    await keepSession(ctx, before, session);
    await ctx.runMutation(internal.pbx._dialed, { provider, phone: start.phone, ok: true, context });
    return { mode: "pbx", provider };
  } catch (e) {
    const error = e instanceof ProviderError ? e.message : "АТС не ответила";
    console.warn(`АТС: звонок не начат (${provider})`);
    await ctx.runMutation(internal.pbx._dialed, { provider, phone: start.phone, ok: false, error, context });
    return { mode: "tel", href, reason: `${error} — звоните с телефона` };
  }
}

// ── Вебхук провайдера ────────────────────────────────────────────────────────

const MAX_BODY = 64 * 1024;

export const _callByExternal = internalQuery({
  args: { externalId: v.string() },
  handler: async (ctx, { externalId }): Promise<Id<"calls"> | null> =>
    (
      await ctx.db
        .query("calls")
        .withIndex("by_external", (q) => q.eq("externalId", externalId))
        .first()
    )?._id ?? null,
});

/**
 * POST /pbx/<провайдер>?key=<ключ АТС>: ключ АТС (как у /pbx/events), выбранный владельцем провайдер, подпись провайдера
 * (у Zadarma) → события в calls._ingest → скачивание записи фоном. GET — проверка адреса (Zadarma: zd_echo).
 */
export function pbxWebhook(provider: PbxProvider) {
  return httpAction(async (raw, request) => {
    const url = new URL(request.url);
    // Ключ АТС определяет и компанию (ТЗ §2.5): у каждой свой.
    const header = request.headers.get("x-pbx-secret");
    const given = header ?? url.searchParams.get("key");
    const found = await raw.runQuery(internal.calls._pbxTenant, { given: (given ?? "").slice(0, 200) });
    if (!found.configured) return new Response("not configured", { status: 503 });
    if (!given || !found.tenantId) {
      await raw.runMutation(internal.calls._pbxRejected, { via: header !== null ? "header" : given ? "query" : "none" });
      return new Response("forbidden", { status: 403 });
    }
    const ctx = actionFor(raw, found.tenantId);
    const reject = async (status: number, body: string, why: string) => {
      await ctx.runMutation(internal.health._mark, { key: "pbx", ok: false, note: why });
      return new Response(body, { status });
    };
    if (found.locked) return reject(403, "module disabled", lockText("telephony"));
    if (request.method === "GET") {
      // Zadarma проверяет адрес: GET ?zd_echo=<строка> — ответ должен быть этой строкой.
      const echo = url.searchParams.get("zd_echo");
      if (echo !== null) return /^[\w-]{1,64}$/.test(echo) ? new Response(echo, { status: 200, headers: { "Content-Type": "text/plain" } }) : new Response("bad echo", { status: 400 });
      return new Response("ok", { status: 200 });
    }
    if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return reject(413, "too large", "АТС прислала слишком большое событие (больше 64 КБ)");
    const body = await request.text();
    if (body.length > MAX_BODY) return reject(413, "too large", "АТС прислала слишком большое событие (больше 64 КБ)");
    const state: PbxState = await ctx.runQuery(internal.pbx._state, {});
    const label = PBX_INFO[provider].label;
    if (state.provider !== provider || !state.sealed) return reject(409, "provider not enabled", `${label} прислал событие, но в настройках выбран другой провайдер или ключи не сохранены`);
    let creds: PbxCreds;
    try {
      creds = await openCreds(state);
    } catch (e) {
      return reject(503, "not configured", e instanceof ConvexError ? String(e.data) : "Ключи АТС не открываются");
    }
    const parsed = await PBX_ADAPTERS[provider].parseWebhook({ method: request.method, query: url.searchParams, headers: request.headers, body, contentType: request.headers.get("content-type") ?? "" }, creds);
    if (!parsed.ok) {
      if (parsed.status === 403) await ctx.runMutation(internal.calls._pbxRejected, { via: "header" });
      return reject(parsed.status, "rejected", parsed.why);
    }
    const ids = new Map<string, Id<"calls">>();
    try {
      for (const e of parsed.events) ids.set(e.externalId, await ctx.runMutation(internal.calls._ingest, e));
      if (parsed.recording) {
        const callId = ids.get(parsed.recording.externalId) ?? (await ctx.runQuery(internal.pbx._callByExternal, { externalId: parsed.recording.externalId }));
        if (callId) await ctx.scheduler.runAfter(0, internal.pbx.fetchRecording, { callId, ref: parsed.recording.ref, attempt: 1 });
      }
      if (!parsed.events.length) await ctx.runMutation(internal.health._mark, { key: "pbx", ok: true, note: `Событие ${label} принято` });
    } catch (e) {
      console.error(`АТС ${provider}: событие не сохранено: ${e instanceof Error ? e.name : "ошибка"}`);
      return reject(500, "error", `Событие ${label} не сохранено — внутренняя ошибка`);
    }
    return new Response(parsed.reply.body, { status: parsed.reply.status, headers: { "Content-Type": parsed.reply.contentType } });
  });
}

// ── Запись разговора ─────────────────────────────────────────────────────────

const recordingRef = v.union(v.object({ kind: v.literal("url"), url: v.string() }), v.object({ kind: v.literal("id"), id: v.string() }));

/**
 * Запись от провайдера: ссылка — по API провайдера с его ключами (у Binotel и Zadarma — временная), скачивание —
 * только с публичного https-адреса (lib/safeFetch.ts, до 50 МБ). Не готова — ещё две попытки через 2 минуты.
 */
export const fetchRecording = internalAction({
  args: { callId: v.id("calls"), ref: recordingRef, attempt: v.number() },
  handler: async (ctx, { callId, ref, attempt }): Promise<void> => {
    const call = await ctx.runQuery(internal.calls._get, { id: callId });
    if (!call || call.recordingId) return;
    const state: PbxState = await ctx.runQuery(internal.pbx._state, {});
    if (!state.provider) return;
    try {
      const creds = await openCreds(state);
      const before = await openSession(state);
      const session = { ...before };
      const link = await PBX_ADAPTERS[state.provider].recordingUrl(creds, session, ref as RecordingRef);
      await keepSession(ctx, before, session);
      const blob = await fetchPublicFile(link, { maxBytes: RECORDING_MAX_BYTES, timeoutMs: 120_000, maxRedirects: 3 });
      if (/^(text\/|application\/(json|xml|xhtml))/i.test(blob.type)) throw new ProviderError("по ссылке не аудиофайл");
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.pbx._recordingStored, { callId, storageId });
    } catch (e) {
      const reason = e instanceof ProviderError ? e.message : e instanceof ConvexError ? String(e.data) : "ошибка загрузки";
      // Ссылку и номер не пишем: в ссылках провайдеров бывают токены.
      console.warn(`АТС: запись звонка ${callId} не скачана (попытка ${attempt}) — ${reason}`);
      if (attempt < RECORDING_ATTEMPTS) await ctx.scheduler.runAfter(RECORDING_RETRY_MS, internal.pbx.fetchRecording, { callId, ref, attempt: attempt + 1 });
      else await ctx.runMutation(internal.pbx._recordingFailed, { callId, error: `Запись не скачана: ${reason}` });
    }
  },
});

/** Запись в хранилище → на звонок и в разбор AI (как запись по ссылке из /pbx/events). Клиента удалили — файл не храним. */
export const _recordingStored = internalMutation({
  args: { callId: v.id("calls"), storageId: v.id("_storage") },
  handler: async (ctx, { callId, storageId }): Promise<void> => {
    const c = await ctx.db.get(callId);
    const anonymized = c?.clientId ? !!(await ctx.db.get(c.clientId))?.anonymizedAt : false;
    if (!c || c.recordingId || anonymized) {
      await dropFile(ctx, storageId);
      return;
    }
    await ctx.db.patch(callId, { recordingId: storageId, aiStatus: "pending", aiError: undefined });
    await ctx.scheduler.runAfter(0, internal.ai.processCall, { callId });
    await markOk(ctx, "pbx", "Запись разговора получена");
  },
});

export const _recordingFailed = internalMutation({
  args: { callId: v.id("calls"), error: v.string() },
  handler: async (ctx, { callId, error }): Promise<void> => {
    const c = await ctx.db.get(callId);
    if (!c || c.recordingId) return;
    await ctx.db.patch(callId, { aiStatus: "failed", aiError: error.slice(0, 300) });
    await markError(ctx, "pbx", error);
  },
});
