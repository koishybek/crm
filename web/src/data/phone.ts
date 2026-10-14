// Телефоны клиентов (ТЗ п.7.1, E26): Казахстан и Россия — «7XXXXXXXXXX» (как раньше), другие страны — E.164 цифрами
// без «+» («996555123456»). Одно правило для сервера (база, поиск дублей, звонки АТС) и форм (маска ввода).

/**
 * Номер для базы или null. Без «+» номер считается казахстанским: «8 701 …», «701 …», «7701 …»; другой номер от 11 цифр
 * без «+» — уже международный (так его присылают АТС и WhatsApp). С «+» или «00» — любой код страны, 8–15 цифр.
 */
export function normalizePhone(raw: string): string | null {
  const s = raw.trim();
  if (!s || /[^\d\s+()\-.]/.test(s)) return null;
  let d = s.replace(/\D/g, "");
  let intl = s.startsWith("+");
  if (!intl && d.startsWith("00")) {
    d = d.slice(2);
    intl = true;
  }
  if (!intl) {
    if (d.length === 10) d = `7${d}`;
    else if (d.length === 11 && d.startsWith("8")) d = `7${d.slice(1)}`;
    else if (d.length < 11) return null;
  }
  // +7 — Казахстан и Россия: ровно 10 цифр после кода.
  if (d.startsWith("7")) return /^7\d{10}$/.test(d) ? d : null;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

/** Номер уже в виде для базы. */
export const isPhone = (p: string): boolean => normalizePhone(p) === p;

/** Номер страны +7 (Казахстан и Россия). */
export const isKzRu = (p: string): boolean => /^7\d{10}$/.test(p);

// Коды стран из одной и двух цифр (остальные — три): чтобы показать «+996 555 123 456», а не сплошные цифры.
const CC2 = new Set(
  "20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98".split(" "),
);
const ccLength = (d: string): number => (d.startsWith("1") || d.startsWith("7") ? 1 : CC2.has(d.slice(0, 2)) ? 2 : 3);

/** «996555123456» → «+996 555 123 456»: код страны, дальше группы по три (последняя — 2–4 цифры). */
function groupIntl(d: string): string {
  const cc = d.slice(0, ccLength(d));
  const rest = d.slice(cc.length);
  const groups: string[] = [];
  for (let i = 0; i < rest.length; ) {
    const left = rest.length - i;
    const n = left === 4 ? 4 : Math.min(3, left);
    groups.push(rest.slice(i, i + n));
    i += n;
  }
  return [`+${cc}`, ...groups].join(" ");
}

/** Номер для показа: «+7 701 123 45 67», «+996 555 123 456»; непонятное — как есть. */
export function formatPhone(raw: string): string {
  const d = raw.replace(/\D/g, "").replace(/^8(?=\d{10}$)/, "7");
  if (isKzRu(d)) return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9, 11)}`;
  return d.length >= 8 && d.length <= 15 && !d.startsWith("0") && !d.startsWith("7") ? groupIntl(d) : raw;
}

/**
 * Маска ввода: по умолчанию Казахстан «+7 (___) ___-__-__» (человек набирает 10 цифр; вставка «8 701…», «+7 701…»,
 * «7701…» тоже понимается). Начал с «+» и другого кода страны или вставил длинный номер — международный формат.
 */
export function phoneMask(raw: string): string {
  const s = raw.trim();
  const d = s.replace(/\D/g, "");
  if (s === "+") return "+";
  const intl = (s.startsWith("+") && !s.startsWith("+7")) || (!s.startsWith("+") && (d.length > 11 || (d.length === 11 && !/^[78]/.test(d))));
  if (intl) return d ? groupIntl(d.slice(0, 15)) : "+";
  const local = (s.startsWith("+7") ? s.slice(2).replace(/\D/g, "") : d.length === 11 && /^[78]/.test(d) ? d.slice(1) : d).slice(0, 10);
  if (!local) return s.startsWith("+7") ? "+7" : "";
  let out = `+7 (${local.slice(0, 3)}`;
  if (local.length >= 3) out += ")";
  if (local.length > 3) out += ` ${local.slice(3, 6)}`;
  if (local.length > 6) out += `-${local.slice(6, 8)}`;
  if (local.length > 8) out += `-${local.slice(8, 10)}`;
  return out;
}

/** Подсказка под полем телефона. */
export const PHONE_HINT = "Другая страна — начните с «+» и кода страны";
