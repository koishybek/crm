// WhatsApp Business Cloud API (Meta) — канал единого чата «Сообщения».
// Вебхук /whatsapp/webhook (маршруты — в http.ts): подпись по сырым байтам → разбор → обработка фоном, Meta сразу 200.
// Входящие кладём через inbox.ingest, как Telegram: повтор доставки ничего не дублирует, окно ответа 24 часа,
// уведомления и авто-заявка — по общим правилам чата. Ответ оператора уходит через lib/outbound.ts → sendWhatsApp.
// Подключение — только переменные окружения Convex: токен, ID номера, App Secret и verify token в базе не хранятся.
import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { httpAction, internalAction, internalMutation, internalQuery, query, type ActionCtx, type QueryCtx } from "../_generated/server";
import { canTranscribe, transcribe } from "../ai";
import { env } from "../env";
import { OWNER, requireRole } from "../lib/access";
import { audit } from "../lib/audit";
import { PLACEHOLDER, REPLY_BLOCK, whatsappWindowClosed } from "../lib/chat";
import { safeEqual } from "../lib/crypto";
import { nowIso } from "../lib/domain";
import { markOk } from "../lib/health";
import { contactPhone } from "../lib/phone";
import {
  asNumber,
  asString,
  isMetaMediaUrl,
  isRecord,
  isSystemicWaError,
  locationText,
  parseWebhook,
  safeFileName,
  storageMime,
  UNSUPPORTED_TEXT,
  verifySignature,
  vWaEvent,
  waErrorText,
  WINDOW_CLOSED_CODE,
  type WaEvent,
  type WaMessage,
  type WaStatus,
} from "../lib/whatsapp";
import { phone as fmtPhone } from "../../src/lib/format";
import type { MessageKind, WhatsAppSettings } from "../../src/data/types";

// ── Настройки ────────────────────────────────────────────────────────────────

/** Версия Graph API по умолчанию: v26.0 (29.07.2026). v17–v20 из старых примеров Meta уже отключила. */
const DEFAULT_GRAPH_VERSION = "v26.0";
export const WEBHOOK_PATH = "/whatsapp/webhook";
/** Токен System User, ID номера, App Secret (подпись вебхука), verify token (проверка адреса вебхука). */
const REQUIRED = ["WHATSAPP_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_APP_SECRET", "WHATSAPP_VERIFY_TOKEN"] as const;

/** Токен System User. WHATSAPP_ACCESS_TOKEN — то же значение под именем из исследования интеграции. */
const accessToken = (): string | undefined => env("WHATSAPP_TOKEN") ?? env("WHATSAPP_ACCESS_TOKEN");

/** Какие обязательные переменные не заданы — имена, без значений. */
export function missingEnv(): string[] {
  return REQUIRED.filter((key) => !(key === "WHATSAPP_TOKEN" ? accessToken() : env(key)));
}

/** WhatsApp подключён полностью: принимает вебхуки и может отвечать клиентам. */
export const configured = (): boolean => missingEnv().length === 0;

export function graphVersion(): string {
  const version = env("WHATSAPP_GRAPH_VERSION");
  return version && /^v\d{2,3}\.\d$/.test(version) ? version : DEFAULT_GRAPH_VERSION;
}

interface GraphConfig {
  token: string;
  phoneNumberId: string;
  version: string;
}

/** Для отправки и скачивания файлов нужны токен и ID номера. */
function graphConfig(): GraphConfig | null {
  const token = accessToken();
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  return token && phoneNumberId ? { token, phoneNumberId, version: graphVersion() } : null;
}

/** Можно ли отвечать клиентам (без этого поле ответа выключено с «Канал не подключён»). */
export const canSend = (): boolean => graphConfig() !== null;

// ── Graph API ────────────────────────────────────────────────────────────────

const GRAPH = "https://graph.facebook.com";
const GRAPH_TIMEOUT_MS = 20_000;

type GraphResult = { ok: true; data: Record<string, unknown> } | { ok: false; status: number; code: number | null; timeout: boolean };

