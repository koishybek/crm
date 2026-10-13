// WhatsApp Cloud API (Meta): разбор вебхука, проверка подписи, коды ошибок Meta — чистые функции без сети и базы.
// Одинаково работают в рантайме Convex и в тестах. Сеть, файлы и функции Convex — в channels/whatsapp.ts.
import { v, type Infer } from "convex/values";
import { REPLY_BLOCK } from "./chat";
import { safeEqual } from "./crypto";

// ── События вебхука после разбора (валидаторы — единственный источник типов) ──

const vWaError = v.object({ code: v.number() });

const vWaMessage = v.object({
  kind: v.literal("message"),
  /** wamid — ключ от повторной доставки: Meta повторяет вебхук до 7 дней. */
  wamid: v.string(),
  /** Время из payload (Unix, секунды), а не время получения: повтор может прийти через часы. */
  ts: v.number(),
  type: v.string(),
  /** Номер клиента цифрами («77011234567»). У клиентов с username может не быть. */
  waId: v.optional(v.string()),
  /** BSUID («KZ.…») — есть во всех вебхуках с апреля 2026. */
  bsuid: v.optional(v.string()),
  name: v.optional(v.string()),
  username: v.optional(v.string()),
  /** Текст, подпись к файлу, заголовок нажатой кнопки, эмодзи реакции, контакты строками. */
  text: v.optional(v.string()),
  media: v.optional(v.object({ id: v.string(), mimeType: v.optional(v.string()), fileName: v.optional(v.string()), voice: v.optional(v.boolean()) })),
  location: v.optional(v.object({ latitude: v.number(), longitude: v.number(), name: v.optional(v.string()), address: v.optional(v.string()) })),
  /** Клиент сменил номер или учётную запись (type: "system"). */
  system: v.optional(v.object({ type: v.string(), newWaId: v.optional(v.string()), newBsuid: v.optional(v.string()) })),
  /** Сообщение из группы (Groups API) — не наш сценарий. */
  group: v.optional(v.boolean()),
  errors: v.optional(v.array(vWaError)),
});

const vWaStatus = v.object({
  kind: v.literal("status"),
  wamid: v.string(),
  status: v.union(v.literal("sent"), v.literal("delivered"), v.literal("read"), v.literal("played"), v.literal("failed")),
  errors: v.optional(v.array(vWaError)),
});

/** user_id_update: BSUID сменился (обычно после смены номера). */
const vWaIdentity = v.object({ kind: v.literal("identity"), previous: v.string(), current: v.string() });

/** Ошибки самого аккаунта или платформы (value.errors), не привязанные к сообщению. */
const vWaPlatformError = v.object({ kind: v.literal("platform_error"), errors: v.array(vWaError) });

export const vWaEvent = v.union(vWaMessage, vWaStatus, vWaIdentity, vWaPlatformError);

export type WaMessage = Infer<typeof vWaMessage>;
export type WaStatus = Infer<typeof vWaStatus>;
export type WaEvent = Infer<typeof vWaEvent>;
type WaError = Infer<typeof vWaError>;

export interface WaParse {
  events: WaEvent[];
  /** Пропущено: чужой номер (кнопка «Test» в Meta), неизвестное поле, битые записи. Meta всё равно отвечаем 200. */
  skipped: number;
  /** Номер компании в WhatsApp (metadata.display_phone_number) — для карточки владельца. */
  businessPhone?: string;
}

// ── Сужение недоверенного JSON ──

