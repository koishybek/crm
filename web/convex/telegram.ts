// Telegram-бот @…: уведомления команде, работа мастеров с заказами из чата, заявки от клиентов.
// Нет TELEGRAM_BOT_TOKEN — всё тихо выключено.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./lib/functions";
import { currentUser } from "./lib/access";
import { actionFor, bindTenant, DEFAULT_TENANT, tenantOfDoc, unscopedDb } from "./lib/tenantDb";
import { audit } from "./lib/audit";
import { PLACEHOLDER } from "./lib/chat";
import { findKzPhone } from "./lib/phone";
import { cardHtml, esc, workerButtons, type CardData, type TgButton } from "./lib/tg";
import { canExtract, canTranscribe, extract, toSummary, transcribe, type CatalogHint } from "./ai";
import { env } from "./env";
import { APP_NAME } from "../src/data/catalog";
import { phone as fmtPhone, shortName } from "../src/lib/format";
import type { MessageKind } from "../src/data/types";

/** Ссылка привязки t.me/<бот>?start=<код> живёт 30 минут и срабатывает один раз (аудит M-9). */
const LINK_TTL_MS = 30 * 60_000;
/** Голосовые длиннее 2 минут не скачиваем и AI не отдаём: расшифровка платная, а это путь для флуда (аудит H-4). */
const VOICE_MAX_SEC = 120;

type Markup = { inline_keyboard: { text: string; callback_data?: string; url?: string }[][] } | { keyboard: unknown[][]; resize_keyboard?: boolean; one_time_keyboard?: boolean } | { remove_keyboard: true };

/** Вызов Bot API. null — бот не настроен или Telegram не ответил. */
export async function tg(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string } | null> {
  const token = env("TELEGRAM_BOT_TOKEN");
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = (await res.json()) as { ok: boolean; result?: unknown; description?: string };
    if (!json.ok) console.warn(`telegram ${method}: ${json.description}`);
    return json;
  } catch (e) {
    console.warn(`telegram ${method} failed`, e instanceof Error ? e.message : e);
    return null;
  }
}

export const inline = (rows: TgButton[][]): Markup | undefined => {
  const kb = rows.filter((r) => r.length).map((r) => r.map((b) => (b.data ? { text: b.text, callback_data: b.data } : { text: b.text, url: b.url! })));
  return kb.length ? { inline_keyboard: kb } : undefined;
};

const sendHtml = (chatId: string, html: string, markup?: Markup) => tg("sendMessage", { chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });

const appUrl = () => env("APP_URL")?.replace(/\/$/, "");

const buttonRow = v.array(v.object({ text: v.string(), data: v.optional(v.string()), url: v.optional(v.string()) }));

/** Отправка из планировщика (notify, сводки). html — уже экранированный, иначе text экранируем. */
export const send = internalAction({
  args: { chatId: v.string(), text: v.string(), html: v.optional(v.string()), link: v.optional(v.string()), buttons: v.optional(v.array(buttonRow)) },
  handler: async (_ctx, { chatId, text, html, link, buttons }) => {
    const rows: TgButton[][] = [...(buttons ?? [])];
    const app = appUrl();
    const hasUrl = rows.some((r) => r.some((b) => b.url));
    if (app && link && !hasUrl) rows.push([{ text: "Открыть", url: `${app}${link}` }]);
    await sendHtml(chatId, html ?? esc(text), inline(rows));
  },
});

/** Статус подключения для профиля. */
export const status = query({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) return null;
    return { enabled: !!env("TELEGRAM_BOT_TOKEN") && !!env("TELEGRAM_BOT_USERNAME"), linked: !!me.telegramChatId, bot: env("TELEGRAM_BOT_USERNAME") ?? null };
  },
});

/**
 * Одноразовая ссылка t.me/<бот>?start=<код> для привязки аккаунта: 30 минут. Перепривязка — только явно: сначала
 * «Отключить Telegram», потом новая ссылка — иначе утёкшая ссылка молча увела бы уведомления в чужой чат (аудит M-9).
 */
export const linkUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    const bot = env("TELEGRAM_BOT_USERNAME");
    if (!bot || !env("TELEGRAM_BOT_TOKEN")) throw new ConvexError("Бот ещё не подключён");
    if (me.telegramChatId) throw new ConvexError("Telegram уже подключён. Чтобы подключить другой чат, сначала нажмите «Отключить Telegram»");
    const code = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.db.patch(me._id, { telegramLinkCode: code, telegramLinkExpiresAt: Date.now() + LINK_TTL_MS });
    return `https://t.me/${bot.replace(/^@/, "")}?start=${code}`;
  },
});

const whoLinks = (u: { name?: string; email?: string }) => shortName(u.name || u.email || "сотрудник");