/** Запрос к Graph API. Тело ошибки в лог не пишем (в нём бывает номер клиента) — только HTTP-статус и код Meta. */
async function graph(cfg: GraphConfig, path: string, body?: Record<string, unknown>): Promise<GraphResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GRAPH_TIMEOUT_MS);
  try {
    const res = await fetch(`${GRAPH}/${cfg.version}/${path}`, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      // Не JSON (страница прокси) — разберём как ошибку ниже.
    }
    if (res.ok && isRecord(json)) return { ok: true, data: json };
    const error = isRecord(json) && isRecord(json.error) ? json.error : undefined;
    return { ok: false, status: res.status, code: asNumber(error?.code) ?? null, timeout: false };
  } catch (e) {
    return { ok: false, status: 0, code: null, timeout: e instanceof Error && e.name === "AbortError" };
  } finally {
    clearTimeout(timer);
  }
}

const errName = (e: unknown): string => (e instanceof ConvexError && typeof e.data === "string" ? e.data : e instanceof Error ? e.name : "ошибка");

// ── Ответ оператора (lib/outbound.ts) ────────────────────────────────────────

export type WaSendResult = { ok: true; wamid: string } | { ok: false; error: string; systemic: boolean; closeWindow: boolean };

const sendFailed = (error: string, systemic: boolean, closeWindow = false): WaSendResult => ({ ok: false, error, systemic, closeWindow });

/** Номер (wa_id) — полем to с «+» (без него Meta подставит код страны нашего номера); BSUID клиента со скрытым номером — полем recipient. */
const recipientOf = (externalId: string): Record<string, string> => (/^\d{8,15}$/.test(externalId) ? { to: `+${externalId}` } : { recipient: externalId });

/**
 * Текст клиенту. Свободный текст WhatsApp разрешает только 24 часа после последнего сообщения клиента —
 * вне окна Meta не вызываем вовсе. wamid из ответа — id сообщения для статусов доставки.
 */
export async function sendWhatsApp(c: { externalId: string; replyUntil?: string }, text: string): Promise<WaSendResult> {
  const cfg = graphConfig();
  if (!cfg) return sendFailed(REPLY_BLOCK.notConnected, true);
  if (whatsappWindowClosed(c.replyUntil, Date.now())) return sendFailed(REPLY_BLOCK.windowClosed, false);
  const res = await graph(cfg, `${encodeURIComponent(cfg.phoneNumberId)}/messages`, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...recipientOf(c.externalId),
    type: "text",
    text: { preview_url: false, body: text },
  });
  if (res.ok) {
    const first = Array.isArray(res.data.messages) ? res.data.messages.find(isRecord) : undefined;
    const wamid = asString(first?.id);
    return wamid ? { ok: true, wamid } : sendFailed("WhatsApp не вернул номер сообщения — проверьте, дошло ли оно", true);
  }
  if (res.code === null) {
    console.warn(`whatsapp: отправка без ответа Meta (HTTP ${res.status}${res.timeout ? ", таймаут" : ""})`);
    // Таймаут — Meta могла принять сообщение, поэтому автоповтора нет: решает оператор.
    if (res.timeout) return sendFailed("WhatsApp не ответил вовремя — сообщение могло уйти. Проверьте позже, прежде чем повторять", true);
    return sendFailed(res.status ? `WhatsApp не принял сообщение (HTTP ${res.status})` : "Нет связи с WhatsApp — попробуйте ещё раз", true);
  }
  console.warn(`whatsapp: Meta отклонила отправку, код ${res.code}`);
  return sendFailed(waErrorText(res.code), isSystemicWaError(res.code), res.code === WINDOW_CLOSED_CODE);
}

// ── Файлы клиента ────────────────────────────────────────────────────────────

/** Рантайм Convex даёт action 64 МиБ памяти — крупнее не тянем (у Meta фото до 5 МБ, аудио и видео до 16 МБ). */
const MEDIA_MAX_BYTES = 25 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 60_000;

/**
 * Файл из вебхука: id у Meta живёт 7 дней, ссылка на скачивание — 5 минут, поэтому берём её прямо перед скачиванием.
 * Токен уходит только на хосты Meta. 404 — ссылка протухла, вторая попытка берёт новую. null — файл не получен.
 */
