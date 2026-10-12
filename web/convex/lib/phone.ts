// Телефоны клиентов из внешних каналов. Внутри системы номер всегда «7XXXXXXXXXX» (как в clients.phone).
import { normalizeLogin } from "./login";

/** Номер для базы клиентов: 11 цифр, начинается с 7 (Казахстан и Россия — общий код +7). */
export const isClientPhone = (p: string): boolean => /^7\d{10}$/.test(p);

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
 * Номер собеседника из канала (WhatsApp, Telegram-контакт): +7 приводим к «7XXXXXXXXXX»,
 * иностранный оставляем цифрами — для показа и звонка, но не для базы клиентов.
 */
export function contactPhone(raw: string | undefined): string | undefined {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return undefined;
  const p = normalizeLogin(digits);
  return isClientPhone(p) ? p : digits;
}

// «мой номер 8 701 123 45 67», «+7(701)1234567», «тел. 87011234567». Перед номером — не цифра, после — тоже.
const IN_TEXT = /(?:^|\D)(?:\+\s?7|8|7)[\s\-().]{0,3}([67]\d{2})[\s\-().]{0,3}(\d{3})[\s\-.]{0,2}(\d{2})[\s\-.]{0,2}(\d{2})(?!\d)/;

/** Первый казахстанский номер в тексте сообщения или null. */
export function findKzPhone(text: string): string | null {
  const m = IN_TEXT.exec(text);
  return m ? `7${m[1]}${m[2]}${m[3]}${m[4]}` : null;
}