export const unlink = mutation({
  args: {},
  handler: async (ctx) => {
    const me = await currentUser(ctx);
    if (!me) throw new ConvexError("Нужно войти");
    await ctx.db.patch(me._id, { telegramChatId: undefined, telegramLinkCode: undefined, telegramLinkExpiresAt: undefined });
    if (me.telegramChatId) await audit(ctx, me, "user.telegram", `Telegram отключён: ${whoLinks(me)}`, { entityId: me._id, meta: { linked: false } });
  },
});

export type LinkResult = { ok: true; name: string; role: string } | { ok: false; reason: "expired" | "elsewhere" };

export const linkChat = internalMutation({
  args: { code: v.string(), chatId: v.string() },
  handler: async (ctx, { code, chatId }): Promise<LinkResult> => {
    if (!/^[0-9a-f]{24}$/.test(code)) return { ok: false, reason: "expired" };
    // Бот общий для всех компаний платформы: код ищем среди всех, дальше работаем в компании его владельца.
    const all = unscopedDb(ctx);
    const u = await all.query("users").withIndex("by_telegram_code", (q) => q.eq("telegramLinkCode", code)).first();
    if (!u) return { ok: false, reason: "expired" };
    bindTenant(ctx, tenantOfDoc(u));
    // Код гасим при любой попытке: ссылка одноразовая.
    await ctx.db.patch(u._id, { telegramLinkCode: undefined, telegramLinkExpiresAt: undefined });
    // Просроченная ссылка, отключённый доступ или ещё не сменённый временный пароль — не привязываем.
    if (!u.telegramLinkExpiresAt || u.telegramLinkExpiresAt <= Date.now() || u.active === false || !u.role || u.mustChangePassword) return { ok: false, reason: "expired" };
    if (u.telegramChatId && u.telegramChatId !== chatId) return { ok: false, reason: "elsewhere" };
    // Один чат — один аккаунт (в любой компании).
    for (const other of await all.query("users").withIndex("by_telegram_chat", (q) => q.eq("telegramChatId", chatId)).collect()) {
      if (other._id !== u._id) await all.patch(other._id, { telegramChatId: undefined });
    }
    await ctx.db.patch(u._id, { telegramChatId: chatId });
    await audit(ctx, u, "user.telegram", `Telegram подключён: ${whoLinks(u)}`, { entityId: u._id, meta: { linked: true } });
    return { ok: true, name: u.name ?? "", role: u.role };
  },
});

/**
 * Компания чата: сотрудник или мастер с привязанным Telegram — его компания (бот общий для платформы);
 * иначе null — пишет клиент, он обращается в компанию бота.
 */
export const _chatTenant = internalQuery({
  args: { chatId: v.string() },
  handler: async (ctx, { chatId }): Promise<string | null> => {
    const users = await unscopedDb(ctx).query("users").withIndex("by_telegram_chat", (q) => q.eq("telegramChatId", chatId)).collect();
    const u = users.find((x) => x.role && x.active !== false);
    return u ? tenantOfDoc(u) : null;
  },
});

/** Обновление с этим update_id уже принимали (Telegram повторил доставку) — false. Записи чистит maintenance через 2 суток. */
export const _firstSeen = internalMutation({
  args: { updateId: v.number(), tenantId: v.string() },
  handler: async (ctx, { updateId }): Promise<boolean> => {
    if (await ctx.db.query("telegramUpdates").withIndex("by_update", (q) => q.eq("updateId", updateId)).first()) return false;
    await ctx.db.insert("telegramUpdates", { updateId });
    return true;
  },
});

// ── Входящие обновления ──────────────────────────────────────────────────────

type TgUser = { id: number; first_name?: string; last_name?: string; username?: string };
type TgFile = { file_id: string; file_size?: number };
type TgMessage = {
  message_id: number;
  date?: number;
  chat: { id: number; type?: string };
  from?: TgUser;
  text?: string;
  caption?: string;
  contact?: { phone_number: string; first_name?: string; last_name?: string; user_id?: number };
  voice?: TgFile & { duration?: number };
  audio?: TgFile & { duration?: number; file_name?: string };
  photo?: (TgFile & { width?: number; height?: number })[];
  document?: TgFile & { file_name?: string; mime_type?: string };
  video?: TgFile & { file_name?: string };
  video_note?: TgFile;
  animation?: TgFile & { file_name?: string };
  sticker?: { emoji?: string };
  location?: { latitude: number; longitude: number };
};
type TgUpdate = { message?: TgMessage; callback_query?: { id: string; data?: string; from: TgUser; message?: TgMessage } };