async function downloadMedia(cfg: GraphConfig, mediaId: string): Promise<Blob | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const info = await graph(cfg, `${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(cfg.phoneNumberId)}`);
    if (!info.ok) {
      console.warn(`whatsapp: нет ссылки на файл (HTTP ${info.status}, код ${info.code ?? "—"})`);
      if (info.code !== null) return null; // Meta ответила ошибкой — повтор не поможет
      continue;
    }
    const url = asString(info.data.url);
    const size = asNumber(info.data.file_size);
    if (!url || !isMetaMediaUrl(url) || (size !== undefined && size > MEDIA_MAX_BYTES)) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), MEDIA_TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${cfg.token}` }, signal: ctrl.signal });
      if (res.status === 404) continue;
      if (!res.ok || Number(res.headers.get("content-length") ?? 0) > MEDIA_MAX_BYTES) return null;
      const blob = await res.blob();
      if (blob.size > MEDIA_MAX_BYTES) return null;
      // Тип — из белого списка: html или svg из чата не откроются в браузере как страница.
      return new Blob([blob], { type: storageMime(asString(info.data.mime_type)) });
    } catch (e) {
      console.warn(`whatsapp: файл не скачан: ${errName(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

/** Скачать файл и положить в хранилище: оператор откроет фото, документ или голосовое прямо в «Сообщениях». */
async function keepMedia(ctx: ActionCtx, cfg: GraphConfig | null, mediaId: string): Promise<{ fileId?: Id<"_storage">; blob?: Blob }> {
  const blob = cfg ? await downloadMedia(cfg, mediaId) : null;
  if (!blob) return {};
  try {
    return { fileId: await ctx.storage.store(blob), blob };
  } catch (e) {
    console.warn(`whatsapp: файл не сохранён: ${errName(e)}`);
    return { blob };
  }
}

/** Голосовое → текст «🎤 …» тем же AI, что расшифровывает звонки. */
async function voiceText(ctx: ActionCtx, blob: Blob | undefined): Promise<string> {
  if (!canTranscribe()) return PLACEHOLDER.voice;
  if (!blob) return PLACEHOLDER.voiceFailed;
  try {
    const { text } = await transcribe(blob);
    await ctx.runMutation(internal.health._mark, { key: "ai", ok: true, note: "Расшифровка голосового WhatsApp" });
    return text ? `🎤 ${text}` : PLACEHOLDER.voiceFailed;
  } catch (e) {
    console.warn(`whatsapp: голосовое не расшифровано: ${errName(e)}`);
    await ctx.runMutation(internal.health._mark, { key: "ai", ok: false, note: `Расшифровка голосового WhatsApp: ${errName(e)}` });
    return PLACEHOLDER.voiceFailed;
  }
}

// ── Входящие ─────────────────────────────────────────────────────────────────

interface Content {
  kind: MessageKind;
  text: string;
  fileId?: Id<"_storage">;
  fileName?: string;
  /** false — без уведомления команде. */
  notify?: boolean;
  /** false — сообщение не повод для авто-заявки (геопозиция, служебные отметки). */
  autoLead?: boolean;
}

/** Служебная отметка в ленте: реакция, смена номера, то, что WhatsApp не передаёт. Заявку из неё не собираем. */
const systemNote = (text: string, notify = false): Content => ({ kind: "system", text, notify, autoLead: false });

const unsupported = (m: WaMessage): Content => systemNote(m.errors?.length ? `${UNSUPPORTED_TEXT}. ${waErrorText(m.errors[0]!.code)}` : UNSUPPORTED_TEXT, true);

async function mediaContent(ctx: ActionCtx, cfg: GraphConfig | null, m: WaMessage, caption: string): Promise<Content> {
  if (!m.media) return unsupported(m);
  const { fileId, blob } = await keepMedia(ctx, cfg, m.media.id);
  if (m.type === "image") return { kind: "image", text: caption || PLACEHOLDER.image, fileId, fileName: "photo.jpg" };
  if (m.type === "video") return { kind: "file", text: caption || PLACEHOLDER.video, fileId, fileName: "video.mp4" };
  if (m.type === "audio") return { kind: "audio", text: await voiceText(ctx, blob), fileId, fileName: m.media.voice ? "voice.ogg" : safeFileName(m.media.fileName, "audio") };
  const image = m.media.mimeType?.startsWith("image/") === true;
  return { kind: image ? "image" : "file", text: caption || (image ? PLACEHOLDER.image : PLACEHOLDER.file), fileId, fileName: safeFileName(m.media.fileName, "document") };
}

/** Что прислал клиент — в вид сообщения «Сообщений». */
async function readContent(ctx: ActionCtx, cfg: GraphConfig | null, m: WaMessage): Promise<Content> {
  const text = m.text ?? "";
  switch (m.type) {
    case "text":
      return { kind: "text", text };
    case "interactive": // нажатая кнопка или пункт списка — его заголовок
    case "button":
      return text ? { kind: "text", text } : unsupported(m);
    case "contacts":
      return { kind: "text", text: text ? `Контакт: ${text}` : "Контакт" };
    case "sticker":
      return { kind: "text", text: "Стикер" };
    case "location":
      return m.location ? { kind: "location", text: locationText(m.location), autoLead: false } : unsupported(m);
    case "image":
    case "video":
    case "document":
    case "audio":
      return mediaContent(ctx, cfg, m, text);
    case "reaction":
      return systemNote(text ? `Клиент отреагировал ${text}` : "Клиент убрал реакцию");
    case "system":
      return systemNote(m.system?.newWaId ? `Клиент сменил номер WhatsApp на ${fmtPhone(m.system.newWaId)}` : "Клиент сменил номер или учётную запись WhatsApp");
    default:
      return unsupported(m);
  }
}

/** true — сообщение обработано (или его не нужно обрабатывать). */
async function handleMessage(ctx: ActionCtx, cfg: GraphConfig | null, m: WaMessage): Promise<boolean> {
  if (m.group) return true; // группы (Groups API) — не наш сценарий
  // Новый диалог — по номеру, а у клиента со скрытым номером — по BSUID.
  const key = m.waId ?? m.bsuid;
  if (!key) {
    console.warn(`whatsapp: сообщение без отправителя (${m.type})`);
    return true;
  }
  // Повтор доставки: уже записано — не качаем файл и не расшифровываем голосовое заново.
  if (await ctx.runQuery(internal.inbox._seen, { channel: "whatsapp", externalMessageId: m.wamid })) return true;
  const content = await readContent(ctx, cfg, m);
  let kept = false;
  try {
    // Существующий диалог ищем по BSUID (он есть всегда): номер у клиента мог скрыться или смениться.
    const known = m.bsuid ? await ctx.runQuery(internal.channels.whatsapp._keyByUser, { bsuid: m.bsuid }) : null;
    const r = await ctx.runMutation(internal.inbox.ingest, {
      channel: "whatsapp",
      externalId: known ?? key,
      contactName: m.name ?? (m.username ? `@${m.username}` : undefined),
      contactPhone: m.waId,
      text: content.text,
      kind: content.kind,
      externalMessageId: m.wamid,
      at: new Date(m.ts * 1000).toISOString(),
      fileId: content.fileId,
      fileName: content.fileName,
      meta: m.username ? { username: m.username } : undefined,
      notify: content.notify,
      autoLead: content.autoLead,
    });
    kept = !r.duplicate;
    if (kept) await ctx.runMutation(internal.channels.whatsapp._link, { conversationId: r.conversationId, bsuid: m.bsuid, newWaId: m.system?.newWaId, newBsuid: m.system?.newBsuid });
  } finally {
    // Параллельный повтор того же вебхука успел раньше (или запись не удалась) — файл не нужен.
    if (!kept && content.fileId) await ctx.storage.delete(content.fileId);
  }
  return true;
}

/** false — сообщение с таким wamid ещё не записано: ответ Meta на отправку мог не успеть сохраниться. */
async function handleStatus(ctx: ActionCtx, s: WaStatus): Promise<boolean> {
  if (!(await ctx.runQuery(internal.inbox._seen, { channel: "whatsapp", externalMessageId: s.wamid }))) return false;
  const code = s.status === "failed" ? s.errors?.[0]?.code : undefined;
  await ctx.runMutation(internal.inbox._deliveryStatus, {
    channel: "whatsapp",
    externalMessageId: s.wamid,
    status: s.status === "played" ? "read" : s.status, // голосовое прослушано — значит, прочитано
    error: s.status === "failed" ? (code === undefined ? "Сообщение не доставлено" : waErrorText(code)) : undefined,
    closeWindow: code === WINDOW_CLOSED_CODE || undefined,
  });
  if (code !== undefined && isSystemicWaError(code)) await ctx.runMutation(internal.health._mark, { key: "whatsapp", ok: false, note: waErrorText(code) });
  return true;
}

async function handleEvent(ctx: ActionCtx, cfg: GraphConfig | null, ev: WaEvent): Promise<boolean> {
  if (ev.kind === "message") return handleMessage(ctx, cfg, ev);
  if (ev.kind === "status") return handleStatus(ctx, ev);
  if (ev.kind === "identity") {
    await ctx.runMutation(internal.channels.whatsapp._renameUser, { previous: ev.previous, current: ev.current });
    return true;
  }
  await ctx.runMutation(internal.health._mark, { key: "whatsapp", ok: false, note: `Ошибка платформы WhatsApp: ${ev.errors.map((e) => waErrorText(e.code)).join("; ")}` });
  return true;
}

/** Пауза перед повторной обработкой: после первой неудачи, после второй. */
const RETRY_DELAYS_MS = [15_000, 120_000];

/**
 * События вебхука (http.ts уже проверил подпись и ответил Meta). Сбой одного события не мешает остальным;
 * неудавшиеся повторяем дважды. Статус, который пришёл раньше ответа Meta на отправку, проверяем ещё раз один раз.
 */
export const handleWebhook = internalAction({
  args: { events: v.array(vWaEvent), attempt: v.optional(v.number()) },
  handler: async (ctx, { events, attempt = 0 }): Promise<void> => {
    const cfg = graphConfig();
    const again: WaEvent[] = [];
    let lost = 0;
    for (const ev of events) {
      try {
        if (!(await handleEvent(ctx, cfg, ev)) && attempt === 0) again.push(ev);
      } catch (e) {
        console.error(`whatsapp: событие «${ev.kind}» не обработано (попытка ${attempt + 1}): ${errName(e)}`);
        if (attempt < RETRY_DELAYS_MS.length) again.push(ev);
        else lost++;
      }
    }
    if (again.length) await ctx.scheduler.runAfter(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!, internal.channels.whatsapp.handleWebhook, { events: again, attempt: attempt + 1 });
    if (lost) await ctx.runMutation(internal.health._mark, { key: "whatsapp", ok: false, note: `Вебхук: не обработано событий — ${lost}` });
  },
});

// ── Кто собеседник: номер и BSUID ────────────────────────────────────────────

async function byKey(ctx: QueryCtx, externalId: string): Promise<Doc<"conversations"> | null> {
  return ctx.db
    .query("conversations")
    .withIndex("by_channel_external", (q) => q.eq("channel", "whatsapp").eq("externalId", externalId))
    .first();
}

async function byUser(ctx: QueryCtx, bsuid: string): Promise<Doc<"conversations"> | null> {
  const c = await ctx.db
    .query("conversations")
    .withIndex("by_wa_user", (q) => q.eq("waUserId", bsuid))
    .first();
  return c?.channel === "whatsapp" ? c : null;
}

/** Ключ диалога по BSUID: номер клиента мог скрыться (username, 30 дней без переписки) — диалог тот же. */
export const _keyByUser = internalQuery({
  args: { bsuid: v.string() },
  handler: async (ctx, { bsuid }): Promise<string | null> => (await byUser(ctx, bsuid))?.externalId ?? null,
});

/** После записи сообщения: запомнить BSUID и применить смену номера (system: user_changed_number / user_changed_user_id). */
export const _link = internalMutation({
  args: { conversationId: v.id("conversations"), bsuid: v.optional(v.string()), newWaId: v.optional(v.string()), newBsuid: v.optional(v.string()) },
  handler: async (ctx, a): Promise<void> => {
    const c = await ctx.db.get(a.conversationId);
    if (!c || c.channel !== "whatsapp") return;
    const patch: Partial<Doc<"conversations">> = {};
    const bsuid = a.newBsuid ?? a.bsuid;
    if (bsuid && c.waUserId !== bsuid) patch.waUserId = bsuid;
    const movedTo = a.newWaId && a.newWaId !== c.externalId ? a.newWaId : undefined;
    if (movedTo) {
      // Ответы — на новый номер, история остаётся в этом диалоге. Телефон в карточке клиента не меняем молча — решает оператор.
      if (!(await byKey(ctx, movedTo))) patch.externalId = movedTo;
      patch.contactPhone = contactPhone(movedTo);
    }
    if (!Object.keys(patch).length) return;
    await ctx.db.patch(c._id, patch);
    if (movedTo) await audit(ctx, "WhatsApp", "conversation.whatsappNumber", `Клиент ${c.contactName ?? "из WhatsApp"} сменил номер WhatsApp — ответы уходят на новый номер`, { entityId: c._id });
  },
});

/** Вебхук user_id_update: BSUID сменился (обычно после смены номера). */
export const _renameUser = internalMutation({
  args: { previous: v.string(), current: v.string() },
  handler: async (ctx, { previous, current }): Promise<void> => {
    const c = await byUser(ctx, previous);
    if (!c) return;
    const patch: Partial<Doc<"conversations">> = { waUserId: current };
    // Диалог заведён по BSUID (номер скрыт) — меняется и адрес ответа.
    if (c.externalId === previous && !(await byKey(ctx, current))) patch.externalId = current;
    await ctx.db.patch(c._id, patch);
  },
});

/** Отметку о вебхуке пишем не чаще раза в минуту: вебхуки идут параллельно и не должны спорить за одну строку. */
const WEBHOOK_MARK_EVERY_MS = 60_000;

/** Вебхук с верной подписью дошёл: время для карточки владельца и мониторинга, номер компании из metadata. */
export const _webhookSeen = internalMutation({
  args: { businessPhone: v.optional(v.string()) },
  handler: async (ctx, { businessPhone }): Promise<void> => {
    const row = await ctx.db
      .query("integrations")
      .withIndex("by_provider", (q) => q.eq("provider", "whatsapp"))
      .first();
    const accountName = businessPhone ?? row?.accountName;
    if (row?.lastSyncAt && Date.now() - Date.parse(row.lastSyncAt) < WEBHOOK_MARK_EVERY_MS && row.accountName === accountName) return;
    const at = nowIso();
    if (row) {
      await ctx.db.patch(row._id, { status: "connected", accountName, lastSyncAt: at });
    } else {
      await ctx.db.insert("integrations", { provider: "whatsapp", status: "connected", accountName, connectedAt: at, lastSyncAt: at });
      await audit(ctx, "WhatsApp", "integration.connected", "WhatsApp подключён: Meta прислала первый вебхук");
    }
    await markOk(ctx, "whatsapp", "Вебхук получен");
  },
});

// ── Карточка владельца ───────────────────────────────────────────────────────

/** Что настроено и доходят ли вебхуки. Значения секретов не отдаём — только имена недостающих переменных. */
export const settings = query({
  args: {},
  handler: async (ctx): Promise<WhatsAppSettings> => {
    await requireRole(ctx, OWNER);
    const [row, health] = await Promise.all([
      ctx.db
        .query("integrations")
        .withIndex("by_provider", (q) => q.eq("provider", "whatsapp"))
        .first(),
      ctx.db
        .query("systemStatus")
        .withIndex("by_key", (q) => q.eq("key", "whatsapp"))
        .unique(),
    ]);
    const site = env("CONVEX_SITE_URL")?.replace(/\/+$/, "");
    const verify = env("WHATSAPP_VERIFY_TOKEN");
    return {
      configured: configured(),
      missing: missingEnv(),
      webhookUrl: site ? `${site}${WEBHOOK_PATH}` : null,
      // Конец verify token — сверить с введённым в Meta; короткий целиком не подсказываем.
      verifyToken: !verify ? { state: "missing" } : verify.length < 16 ? { state: "short" } : { state: "ok", end: verify.slice(-4) },
      graphVersion: graphVersion(),
      businessPhone: row?.accountName,
      lastWebhookAt: row?.lastSyncAt,
      health: health ? { okAt: health.okAt, okNote: health.okNote, errorAt: health.errorAt, error: health.error } : undefined,
    };
  },
});

// ── Вебхук (маршруты — в http.ts) ────────────────────────────────────────────

/** Meta шлёт до 3 МБ; больше 5 МБ — не от неё, дальше не читаем. */
const MAX_BODY = 5 * 1024 * 1024;
/** Статусов на одну фоновую обработку. */
const CHUNK = 200;
/** Задач с сообщениями на один вебхук: в пачке Meta бывает до 1000 событий, а у Convex — лимит запусков из одной функции. */
const MAX_MESSAGE_TASKS = 100;

/** Ответ текстом: отражённый challenge не исполнится в браузере как HTML. */
const plain = (status: number, body: string): Response =>
  new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });

