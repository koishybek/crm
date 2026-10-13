// Границы ввода: слишком длинный текст — это и мусор в интерфейсе, и способ раздуть документы базы.
import { ConvexError } from "convex/values";
import { normalizeCity } from "../../src/data/cities";

/** Текст без пробелов по краям; длиннее max — понятная ошибка вместо молчаливой обрезки. */
export function cleanText(value: string, max: number, label: string): string {
  const s = value.trim();
  if (s.length > max) throw new ConvexError(`${label} — не длиннее ${max} символов`);
  return s;
}

/** Самая большая сумма в одном поле денег, ₸: защита от опечаток «лишний ноль» и мусора вроде Infinity. */
export const MAX_MONEY = 1_000_000_000;

/** Сумма в тенге: целое, конечное, не отрицательное и не больше MAX_MONEY. */
export function cleanMoney(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new ConvexError(`${label}: укажите сумму не меньше нуля`);
  if (value > MAX_MONEY) throw new ConvexError(`${label}: слишком большая сумма`);
  return Math.round(value);
}

/** Город из формы: одно написание на город (src/data/cities.ts, E11), не длиннее 60 символов, пустой — ошибка. */
export function cleanCity(value: string, label = "Город"): string {
  const city = normalizeCity(cleanText(value, 60, label));
  if (!city) throw new ConvexError("Укажите город");
  return city;
}