const HELP_EXECUTOR =
  "Я присылаю новые заказы по вашей специализации — их можно взять кнопкой «Взять заказ».\n\n/feed — свободные заказы\n/orders — мои заказы с кнопками: начать, завершить\n\nАдрес и телефон клиента появляются, как только заказ ваш.";
const HELP_STAFF =
  "Я присылаю новые заявки, события по заказам и утреннюю сводку в 9:00.\n\n/orders — сводка прямо сейчас\n\nЗапись разговора с клиентом: после звонка «Поделиться» → этот чат, в подписи — имя и номер клиента. AI разберёт её и создаст заявку.";
const HELP_CLIENT = `Здравствуйте! 👋 Это ${APP_NAME}. Опишите, что случилось и где вы находитесь — можно текстом или голосовым. Затем поделитесь номером, и оператор перезвонит.`;

const fullName = (u?: { first_name?: string; last_name?: string }) => [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim() || undefined;

async function linkedUser(ctx: ActionCtx, chatId: string): Promise<{ role: string | null; name: string }> {
  const r = await ctx.runQuery(internal.worker._forChat, { chatId, what: "orders" });
  return { role: r.role, name: r.name };
}

async function sendCards(chatId: string, cards: CardData[], header: (c: CardData) => string) {
  const app = appUrl();
  for (const c of cards) await sendHtml(chatId, cardHtml(c, header(c)), inline(workerButtons(c.status, c.id, app)));
}

// ── Сотрудник присылает запись разговора («Поделиться» → бот) ───────────────
// Телефон оператора без АТС пишет звонки сам; запись оператор отправляет боту — дальше как запись от АТС: звонок, AI,
// заявка. Номер и имя клиента — в подписи к файлу (или номер в имени файла); номера нет — бот спрашивает.

const AUDIO_EXT: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", amr: "audio/amr", awb: "audio/amr-wb", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", wav: "audio/wav", "3gp": "audio/3gpp", flac: "audio/flac" };
const extOf = (name?: string) => /\.([a-z0-9]+)$/i.exec(name ?? "")?.[1]?.toLowerCase();

/** Аудиофайл в сообщении: запись разговора, голосовое или документ-аудио. */
function recordingIn(msg: TgMessage): { fileId: string; fileName?: string; duration?: number; type?: string } | null {
  if (msg.audio) return { fileId: msg.audio.file_id, fileName: msg.audio.file_name, duration: msg.audio.duration };
  if (msg.voice) return { fileId: msg.voice.file_id, fileName: "voice.ogg", duration: msg.voice.duration };
  const d = msg.document;
  const ext = extOf(d?.file_name);
  if (d && (d.mime_type?.startsWith("audio/") || (ext && AUDIO_EXT[ext]))) return { fileId: d.file_id, fileName: d.file_name, type: d.mime_type };
  return null;
}

/** Казахстанский номер в тексте («+7 701 555 01 60», «8 (701) 555-01-60», «87015550160») → «77015550160». */
export function phoneIn(s: string): string | null {
  const m = /(?:\+\s*7|\b7|\b8)[\s\-()]*(\d{3})[\s\-()]*(\d{3})[\s\-]*(\d{2})[\s\-]*(\d{2})(?!\d)/.exec(s);
  return m ? `7${m[1]}${m[2]}${m[3]}${m[4]}` : null;
}

/** Имя из подписи: подпись без номера, если в ней есть буквы. */
function nameIn(caption: string): string | undefined {
  const m = /(?:\+\s*7|\b7|\b8)[\s\-()]*\d{3}[\s\-()]*\d{3}[\s\-]*\d{2}[\s\-]*\d{2}(?!\d)/.exec(caption);
  const rest = (m ? caption.replace(m[0], " ") : caption).replace(/[,;:|]+/g, " ").replace(/\s+/g, " ").trim();
  return /\p{L}/u.test(rest) ? rest.slice(0, 80) : undefined;
}

async function staffRecording(ctx: ActionCtx, chatId: string, msg: TgMessage, rec: NonNullable<ReturnType<typeof recordingIn>>) {
  const caption = (msg.caption ?? "").trim();
  const phone = phoneIn(caption) ?? phoneIn(rec.fileName ?? "");
  const file = await download(rec.fileId);
  if (!file) return void (await sendHtml(chatId, "Не получилось скачать запись: бот принимает файлы до 20 МБ. Отправьте файл ещё раз или загрузите его в разделе «Звонки»."));
  // Тип — по расширению: Telegram отдаёт файлы как application/octet-stream, а расшифровке нужен аудиоформат.
  const type = AUDIO_EXT[extOf(rec.fileName) ?? ""] ?? (rec.type?.startsWith("audio/") ? rec.type : "audio/mp4");
  const storageId = await ctx.storage.store(new Blob([file], { type }));
  const callId = await ctx.runMutation(internal.calls._fromBot, { chatId, storageId, externalId: `tg:${chatId}:${msg.message_id}`, phone: phone ?? undefined, name: nameIn(caption), duration: rec.duration });
  if (!callId) return;
  await ctx.runMutation(internal.calls._awaitPhone, { chatId, callId: phone ? null : callId });
  await sendHtml(
    chatId,
    phone
      ? "Принято 🎧 Разбираю запись — через 1–3 минуты в системе будут звонок, сводка и заявка."
      : "Принято 🎧 Разбираю запись. <b>Пришлите номер клиента</b> одним сообщением — без него заявку не создать.\n\nВ следующий раз впишите номер и имя в подпись к файлу — тогда спрашивать не буду.",
  );
}

