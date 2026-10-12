const nf = new Intl.NumberFormat("ru-RU");

export const money = (n: number) => `${nf.format(Math.round(n))} ₸`;
export const num = (n: number) => nf.format(Math.round(n));

/** 528 000 → «528K», 1 250 000 → «1,3M» — для осей и подписей графиков. */
export const moneyShort = (n: number) => {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}M`;
  if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
};

export const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

export const digits = (s: string) => s.replace(/\D/g, "");

/** «77011234567» → «+7 701 123 45 67». */
export const phone = (raw: string) => {
  const d = digits(raw).replace(/^8/, "7");
  if (d.length !== 11) return raw;
  return `+${d[0]} ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7, 9)} ${d.slice(9, 11)}`;
};

/**
 * Маска ввода «+7 (___) ___-__-__». «+7» — постоянный префикс, человек набирает свои 10 цифр
 * («701 111 22 33»); вставка «8 701…», «+7 701…» и «7701…» тоже понимается.
 */
export const phoneMask = (raw: string) => {
  const d = digits(raw);
  const local = (raw.trim().startsWith("+7") ? digits(raw.trim().slice(2)) : d.length === 11 && /^[78]/.test(d) ? d.slice(1) : d).slice(0, 10);
  if (!local) return "";
  const p = local;
  let out = "+7";
  if (p.length > 0) out += ` (${p.slice(0, 3)}`;
  if (p.length >= 3) out += ")";
  if (p.length > 3) out += ` ${p.slice(3, 6)}`;
  if (p.length > 6) out += `-${p.slice(6, 8)}`;
  if (p.length > 8) out += `-${p.slice(8, 10)}`;
  return out;
};

const MONTHS = ["янв.", "фев.", "мар.", "апр.", "мая", "июн.", "июл.", "авг.", "сент.", "окт.", "нояб.", "дек."];
const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

const pad = (n: number) => String(n).padStart(2, "0");
export const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
export const dayDiff = (a: Date, b: Date) => Math.round((startOfDay(a).getTime() - startOfDay(b).getTime()) / 86400000);

/** «12 окт. 2026» */
export const date = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

/** «12 окт. 2026, 14:00» */
export const dateTime = (iso: string) => `${date(iso)}, ${hm(new Date(iso))}`;

/** «12 окт» без года — для осей. */
export const dayLabel = (d: Date) => `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;

/** «Сегодня 12:24», «Вчера 18:20», «10 окт. 17:24». */
export const when = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff === 0) return `Сегодня ${hm(d)}`;
  if (diff === -1) return `Вчера ${hm(d)}`;
  if (diff === 1) return `Завтра ${hm(d)}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? "" : " " + d.getFullYear()} ${hm(d)}`;
};

/** Короткая отметка: «12:24» сегодня, «Вчера», «12 окт.». */
export const whenShort = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff === 0) return hm(d);
  if (diff === -1) return "Вчера";
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

/** Срок: «Сегодня, 14:00», «Завтра, 10:00», «15 окт., 12:00». */
export const deadline = (iso: string, now = new Date()) => {
  const d = new Date(iso);
  const diff = dayDiff(d, now);
  if (diff === 0) return `Сегодня, ${hm(d)}`;
  if (diff === 1) return `Завтра, ${hm(d)}`;
  if (diff === -1) return `Вчера, ${hm(d)}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${hm(d)}`;
};

/** Значение для <input type="datetime-local">. */
export const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${hm(d)}`;
};

export const initials = (name: string) =>
  name
    .replace(/[«»"]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/** «Айсулу Нурланова» → «Айсулу Н.»; компании не сокращаем. */
export const shortName = (name: string) => {
  if (/^(ТОО|ИП|АО|ЖК|ОСИ|КСК)\b/.test(name)) return name;
  const [first, last] = name.split(/\s+/);
  return last ? `${first} ${last[0]}.` : first!;
};

export const firstName = (name: string) => name.split(/\s+/)[0]!;

export const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

export const cn = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(" ");