type Rec = Record<string, unknown>;
export const isRecord = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
export const asString = (x: unknown): string | undefined => (typeof x === "string" && x.trim() ? x.trim() : undefined);
export function asNumber(x: unknown): number | undefined {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() ? Number(x) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const clip = (s: string | undefined, max: number): string | undefined => (s === undefined ? undefined : s.slice(0, max));

/** Номер WhatsApp — только цифры. */
const waIdOf = (x: unknown): string | undefined => {
  const s = asString(x);
  return s && /^\d{6,15}$/.test(s) ? s : undefined;
};
/** BSUID: «KZ.» + буквы и цифры. Формат держим мягким — Meta может расширить алфавит, а без BSUID клиент без номера потеряется. */
const bsuidOf = (x: unknown): string | undefined => {
  const s = asString(x);
  return s && /^[A-Za-z0-9._:-]{2,200}$/.test(s) && !/^\d+$/.test(s) ? s : undefined;
};

const MAX_TEXT = 4096;
const MEDIA_TYPES: ReadonlySet<string> = new Set(["image", "video", "audio", "document", "sticker"]);

function parseErrors(x: unknown): WaError[] | undefined {
  const out = list(x)
    .filter(isRecord)
    .map((e) => asNumber(e.code))
    .filter((code): code is number => code !== undefined)
    .map((code) => ({ code }));
  return out.length ? out : undefined;
}

/** Содержимое сообщения по его типу: текст, файл, геопозиция, нажатая кнопка, реакция, контакты, смена номера. */
function parseBody(type: string, body: unknown): Pick<WaMessage, "text" | "media" | "location" | "system"> {
  if (!isRecord(body)) {
    return type === "contacts" ? { text: clip(contactsText(body), MAX_TEXT) } : {};
  }
  if (type === "text") return { text: clip(asString(body.body), MAX_TEXT) };
  if (MEDIA_TYPES.has(type)) {
    const id = asString(body.id);
    return {
      text: clip(asString(body.caption), MAX_TEXT),
      media: id ? { id, mimeType: asString(body.mime_type), fileName: clip(asString(body.filename), 200), voice: body.voice === true ? true : undefined } : undefined,
    };
  }
  if (type === "location") {
    const latitude = asNumber(body.latitude);
    const longitude = asNumber(body.longitude);
    if (latitude === undefined || longitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return {};
    return { location: { latitude, longitude, name: clip(asString(body.name), 200), address: clip(asString(body.address), 300) } };
  }
  if (type === "interactive") {
    // Нажатая кнопка (button_reply) или пункт списка (list_reply) — берём заголовок.
    const reply = body.type === "button_reply" ? body.button_reply : body.type === "list_reply" ? body.list_reply : undefined;
    return { text: isRecord(reply) ? clip(asString(reply.title), MAX_TEXT) : undefined };
  }
  if (type === "button") return { text: clip(asString(body.text) ?? asString(body.payload), MAX_TEXT) };
  if (type === "reaction") return { text: clip(asString(body.emoji), 16) }; // нет emoji — реакцию сняли
  if (type === "system") return { system: { type: asString(body.type) ?? "unknown", newWaId: waIdOf(body.wa_id), newBsuid: bsuidOf(body.user_id) } };
  return {};
}

/** Карточки контактов: «Имя: +7 701 …», по строке на контакт. */
function contactsText(body: unknown): string | undefined {
  const lines = list(body)
    .filter(isRecord)
    .map((c) => {
      const name = isRecord(c.name) ? asString(c.name.formatted_name) : undefined;
      const phones = list(c.phones)
        .filter(isRecord)
        .map((p) => asString(p.phone) ?? asString(p.wa_id))
        .filter((p): p is string => !!p);
      return [name, phones.join(", ")].filter(Boolean).join(": ");
    })
    .filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

function parseMessage(m: Rec, contacts: Rec[]): WaMessage | undefined {
  const wamid = asString(m.id);
  const ts = asNumber(m.timestamp);
  const type = asString(m.type);
  if (!wamid || wamid.length > 256 || ts === undefined || !type) return undefined;
  const from = asString(m.from);
  const fromUser = asString(m.from_user_id);
  // contacts обычно из одного элемента — сопоставляем с отправителем по BSUID или номеру.
  const contact =
    contacts.find((c) => (fromUser !== undefined && asString(c.user_id) === fromUser) || (from !== undefined && asString(c.wa_id) === from)) ?? (contacts.length === 1 ? contacts[0] : undefined);
  const profile = contact && isRecord(contact.profile) ? contact.profile : undefined;
  return {
    kind: "message",
    wamid,
    ts,
    type: type.slice(0, 32),
    // Идентичность — wa_id из contacts, from — запасной вариант (в документации они могут различаться).
    waId: waIdOf(contact?.wa_id) ?? waIdOf(from),
    bsuid: bsuidOf(fromUser) ?? bsuidOf(contact?.user_id),
    name: clip(asString(profile?.name), 120),
    username: clip(asString(profile?.username), 64),
    group: m.group_id !== undefined ? true : undefined,
    errors: parseErrors(m.errors),
    ...parseBody(type, m[type]),
  };
}

const STATUSES: ReadonlySet<string> = new Set(["sent", "delivered", "read", "played", "failed"]);
const isStatus = (s: string | undefined): s is WaStatus["status"] => !!s && STATUSES.has(s);

function parseStatus(s: Rec): WaStatus | undefined {
  const wamid = asString(s.id);
  const status = asString(s.status);
  if (!wamid || wamid.length > 256 || !isStatus(status)) return undefined;
  return { kind: "status", wamid, status, errors: parseErrors(s.errors) };
}

/**
 * Payload Meta → плоский список событий. Никогда не бросает: всё непонятное — в skipped.
 * Берём только события нашего номера (metadata.phone_number_id).
 */
export function parseWebhook(body: unknown, phoneNumberId: string): WaParse {
  const out: WaParse = { events: [], skipped: 0 };
  if (!isRecord(body) || body.object !== "whatsapp_business_account") return { ...out, skipped: 1 };
  for (const entry of list(body.entry)) {
    const changes = isRecord(entry) ? list(entry.changes) : [];
    if (!changes.length) out.skipped++;
    for (const change of changes) {
      const value = isRecord(change) && isRecord(change.value) ? change.value : undefined;
      const meta = value && isRecord(value.metadata) ? value.metadata : undefined;
      if (!value || !isRecord(change) || asString(meta?.phone_number_id) !== phoneNumberId) {
        out.skipped++;
        continue;
      }
      out.businessPhone ??= waIdOf(meta?.display_phone_number);
      if (change.field === "messages") {
        const contacts = list(value.contacts).filter(isRecord);
        for (const m of list(value.messages)) {
          const ev = isRecord(m) ? parseMessage(m, contacts) : undefined;
          if (ev) out.events.push(ev);
          else out.skipped++;
        }
        for (const s of list(value.statuses)) {
          const ev = isRecord(s) ? parseStatus(s) : undefined;
          if (ev) out.events.push(ev);
          else out.skipped++;
        }
        const errors = parseErrors(value.errors);
        if (errors) out.events.push({ kind: "platform_error", errors });
      } else if (change.field === "user_id_update") {
        for (const u of list(value.user_id_update)) {
          const ids = isRecord(u) && isRecord(u.user_id) ? u.user_id : undefined;
          const previous = bsuidOf(ids?.previous);
          const current = bsuidOf(ids?.current);
          if (previous && current) out.events.push({ kind: "identity", previous, current });
          else out.skipped++;
        }
      } else {
        out.skipped++;
      }
    }
  }
  return out;
}

// ── Подпись X-Hub-Signature-256 ──

const encoder = new TextEncoder();

async function hmacHex(secret: string, data: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Запрос от Meta: «sha256=<hex>» — HMAC-SHA256 СЫРЫХ байт тела ключом App Secret. Пересобранный JSON даёт другую подпись,
 * поэтому проверяем до разбора. secrets — текущий App Secret и, на время смены, прежний.
 */
export async function verifySignature(raw: ArrayBuffer, header: string | null, secrets: readonly string[]): Promise<boolean> {
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(header?.trim() ?? "");
  if (!m) return false;
  const given = m[1]!.toLowerCase();
  let ok = false;
  // Без раннего выхода: время не зависит от того, какой секрет подошёл.
  for (const secret of secrets) if (safeEqual(await hmacHex(secret, raw), given)) ok = true;
  return ok;
}

// ── Ошибки Meta → понятный оператору текст ──

const RATE_LIMIT = "WhatsApp просит не писать так часто — повторите через минуту";
const BAD_TOKEN = "Токен WhatsApp недействителен или истёк — владельцу нужно выпустить новый в Meta Business";
const NO_PERMISSION = "У токена WhatsApp нет прав на номер — проверьте доступы System User в Meta Business";
const RESTRICTED = "Аккаунт WhatsApp ограничен Meta — проверьте WhatsApp Manager";
const NOT_REGISTERED = "Номер компании не подключён к WhatsApp Cloud API — проверьте настройку номера";
const META_DOWN = "Временный сбой WhatsApp — повторите через пару минут";

const ERROR_TEXT: Record<number, string> = {
  131047: REPLY_BLOCK.windowClosed,
  131026: "Сообщение не доставлено: у номера нет WhatsApp, старая версия приложения или клиент не принял условия WhatsApp",
  131050: "Клиент отказался от сообщений компании в WhatsApp",
  131049: "WhatsApp придержал сообщение этому клиенту — позвоните ему",
  130403: "Этот клиент заблокирован в WhatsApp компании",
  131021: "Нельзя написать на номер самой компании",
  130497: "WhatsApp не доставляет сообщения в страну клиента",
  131062: "Этому клиенту можно написать только по номеру телефона",
  131051: "WhatsApp не поддерживает такой тип сообщения",
  131052: "WhatsApp не смог получить файл клиента — попросите прислать его ещё раз",
  131053: "WhatsApp не принял файл",
  131060: "Сообщение клиента недоступно",
  130429: RATE_LIMIT,
  131056: RATE_LIMIT,
  80007: RATE_LIMIT,
  4: RATE_LIMIT,
  0: BAD_TOKEN,
  190: BAD_TOKEN,
  3: NO_PERMISSION,
  10: NO_PERMISSION,
  368: RESTRICTED,
  131031: RESTRICTED,
  131042: "Проблема с оплатой WhatsApp — проверьте способ оплаты в WhatsApp Manager",
  131045: NOT_REGISTERED,
  133010: NOT_REGISTERED,
  131048: "WhatsApp ограничил отправку из-за жалоб на спам — проверьте качество номера в WhatsApp Manager",
  1: META_DOWN,
  2: META_DOWN,
  131000: META_DOWN,
  131016: META_DOWN,
  131057: META_DOWN,
  133004: META_DOWN,
};

/** Код ошибки Meta → текст для оператора. Логика — только по коду: тексты Meta меняются, заголовки объявлены к удалению. */
export function waErrorText(code: number): string {
  if (ERROR_TEXT[code]) return ERROR_TEXT[code];
  if (code >= 200 && code <= 299) return NO_PERMISSION;
  return `WhatsApp не принял сообщение (код ${code})`;
}

/** Сломан сам канал (токен, права, оплата, аккаунт, сбой Meta), а не переписка с одним клиентом — тревога в мониторинге. */
const SYSTEMIC: ReadonlySet<number> = new Set([0, 1, 2, 3, 10, 190, 368, 131000, 131016, 131031, 131042, 131045, 131048, 131057, 133004, 133010]);
export const isSystemicWaError = (code: number): boolean => SYSTEMIC.has(code) || (code >= 200 && code <= 299);

/** Код Meta «прошло 24 часа»: окно ответа закрыто — дальше только шаблоном. */
export const WINDOW_CLOSED_CODE = 131047;

// ── Тексты и файлы для «Сообщений» ──

export const UNSUPPORTED_TEXT = "Клиент отправил сообщение, которое WhatsApp не передаёт (опрос, правка, исчезающее сообщение и т. п.)";

/** «📍 Название, адрес» + координаты + ссылка на карту (её откроет любой телефон). */
export function locationText(l: NonNullable<WaMessage["location"]>): string {
  const coords = `${l.latitude.toFixed(6)}, ${l.longitude.toFixed(6)}`;
  const place = [l.name, l.address].filter(Boolean).join(", ");
  const link = `https://www.google.com/maps/search/?api=1&query=${l.latitude.toFixed(6)},${l.longitude.toFixed(6)}`;
  return place ? `📍 ${place}\n${coords}\n${link}` : `📍 ${coords}\n${link}`;
}

/** Файлы скачиваем только с хостов Meta: токен не должен уйти на чужой адрес. */
export function isMetaMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const h = u.hostname;
    return u.protocol === "https:" && (h === "lookaside.fbsbx.com" || h.endsWith(".fbsbx.com") || h.endsWith(".fbcdn.net") || h.endsWith(".whatsapp.net"));
  } catch {
    return false;
  }
}

/** Тип файла в хранилище — только из белого списка; остальное (html, svg…) — как двоичный, чтобы браузер его не исполнял. */
const SAFE_MIME: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/amr",
  "video/mp4",
  "video/3gpp",
  "application/pdf",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
export function storageMime(mime: string | undefined): string {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  return SAFE_MIME.has(base) ? base : "application/octet-stream";
}

/** Имя файла для показа: без путей и управляющих символов. */
export function safeFileName(name: string | undefined, fallback: string): string {
  const cleaned = (name ?? "").replace(/[\\/]/g, "_").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (cleaned || fallback).slice(0, 120);
}