async function staffPhone(ctx: ActionCtx, chatId: string, callId: Id<"calls">, phone: string) {
  const r = await ctx.runMutation(internal.calls._setPhone, { callId, phone });
  if (!r.ok) return void (await sendHtml(chatId, "Не узнал номер — пришлите его полностью, например +7 701 123 45 67."));
  await ctx.runMutation(internal.calls._awaitPhone, { chatId, callId: null });
  await sendHtml(chatId, r.leadNumber ? `Номер записан → заявка №${r.leadNumber} ✅` : "Номер записан ✅ Как только AI разберёт запись, появится заявка.");
}

// ── Клиенты: заявка через бота, вся переписка — в «Сообщениях» ─────────────

/** Bot API отдаёт файлы до 20 МБ. */
const MAX_FILE = 20 * 1024 * 1024;

/** Скачать файл клиента из Telegram. null — бот не настроен, файл больше 20 МБ или Telegram его не отдал. */
async function download(fileId: string): Promise<Blob | null> {
  const token = env("TELEGRAM_BOT_TOKEN");
  const f = await tg("getFile", { file_id: fileId });
  const info = f?.result as { file_path?: string; file_size?: number } | undefined;
  if (!token || !info?.file_path || (info.file_size ?? 0) > MAX_FILE) return null;
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
    return res.ok ? await res.blob() : null;
  } catch (e) {
    console.warn(`telegram: файл клиента не скачан: ${e instanceof Error ? e.name : "ошибка"}`);
    return null;
  }
}

/** Файл клиента → хранилище: оператор откроет фото, голосовое или документ прямо в «Сообщениях». */
async function keep(ctx: ActionCtx, blob: Blob | null): Promise<Id<"_storage"> | undefined> {
  if (!blob) return undefined;
  try {
    return await ctx.storage.store(blob);
  } catch (e) {
    console.warn(`telegram: файл клиента не сохранён: ${e instanceof Error ? e.name : "ошибка"}`);
    return undefined;
  }
}

/** Что прислал клиент: текст для «Сообщений», текст для черновика заявки и файл. */
type Incoming = {
  kind: MessageKind;
  text: string;
  /** В черновик заявки; пусто — сообщение только для «Сообщений» (стикер, неразобранное голосовое). */
  draft: string;
  fileId?: Id<"_storage">;
  fileName?: string;
  voice?: boolean;
  /** Бот отвечает этим вместо обычного сценария. */
  reply?: string;
};

