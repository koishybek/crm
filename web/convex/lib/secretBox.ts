// Токены интеграций в базе — только зашифрованными (аудит E28, I-2): AES-256-GCM, ключ — INTEGRATIONS_KEY из окружения
// (32 случайных байта в base64). Шифруют и расшифровывают только actions: мутации хранят и отдают готовый шифртекст,
// а перед записью проверяют, что им дали именно его (isSealed). Без ключа токены не сохраняются вовсе.
// Формат значения: «enc:v1:» + base64url(iv ‖ шифртекст с тегом). AAD — назначение поля: токен одного поля нельзя
// подставить в другое (refresh вместо access и наоборот).
import { env } from "../env";

const PREFIX = "enc:v1:";
const IV_BYTES = 12;
/** Тег GCM — 16 байт: короче не бывает даже у пустой строки. */
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export type SecretPurpose = "olx.accessToken" | "olx.refreshToken" | "webhook.secret";

/** key — ключа нет или он неверный; open — шифртекст не открывается этим ключом (ключ сменили или данные испорчены). */
export class SecretBoxError extends Error {
  constructor(readonly reason: "key" | "open") {
    super(reason === "key" ? "INTEGRATIONS_KEY не задан или неверный" : "Секрет не расшифровывается");
    this.name = "SecretBoxError";
  }
}

const utf8 = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

/** base64 и base64url, с выравниванием «=» и без. null — не base64. */
function fromBase64(raw: string): Uint8Array<ArrayBuffer> | null {
  const s = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.length % 4 ? s + "=".repeat(4 - (s.length % 4)) : s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function keyBytes(): Uint8Array<ArrayBuffer> | null {
  const raw = env("INTEGRATIONS_KEY");
  const bytes = raw ? fromBase64(raw) : null;
  return bytes && bytes.length === KEY_BYTES ? bytes : null;
}

/** Что не так с ключом шифрования — текст для владельца (карточка OLX, «Состояние системы»); null — ключ в порядке. */
export function integrationsKeyIssue(): string | null {
  if (!env("INTEGRATIONS_KEY")) return "Не задан ключ шифрования INTEGRATIONS_KEY — токены OLX без него не сохраняются. Задайте переменную окружения Convex: 32 случайных байта в base64";
  return keyBytes() ? null : "Ключ шифрования INTEGRATIONS_KEY задан неверно — нужны ровно 32 байта в base64";
}

async function aesKey(): Promise<CryptoKey> {
  const bytes = keyBytes();
  if (!bytes) throw new SecretBoxError("key");
  return crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Значение зашифровано (проверка формата для мутаций — без криптографии). */
export const isSealed = (value: string): boolean => value.startsWith(PREFIX) && value.length >= PREFIX.length + Math.ceil(((IV_BYTES + TAG_BYTES) * 4) / 3);

/** Открытый текст → значение для базы. Без ключа — SecretBoxError("key"): открытым текстом не сохраняем. */
export async function sealSecret(plain: string, purpose: SecretPurpose): Promise<string> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(purpose) }, key, utf8(plain)));
  const out = new Uint8Array(IV_BYTES + sealed.length);
  out.set(iv);
  out.set(sealed, IV_BYTES);
  return PREFIX + toBase64Url(out);
}

/**
 * Значение из базы → открытый текст. legacy — сохранено ещё до шифрования (открытым текстом): работает как есть
 * и заменяется зашифрованным при следующей записи (обновление токена раз в сутки).
 */
export async function openSecret(stored: string, purpose: SecretPurpose): Promise<{ value: string; legacy: boolean }> {
  if (!stored.startsWith(PREFIX)) return { value: stored, legacy: true };
  const key = await aesKey();
  const bytes = fromBase64(stored.slice(PREFIX.length));
  if (!bytes || bytes.length < IV_BYTES + TAG_BYTES) throw new SecretBoxError("open");
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, IV_BYTES), additionalData: utf8(purpose) }, key, bytes.slice(IV_BYTES));
    return { value: new TextDecoder().decode(plain), legacy: false };
  } catch {
    throw new SecretBoxError("open");
  }
}
