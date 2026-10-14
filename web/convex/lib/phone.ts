// Телефоны клиентов из форм, внешних каналов и АТС. В базе: Казахстан и Россия — «7XXXXXXXXXX», другие страны —
// E.164 цифрами без «+» (ТЗ п.7.1, E26). Правило одно — src/data/phone.ts (его же использует маска ввода в формах).
import { ConvexError } from "convex/values";
import { normalizeLogin } from "./login";
import { isPhone, normalizePhone } from "../../src/data/phone";

export { normalizePhone };

/** Номер в виде для базы клиентов: «7XXXXXXXXXX» или международный E.164 без «+». */
export const isClientPhone = (p: string): boolean => isPhone(p);

/** Телефон клиента из формы или ошибка, понятная человеку. */
export function clientPhone(raw: string): string {
  const p = normalizePhone(raw.slice(0, 40));
  if (!p) throw new ConvexError("Укажите телефон полностью: +7 (___) ___-__-__ или номер другой страны с «+» и кодом");
  return p;
}

/**
 * Номер из АТС: «+77011234567», «87011234567», «996555123456». Короткий внутренний номер («101») или мусор —
 * цифрами как есть: для показа, но не для поиска клиента.
 */
export function pbxPhone(raw: string | undefined): string {
  const s = (raw ?? "").replace(/[^\d+]/g, "").slice(0, 32);
  return normalizePhone(s) ?? normalizeLogin(s);
}

/**
 * Казахстанский номер: после кода +7 идёт 6 или 7 (мобильные 70x/747/77x, городские 7xx).
 * «+7 (701) 123-45-67», «8 701 1234567», «7011234567» → «77011234567»; иначе null.
 */
export function kzPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 11) return null;
  const p = normalizeLogin(digits);
  return /^7[67]\d{9}$/.test(p) ? p : null;
}

/**
 * Номер собеседника из канала (WhatsApp, Telegram-контакт) — каналы присылают его с кодом страны, обычно без «+».
 * Казахстан и Россия — «7XXXXXXXXXX», другая страна — E.164 цифрами: такой номер тоже годится для базы клиентов.
 */
export function contactPhone(raw: string | undefined): string | undefined {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return undefined;
  // Каналы присылают номер с кодом страны: «8…» здесь — не казахстанская «восьмёрка», а код страны (+84 и др.).
  return (digits.length === 10 ? normalizePhone(digits) : normalizePhone(`+${digits}`)) ?? digits;
}

// «мой номер 8 701 123 45 67», «+7(701)1234567», «тел. 87011234567». Перед номером — не цифра, после — тоже.
const IN_TEXT = /(?:^|\D)(?:\+\s?7|8|7)[\s\-().]{0,3}([67]\d{2})[\s\-().]{0,3}(\d{3})[\s\-.]{0,2}(\d{2})[\s\-.]{0,2}(\d{2})(?!\d)/;

/** Первый казахстанский номер в тексте сообщения или null. */
export function findKzPhone(text: string): string | null {
  const m = IN_TEXT.exec(text);
  return m ? `7${m[1]}${m[2]}${m[3]}${m[4]}` : null;
}