async function readIncoming(ctx: ActionCtx, chatId: string, msg: TgMessage): Promise<Incoming | null> {
  const caption = (msg.text ?? msg.caption ?? "").trim();
  const voice = msg.voice ?? msg.audio;
  if (voice) {
    // Длинное голосовое и поток голосовых — без скачивания и AI: в «Сообщениях» отметка, клиенту — просьба написать текстом.
    if ((voice.duration ?? 0) > VOICE_MAX_SEC) return { kind: "audio", text: PLACEHOLDER.voice, draft: "", reply: "Голосовое длиннее 2 минут — расскажите, пожалуйста, покороче или напишите текстом 🙏" };
    if (canTranscribe() && !(await ctx.runMutation(internal.bot._voiceAllowed, { chatId }))) return { kind: "audio", text: PLACEHOLDER.voice, draft: "", reply: "Слишком много голосовых подряд — напишите, пожалуйста, текстом." };
    const blob = await download(voice.file_id);
    const fileId = await keep(ctx, blob);
    const fileName = msg.audio?.file_name ?? "voice.ogg";
    if (!canTranscribe()) return { kind: "audio", text: PLACEHOLDER.voice, draft: "", fileId, fileName, reply: "Голосовые пока не разбираю — напишите, пожалуйста, текстом 🙏" };
    let text = "";
    try {
      text = blob ? (await transcribe(blob)).text : "";
    } catch (e) {
      console.warn(`telegram: голосовое не расшифровано: ${e instanceof Error ? e.message : "ошибка"}`);
    }
    if (!text) return { kind: "audio", text: PLACEHOLDER.voiceFailed, draft: "", fileId, fileName, reply: "Не получилось разобрать голосовое — напишите, пожалуйста, текстом." };
    return { kind: "audio", text, draft: text, fileId, fileName, voice: true };
  }
  if (msg.photo?.length) {
    // Размеры идут по возрастанию — берём самый большой, который Telegram отдаст.
    const best = [...msg.photo].reverse().find((p) => (p.file_size ?? 0) <= MAX_FILE) ?? msg.photo[0]!;
    const fileId = await keep(ctx, await download(best.file_id));
    return { kind: "image", text: caption || PLACEHOLDER.image, draft: caption || "[клиент отправил фото]", fileId, fileName: "photo.jpg" };
  }
  const video = msg.video ?? msg.animation ?? msg.video_note;
  if (video) {
    const fileId = await keep(ctx, await download(video.file_id));
    const fileName = (msg.video ?? msg.animation)?.file_name ?? "video.mp4";
    return { kind: "file", text: caption || PLACEHOLDER.video, draft: caption || "[клиент отправил видео]", fileId, fileName };
  }
  if (msg.document) {
    const fileId = await keep(ctx, await download(msg.document.file_id));
    const image = !!msg.document.mime_type?.startsWith("image/");
    return { kind: image ? "image" : "file", text: caption || (image ? PLACEHOLDER.image : PLACEHOLDER.file), draft: caption || "[клиент отправил файл]", fileId, fileName: msg.document.file_name ?? "file" };
  }
  if (msg.location) {
    const coords = `${msg.location.latitude.toFixed(6)}, ${msg.location.longitude.toFixed(6)}`;
    return { kind: "location", text: coords, draft: `Геопозиция клиента: ${coords}` };
  }
  if (msg.sticker) return { kind: "text", text: `Стикер ${msg.sticker.emoji ?? ""}`.trim(), draft: "" };
  return caption ? { kind: "text", text: caption, draft: caption } : null;
}

/**
 * Время сообщения. Telegram даёт его с точностью до секунды: свежее сообщение ставим по часам сервера, иначе ответ бота
 * в ту же секунду окажется в ленте выше сообщения клиента. Своё время — только у задержанных (бот был недоступен).
 */
const tgDate = (unix?: number) => (unix && Date.now() - unix * 1000 > 60_000 ? new Date(unix * 1000).toISOString() : undefined);
const tgMeta = (u?: TgUser) => (u?.username ? { username: u.username.slice(0, 64) } : undefined);
const htmlText = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Ответ бота клиенту + копия в «Сообщения» серым системным сообщением. */
async function say(ctx: ActionCtx, chatId: string, conversationId: Id<"conversations">, html: string, markup?: Markup) {
  const res = await sendHtml(chatId, html, markup);
  const id = (res?.result as { message_id?: number } | undefined)?.message_id;
  await ctx.runMutation(internal.inbox._logBot, { conversationId, text: htmlText(html), ok: !!res?.ok, externalMessageId: id === undefined ? undefined : `${chatId}:${id}` });
}

