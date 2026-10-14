// Web push без зависимостей (ТЗ п.23.6): шифрование сообщения по RFC 8291 (aes128gcm, ECDH P-256, HKDF-SHA-256)
// и подпись сервера VAPID по RFC 8292 (JWT ES256) — на crypto.subtle. Проверено на тест-векторе RFC 8291
// (convex/push.test.ts). Отправка — convex/push.ts.
import { env } from "../env";

const utf8 = new TextEncoder();

export const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** base64url → байты; null — строка не base64url. */
export function fromB64url(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF (RFC 5869) с одним блоком расширения — нам нужно не больше 32 байт. */
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** Публичный ключ P-256 в несжатом виде: 65 байт, первый — 0x04. */
export const isP256Point = (b: Uint8Array | null): b is Uint8Array<ArrayBuffer> => !!b && b.length === 65 && b[0] === 4;

/** JWK закрытого ключа P-256 из «сырого» d (32 байта) и несжатого публичного ключа. */
const privateJwk = (d: Uint8Array, pub: Uint8Array): JsonWebKey => ({ kty: "EC", crv: "P-256", d: b64url(d), x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true });

/** Ключ сервера для одного сообщения; в тестах — заданный (вектор RFC 8291). */
export interface SenderKeys {
  privateKey: CryptoKey;
  publicRaw: Uint8Array<ArrayBuffer>;
}

export async function importSenderKeys(d: Uint8Array, publicRaw: Uint8Array<ArrayBuffer>): Promise<SenderKeys> {
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk(d, publicRaw), { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey, publicRaw };
}

async function freshSenderKeys(): Promise<SenderKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return { privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)) };
}

/** Размер записи aes128gcm: одно сообщение — одна запись. */
const RECORD_SIZE = 4096;
/** Сколько байт текста помещается в одну запись: 4096 − 16 (тег GCM) − 1 (разделитель) − заголовок 86. */
export const MAX_PLAINTEXT = RECORD_SIZE - 16 - 1 - 86;

/**
 * Зашифровать сообщение для подписки (RFC 8291 §3, RFC 8188). uaPublic — ключ p256dh браузера, authSecret — auth.
 * keys и salt задаются только в тестах; в работе — новые на каждое сообщение.
 */
export async function encryptPush(
  plaintext: Uint8Array<ArrayBuffer>,
  uaPublic: Uint8Array<ArrayBuffer>,
  authSecret: Uint8Array<ArrayBuffer>,
  opts: { keys?: SenderKeys; salt?: Uint8Array<ArrayBuffer> } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error("Сообщение длиннее одной записи web push");
  const keys = opts.keys ?? (await freshSenderKeys());
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, keys.privateKey, 256));
  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const ikm = await hkdf(authSecret, ecdh, concat(utf8.encode("WebPush: info\0"), uaPublic, keys.publicRaw), 32);
  const cek = await hkdf(salt, ikm, utf8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  // Одна (последняя) запись: текст + разделитель 0x02, без дополнительного заполнения.
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(plaintext, new Uint8Array([2]))));
  const header = new Uint8Array(16 + 4 + 1);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = keys.publicRaw.length;
  return concat(header, keys.publicRaw, cipher);
}

// ── VAPID (RFC 8292) ─────────────────────────────────────────────────────────

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export const VAPID_ENV = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;

/** null — ключи не заданы или заданы с ошибкой: push не отправляется, переключатель у людей неактивен. */
export function vapidConfig(): Vapid | null {
  const publicKey = env("VAPID_PUBLIC_KEY");
  const privateKey = env("VAPID_PRIVATE_KEY");
  const subject = env("VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) return null;
  if (!isP256Point(fromB64url(publicKey)) || fromB64url(privateKey)?.length !== 32 || !/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}

/** JWT ES256 для заголовка Authorization: aud — источник адреса push-сервиса, срок — 12 часов (максимум 24). */
export async function vapidJwt(vapid: Vapid, endpoint: string, nowSec = Math.floor(Date.now() / 1000)): Promise<string> {
  const pub = fromB64url(vapid.publicKey)!;
  const key = await crypto.subtle.importKey("jwk", privateJwk(fromB64url(vapid.privateKey)!, pub), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = (o: object) => b64url(utf8.encode(JSON.stringify(o)));
  const unsigned = `${enc({ typ: "JWT", alg: "ES256" })}.${enc({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: vapid.subject })}`;
  // WebCrypto отдаёт подпись ECDSA уже в виде r || s (64 байта) — ровно как нужно JWS.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8.encode(unsigned)));
  return `${unsigned}.${b64url(sig)}`;
}

export const vapidAuthorization = async (vapid: Vapid, endpoint: string): Promise<string> => `vapid t=${await vapidJwt(vapid, endpoint)}, k=${vapid.publicKey}`;

// ── Подписки ─────────────────────────────────────────────────────────────────

/**
 * Адрес подписки выдаёт браузер, но присылает его клиент — сервер ходит только к известным push-сервисам
 * (Chrome/Android — FCM, Firefox — Mozilla, Safari — Apple, Edge — WNS), по https на стандартном порту.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*push\.apple\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];

export function isPushEndpoint(raw: string): boolean {
  if (raw.length > 1000) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.port && !u.username && !u.password && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

/** Ключи подписки из браузера: p256dh — точка P-256, auth — 16 байт. */
export const validKeys = (p256dh: string, auth: string): boolean => isP256Point(fromB64url(p256dh)) && fromB64url(auth)?.length === 16;