/** GET: Meta проверяет адрес при сохранении вебхука — hub.challenge как есть, только при верном verify token. */
export const whatsappVerify = httpAction(async (_ctx, request) => {
  const expected = env("WHATSAPP_VERIFY_TOKEN");
  if (!expected) return plain(503, "not configured");
  const q = new URL(request.url).searchParams;
  const challenge = q.get("hub.challenge") ?? "";
  const ok = q.get("hub.mode") === "subscribe" && challenge.length > 0 && challenge.length <= 512 && safeEqual(q.get("hub.verify_token") ?? "", expected);
  return ok ? plain(200, challenge) : plain(403, "forbidden");
});

/**
 * POST: события. Подпись — по сырым байтам до разбора JSON. Обработка (файлы, расшифровка, запись) — фоном,
 * Meta отвечаем сразу: иначе она повторяет доставку до 7 дней.
 */
export const whatsappWebhook = httpAction(async (ctx, request) => {
  const secrets = [env("WHATSAPP_APP_SECRET"), env("WHATSAPP_APP_SECRET_PREVIOUS")].filter((s): s is string => !!s);
  const phoneNumberId = env("WHATSAPP_PHONE_NUMBER_ID");
  if (!secrets.length || !phoneNumberId) return plain(503, "not configured");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return plain(413, "too large");
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BODY) return plain(413, "too large");
  if (!(await verifySignature(raw, request.headers.get("x-hub-signature-256"), secrets))) {
    console.warn(`whatsapp: вебхук с неверной подписью (${raw.byteLength} байт)`);
    return plain(403, "forbidden");
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // Подпись верна, а JSON битый: повторы Meta этого не исправят — подтверждаем и поднимаем тревогу.
    await ctx.runMutation(internal.health._mark, { key: "whatsapp", ok: false, note: "Вебхук WhatsApp: тело не JSON" });
    return plain(200, "ok");
  }
  const { events, skipped, businessPhone } = parseWebhook(body, phoneNumberId);
  if (skipped) console.warn(`whatsapp: пропущено элементов вебхука — ${skipped}`);
  try {
    // Сообщения — по одному (в большой пачке — понемногу): долгая расшифровка голосового не задерживает остальные. Статусы — пачками.
    const messages = events.filter((e) => e.kind === "message");
    const perTask = Math.max(1, Math.ceil(messages.length / MAX_MESSAGE_TASKS));
    for (let i = 0; i < messages.length; i += perTask) await ctx.scheduler.runAfter(0, internal.channels.whatsapp.handleWebhook, { events: messages.slice(i, i + perTask) });
    const rest = events.filter((e) => e.kind !== "message");
    for (let i = 0; i < rest.length; i += CHUNK) await ctx.scheduler.runAfter(0, internal.channels.whatsapp.handleWebhook, { events: rest.slice(i, i + CHUNK) });
    await ctx.runMutation(internal.channels.whatsapp._webhookSeen, { businessPhone });
  } catch (e) {
    // Не подтверждаем — Meta повторит; повтор безопасен: дубли отсекаются по wamid.
    console.error(`whatsapp: вебхук не принят в обработку: ${errName(e)}`);
    return plain(500, "retry");
  }
  return plain(200, "ok");
});