const PHONE_BUTTON: Markup = { keyboard: [[{ text: "📱 Отправить мой номер", request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

/** Сообщение клиента: в «Сообщения», дальше обычный сценарий бота — дописать к заявке или собрать черновик и попросить номер. */
async function clientMessage(ctx: ActionCtx, chatId: string, msg: TgMessage) {
  const externalMessageId = `${chatId}:${msg.message_id}`;
  // Повтор вебхука — уже записано (и голосовое уже расшифровано).
  if (await ctx.runQuery(internal.inbox._seen, { channel: "telegram", externalMessageId })) return;
  const inc = await readIncoming(ctx, chatId, msg);
  if (!inc) return;
  const st = await ctx.runQuery(internal.bot._state, { chatId });
  const toLead = !!st.openLead && st.state === "idle";
  const phone = inc.draft && !toLead ? findKzPhone(inc.draft) : null;
  const r = await ctx.runMutation(internal.inbox.ingest, {
    channel: "telegram",
    externalId: chatId,
    contactName: fullName(msg.from),
    text: inc.text,
    kind: inc.kind,
    externalMessageId,
    at: tgDate(msg.date),
    fileId: inc.fileId,
    fileName: inc.fileName,
    meta: tgMeta(msg.from),
    // О заявке (по открытой или по номеру в тексте) команде сообщит сам бот; стикер — не повод для уведомления.
    notify: !toLead && !phone && (!!inc.draft || !!inc.reply),
    autoLead: false,
  });
  if (r.duplicate) return;
  const conv = r.conversationId;
  if (inc.reply) return void (await say(ctx, chatId, conv, inc.reply));
  if (!inc.draft) return;
  if (toLead) {
    await ctx.runMutation(internal.bot._toOpenLead, { chatId, leadId: st.openLead!.id, text: inc.draft });
    return void (await say(ctx, chatId, conv, `Передали оператору по заявке №${st.openLead!.number} ✅`));
  }
  const { full } = await ctx.runMutation(internal.bot._addDraft, { chatId, text: inc.draft, name: fullName(msg.from) });
  // Номер написали текстом («мой номер 8 701 …») — заявка сразу, без кнопки.
  if (phone) return void (await finishLead(ctx, chatId, conv, phone, msg.from));
  if (full) return void (await say(ctx, chatId, conv, "Подробности уже записали — осталось поделиться номером, кнопка ниже 👇", PHONE_BUTTON));
  await say(ctx, chatId, conv, inc.voice ? `Записал: «${esc(inc.draft.slice(0, 300))}»\n\nОстался номер телефона — нажмите кнопку ниже 👇` : "Принято! Чтобы оператор перезвонил, поделитесь номером — кнопка ниже 👇", PHONE_BUTTON);
}

/** Ответ клиенту вне сценария (команда, чужой контакт): в идущий диалог «Сообщений» — копией; новый диалог ради него не заводим. */
async function answer(ctx: ActionCtx, chatId: string, html: string, markup?: Markup) {
  const conv = await ctx.runQuery(internal.inbox._find, { channel: "telegram", externalId: chatId });
  if (conv) await say(ctx, chatId, conv, html, markup);
  else await sendHtml(chatId, html, markup);
}

/** Клиент поделился контактом кнопкой. */
async function clientContact(ctx: ActionCtx, chatId: string, msg: TgMessage) {
  const externalMessageId = `${chatId}:${msg.message_id}`;
  if (await ctx.runQuery(internal.inbox._seen, { channel: "telegram", externalMessageId })) return;
  const contact = msg.contact!;
  const r = await ctx.runMutation(internal.inbox.ingest, {
    channel: "telegram",
    externalId: chatId,
    contactName: fullName(msg.from) ?? fullName(contact),
    contactPhone: contact.phone_number,
    text: `Поделился номером: ${fmtPhone(contact.phone_number)}`,
    kind: "text",
    externalMessageId,
    at: tgDate(msg.date),
    meta: tgMeta(msg.from),
    notify: false,
    autoLead: false,
  });
  if (r.duplicate) return;
  await finishLead(ctx, chatId, r.conversationId, contact.phone_number, contact.first_name ? contact : msg.from);
}

/** Номер есть (кнопкой или текстом) — заявка с AI-разбором черновика. */
async function finishLead(ctx: ActionCtx, chatId: string, conv: Id<"conversations">, phone: string, who?: { first_name?: string; last_name?: string }) {
  const st = await ctx.runQuery(internal.bot._state, { chatId });
  let parsed: { ai?: ReturnType<typeof toSummary>["ai"]; draft?: ReturnType<typeof toSummary>["draft"] } = {};
  if (st.draft && canExtract()) {
    try {
      const hint: CatalogHint = await ctx.runQuery(internal.catalog._hint, {});
      const x = await extract(st.draft, hint, "message");
      parsed = toSummary(x, (id) => hint.services.find((s) => s.id === id)?.label ?? id);
    } catch (e) {
      // Без AI заявка всё равно создаётся с текстом клиента.
      console.warn(`telegram: черновик без AI-разбора: ${e instanceof ConvexError ? String(e.data) : "ошибка"}`);
    }
  }
  const name = parsed.draft?.clientName ?? fullName(who);
  const res = await ctx.runMutation(internal.bot._createLead, {
    chatId,
    phone,
    name,
    ai: parsed.ai,
    serviceId: parsed.draft?.serviceId,
    city: parsed.draft?.city,
    address: parsed.draft?.address,
    urgency: parsed.draft?.urgency,
    description: parsed.draft?.description,
    preferredTime: parsed.draft?.when,
    district: parsed.draft?.district,
    budget: parsed.draft?.budget,
  });
  if (!res.ok) {
    const text =
      res.reason === "limit"
        ? "Ваши заявки уже у оператора — он свяжется с вами. Подробности можно просто написать сюда."
        : res.reason === "phone"
          ? "Не получилось принять номер — пришлите, пожалуйста, ещё раз или напишите его текстом."
          : "Сейчас не получилось принять заявку — попробуйте, пожалуйста, чуть позже.";
    return void (await say(ctx, chatId, conv, text, { remove_keyboard: true }));
  }
  if (res.existing) {
    return void (await say(ctx, chatId, conv, `Заявка <b>№${res.number}</b> уже у оператора ✅ Он свяжется с вами в ближайшее время.`, { remove_keyboard: true }));
  }
  await say(
    ctx,
    chatId,
    conv,
    `Спасибо${name ? `, ${esc(name.split(" ")[0]!)}` : ""}! Заявка <b>№${res.number}</b> принята 🙌\nОператор свяжется с вами в ближайшее время. Если вспомните детали — просто напишите сюда.`,
    { remove_keyboard: true },
  );
}

/** Звезда под «Заказ выполнен» (rv:<заказ>:<1–5>): спасибо и убрать звёзды. Повторное нажатие отзыв не меняет. */
async function rateCallback(ctx: ActionCtx, cb: NonNullable<TgUpdate["callback_query"]>, chatId: string, data: string) {
  const [, orderId = "", stars = ""] = data.split(":");
  const r = await ctx.runMutation(internal.clientNotify._rateFromTelegram, { chatId, orderId, rating: Number(stars) });
  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: r.ok ? "Спасибо за оценку!" : r.error });
  if (cb.message && (r.ok || r.rated)) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
}

async function callback(ctx: ActionCtx, cb: NonNullable<TgUpdate["callback_query"]>) {
  // Кнопка действует от имени нажавшего (from.id), а не владельца чата: в группе карточку мог бы нажать кто угодно (аудит L-3).
  if (cb.message && cb.message.chat.id !== cb.from.id) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Кнопки работают только в личном чате с ботом", show_alert: true });
    return;
  }
  const chatId = String(cb.from.id);
  const data = cb.data ?? "";
  if (data.startsWith("rv:")) return void (await rateCallback(ctx, cb, chatId, data));
  let res: { ok: true; card: CardData } | { ok: false; error: string } | null = null;
  let header = "";
  if (data.startsWith("take:")) {
    res = await ctx.runMutation(internal.worker.takeFromTelegram, { chatId, orderId: data.slice(5) });
    header = "✅ Заказ ваш";
  } else if (data.startsWith("act:")) {
    const [, action, orderId] = data.split(":");
    if (action && orderId && ["accept", "decline", "start", "wait", "resume", "done"].includes(action)) {
      res = await ctx.runMutation(internal.worker.actFromTelegram, { chatId, orderId, action: action as "accept" });
      header = { accept: "✅ Заказ подтверждён", decline: "Вы отказались — заказ вернулся в ленту", start: "▶️ В работе", wait: "⏸ Ждём клиента", resume: "▶️ Снова в работе", done: "✅ Работа сдана — спасибо!" }[action]!;
    }
  }
  if (!res) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id });
    return;
  }
  if (!res.ok) {
    await tg("answerCallbackQuery", { callback_query_id: cb.id, text: res.error, show_alert: true });
    return;
  }
  await tg("answerCallbackQuery", { callback_query_id: cb.id, text: header });
  if (cb.message) {
    const isDeclined = res.card.status === "awaiting_executor";
    await tg("editMessageText", {
      chat_id: chatId,
      message_id: cb.message.message_id,
      text: cardHtml(res.card, `${header} · №${res.card.number}`),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: isDeclined ? { inline_keyboard: [] } : (inline(workerButtons(res.card.status, res.card.id, appUrl())) ?? { inline_keyboard: [] }),
    });
  }
}

/** Входящее обновление от Telegram (вызывается из http.ts после проверки секрета). */
export const handleUpdate = internalAction({
  args: { update: v.any(), botTenant: v.optional(v.string()) },
  handler: async (raw, { update, botTenant }) => {
    const u = update as TgUpdate;
    // Сотрудник или мастер — в своей компании, клиент — в компании бота (ТЗ §2.5).
    const chatTenant = async (chatId: string) => actionFor(raw, (await raw.runQuery(internal.telegram._chatTenant, { chatId })) ?? botTenant ?? DEFAULT_TENANT);
    if (u.callback_query) return void (await callback(await chatTenant(String(u.callback_query.from.id)), u.callback_query));
    const msg = u.message;
    if (!msg || msg.chat.type && msg.chat.type !== "private") return;
    const chatId = String(msg.chat.id);
    const text = (msg.text ?? "").trim();

    // Привязка аккаунта сотрудника/мастера по одноразовой ссылке из кабинета (компанию определит сам код).
    const m = /^\/start\s+([0-9a-f]{24})$/.exec(text);
    if (m) {
      const linked = await raw.runMutation(internal.telegram.linkChat, { code: m[1]!, chatId });
      if (!linked.ok) {
        return void (await sendHtml(
          chatId,
          linked.reason === "elsewhere"
            ? `Этот аккаунт уже подключён к другому Telegram. Чтобы получать уведомления здесь, в ${APP_NAME} откройте меню профиля → «Отключить Telegram», затем «Подключить Telegram».`
            : `Ссылка устарела. Откройте ${APP_NAME} → меню профиля → «Подключить Telegram» ещё раз.`,
        ));
      }
      const first = linked.name.split(" ")[0];
      await sendHtml(chatId, `Готово${first ? `, ${esc(first)}` : ""}! 🎉 Telegram подключён к ${APP_NAME}.\n\n${esc(linked.role === "executor" ? HELP_EXECUTOR : HELP_STAFF)}`);
      return;
    }

    const ctx = await chatTenant(chatId);
    const who = await linkedUser(ctx, chatId);
    if (who.role) {
      // Сотрудник или мастер.
      if (text === "/feed" || text === "/orders") {
        if (who.role !== "executor") {
          const snap = await ctx.runQuery(internal.digest._staffSnapshot, { chatId });
          const app = appUrl();
          return void (await sendHtml(chatId, snap ?? HELP_STAFF, app ? inline([[{ text: "Открыть кабинет", url: app }]]) : undefined));
        }
        const r = await ctx.runQuery(internal.worker._forChat, { chatId, what: text === "/feed" ? "feed" : "orders" });
        if (text === "/feed" && r.available === false) return void (await sendHtml(chatId, "Вы на выходном — новые заказы не приходят. Включите приём заказов в кабинете, и лента откроется."));
        if (!r.cards.length) return void (await sendHtml(chatId, text === "/feed" ? "Свободных заказов по вашей специализации сейчас нет. Пришлю, как только появятся 👌" : "Активных заказов нет. Свободные — /feed"));
        await sendHtml(chatId, text === "/feed" ? `<b>Свободные заказы: ${r.cards.length}</b>` : `<b>Ваши заказы: ${r.cards.length}</b>`);
        await sendCards(chatId, r.cards, (c) => (text === "/feed" ? `🆕 Заказ №${c.number}` : `Заказ №${c.number}`));
        return;
      }
      if (who.role !== "executor") {
        // Запись разговора с телефона оператора — в «Звонки» и на разбор AI; номер ответом — к последней записи без номера.
        const rec = recordingIn(msg);
        if (rec) return void (await staffRecording(ctx, chatId, msg, rec));
        const phone = phoneIn(text);
        const waiting = phone ? await ctx.runQuery(internal.calls._awaitingPhone, { chatId }) : null;
        if (phone && waiting) return void (await staffPhone(ctx, chatId, waiting, phone));
      }
      return void (await sendHtml(chatId, esc(who.role === "executor" ? HELP_EXECUTOR : HELP_STAFF)));
    }

    // Клиент. Флуд из одного чата не разбираем — ни AI, ни заявок, ни уведомлений; почему — скажем один раз в 10 минут.
    const allow = await ctx.runMutation(internal.bot._allow, { chatId });
    if (!allow.ok) {
      if (allow.warn) await sendHtml(chatId, "Вы пишете слишком часто — подождите минуту. Всё, что вы уже отправили, оператор увидит.");
      return;
    }
    if (msg.contact) {
      // Только свой номер: кнопка «Отправить мой номер» присылает контакт с user_id отправителя (Bot API, Contact.user_id).
      // Чужая карточка из записной книжки — отказ: иначе заявка и переписка анонима легли бы в историю чужого клиента (аудит H-4).
      if (!msg.from || msg.contact.user_id !== msg.from.id) {
        return void (await answer(ctx, chatId, "Нужен ваш собственный номер — нажмите кнопку «📱 Отправить мой номер» ниже.", PHONE_BUTTON));
      }
      return void (await clientContact(ctx, chatId, msg));
    }
    // Команда — не обращение: новый диалог не заводим, но в уже идущий ответ бота записываем.
    if (text.startsWith("/")) return void (await answer(ctx, chatId, esc(HELP_CLIENT), { remove_keyboard: true }));
    await clientMessage(ctx, chatId, msg);
  },
});

/** Владелец переподключает вебхук (после смены токена). */
export const setupWebhook = action({
  args: {},
  handler: async (ctx): Promise<string> => {
    if ((await ctx.runQuery(internal.users._viewerRole, {})) !== "owner") throw new ConvexError("Нет доступа");
    const site = env("CONVEX_SITE_URL");
    const secret = env("TELEGRAM_WEBHOOK_SECRET");
    if (!site || !secret || !env("TELEGRAM_BOT_TOKEN")) throw new ConvexError("Нужны TELEGRAM_BOT_TOKEN и TELEGRAM_WEBHOOK_SECRET");
    const res = await tg("setWebhook", { url: `${site}/telegram`, secret_token: secret, allowed_updates: ["message", "callback_query"] });
    if (!res?.ok) throw new ConvexError(`Telegram: ${res?.description ?? "нет ответа"}`);
    return "ok";
  },
});
