// Документы по заказу (ТЗ п.19.9): «Счёт на оплату» и «Акт выполненных работ», реквизиты компании, сумма прописью.
// Общие для сервера (convex/documents.ts — выпуск и снимок) и экранов (печатная страница, карточка заказа, настройки).
import type { OrderStatus } from "./types";

export type DocumentKind = "invoice" | "act";

export const DOC_KIND: Record<DocumentKind, { title: string; short: string; path: string }> = {
  invoice: { title: "Счёт на оплату", short: "Счёт", path: "invoice" },
  act: { title: "Акт выполненных работ (оказанных услуг)", short: "Акт", path: "act" },
};

export const isDocumentKind = (x: string): x is DocumentKind => x === "invoice" || x === "act";

/** Акт — когда работа сдана; счёт — пока заказ не отменён и не возвращён. */
export const ACT_STATUSES: readonly OrderStatus[] = ["done", "awaiting_payment", "paid", "closed"];
export const INVOICE_BLOCKED: readonly OrderStatus[] = ["cancelled", "refund"];

/** Ссылка клиенту на документ живёт 30 дней. */
export const DOC_LINK_TTL_MS = 30 * 24 * 3600_000;

// ── Сумма прописью ───────────────────────────────────────────────────────────

const ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"];
const TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"];
const TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят", "восемьдесят", "девяносто"];
const HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот", "восемьсот", "девятьсот"];
/** Разряды: тысячи — женского рода («одна тысяча», «две тысячи»), остальные — мужского. */
const GROUPS: { forms: [string, string, string] | null; fem: boolean }[] = [
  { forms: null, fem: false },
  { forms: ["тысяча", "тысячи", "тысяч"], fem: true },
  { forms: ["миллион", "миллиона", "миллионов"], fem: false },
  { forms: ["миллиард", "миллиарда", "миллиардов"], fem: false },
  { forms: ["триллион", "триллиона", "триллионов"], fem: false },
];

/** Форма слова для числа: 1 тысяча, 2 тысячи, 5 тысяч, 11 тысяч, 21 тысяча. */
export function pluralRu(n: number, forms: readonly [string, string, string]): string {
  const m100 = n % 100;
  const m10 = n % 10;
  if (m100 >= 11 && m100 <= 14) return forms[2];
  if (m10 === 1) return forms[0];
  if (m10 >= 2 && m10 <= 4) return forms[1];
  return forms[2];
}

function triad(n: number, fem: boolean): string[] {
  const out: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) out.push(HUNDREDS[h]!);
  if (rest >= 10 && rest < 20) out.push(TEENS[rest - 10]!);
  else {
    const t = Math.floor(rest / 10);
    const o = rest % 10;
    if (t) out.push(TENS[t]!);
    if (o) out.push((fem ? ONES_F : ONES_M)[o]!);
  }
  return out;
}

/** Целое число прописью (мужской род): 0 → «ноль», 21 → «двадцать один», 1 000 000 → «один миллион». */
export function numberInWords(n: number): string {
  const value = Math.floor(Math.abs(n));
  if (value === 0) return "ноль";
  const words: string[] = [];
  let rest = value;
  const parts: number[] = [];
  while (rest > 0) {
    parts.push(rest % 1000);
    rest = Math.floor(rest / 1000);
  }
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]!;
    if (!p) continue;
    const g = GROUPS[i] ?? GROUPS[GROUPS.length - 1]!;
    words.push(...triad(p, g.fem));
    if (g.forms) words.push(pluralRu(p, g.forms));
  }
  return words.join(" ");
}

/**
 * Сумма прописью для документов: «Пятнадцать тысяч тенге 00 тиын», «Двадцать один тенге 50 тиын».
 * «тенге» и «тиын» в документах РК не склоняются; тиыны — цифрами.
 */
export function sumInWords(amount: number): string {
  const cents = Math.round(Math.abs(amount) * 100);
  const tenge = Math.floor(cents / 100);
  const tiyn = cents % 100;
  const words = numberInWords(tenge);
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} тенге ${String(tiyn).padStart(2, "0")} тиын`;
}

// ── Реквизиты компании ───────────────────────────────────────────────────────

export interface CompanyRequisites {
  name: string;
  /** БИН (ТОО) или ИИН (ИП) — 12 цифр. */
  bin: string;
  address: string;
  bank: string;
  /** ИИК — счёт в формате IBAN: KZ + 18 знаков. */
  iik: string;
  /** БИК банка — 8 знаков (HSBKKZKX). */
  bik: string;
  /** КБе — код бенефициара, 2 цифры (17 — ТОО, 19 — ИП). */
  kbe: string;
  director: string;
  phone?: string;
  /** Отметка про НДС: «Без НДС» (по умолчанию) или «В том числе НДС 12%» — как решит бухгалтер. */
  vatNote?: string;
  /** Префиксы и стартовые номера нумерации — по умолчанию без префикса, с 1. */
  invoicePrefix?: string;
  actPrefix?: string;
  invoiceStart?: number;
  actStart?: number;
}

export const REQUISITE_FIELDS: { key: keyof CompanyRequisites; label: string; placeholder?: string }[] = [
  { key: "name", label: "Название (ТОО / ИП)", placeholder: "ТОО «Home Max Service»" },
  { key: "bin", label: "БИН / ИИН", placeholder: "12 цифр" },
  { key: "address", label: "Юридический адрес" },
  { key: "bank", label: "Банк", placeholder: "АО «Kaspi Bank»" },
  { key: "iik", label: "ИИК (IBAN)", placeholder: "KZ…" },
  { key: "bik", label: "БИК", placeholder: "CASPKZKA" },
  { key: "kbe", label: "КБе", placeholder: "17" },
  { key: "director", label: "Руководитель (ФИО)" },
  { key: "phone", label: "Телефон (необязательно)" },
  { key: "vatNote", label: "НДС", placeholder: "Без НДС" },
];

export const DEFAULT_VAT_NOTE = "Без НДС";

/** Реквизиты без лишних пробелов: ИИК и БИК — заглавными. */
export function cleanRequisites(r: CompanyRequisites): CompanyRequisites {
  const t = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  return {
    name: t(r.name),
    bin: t(r.bin).replace(/\s/g, ""),
    address: t(r.address),
    bank: t(r.bank),
    iik: t(r.iik).replace(/\s/g, "").toUpperCase(),
    bik: t(r.bik).replace(/\s/g, "").toUpperCase(),
    kbe: t(r.kbe),
    director: t(r.director),
    ...(t(r.phone) ? { phone: t(r.phone) } : {}),
    vatNote: t(r.vatNote) || DEFAULT_VAT_NOTE,
    ...(t(r.invoicePrefix) ? { invoicePrefix: t(r.invoicePrefix) } : {}),
    ...(t(r.actPrefix) ? { actPrefix: t(r.actPrefix) } : {}),
    ...(r.invoiceStart && r.invoiceStart > 1 ? { invoiceStart: Math.floor(r.invoiceStart) } : {}),
    ...(r.actStart && r.actStart > 1 ? { actStart: Math.floor(r.actStart) } : {}),
  };
}

/** Ошибки реквизитов — пусто, если документы можно выпускать. */
export function requisitesIssues(r: CompanyRequisites): string[] {
  const out: string[] = [];
  for (const f of REQUISITE_FIELDS) {
    const v = r[f.key];
    if (f.key !== "phone" && f.key !== "vatNote" && (typeof v !== "string" || !v.trim())) out.push(`Не заполнено: ${f.label}`);
  }
  if (r.bin && !/^\d{12}$/.test(r.bin)) out.push("БИН / ИИН — 12 цифр");
  if (r.iik && !/^KZ[0-9A-Z]{18}$/.test(r.iik)) out.push("ИИК — KZ и 18 знаков");
  if (r.bik && !/^[A-Z0-9]{8}$/.test(r.bik)) out.push("БИК — 8 латинских букв и цифр");
  if (r.kbe && !/^\d{2}$/.test(r.kbe)) out.push("КБе — 2 цифры");
  const long = (Object.entries(r) as [string, unknown][]).find(([, v]) => typeof v === "string" && v.length > 300);
  if (long) out.push("Слишком длинное значение в реквизитах");
  for (const p of [r.invoicePrefix, r.actPrefix]) if (p && p.length > 12) out.push("Префикс номера — не длиннее 12 символов");
  return out;
}

/** Номер для печати: префикс + число («СЧ-15»). */
export const docLabel = (prefix: string | undefined, n: number): string => `${prefix ?? ""}${n}`;

/** Снимок документа — то, что печатается (как convex/schema.ts documentData). */
export interface DocParty {
  name: string;
  bin?: string;
  address?: string;
  bank?: string;
  iik?: string;
  bik?: string;
  kbe?: string;
  director?: string;
  phone?: string;
}
export interface DocumentData {
  seller: DocParty;
  buyer: DocParty;
  orderNumber: number;
  lines: { name: string; qty: number; unit: string; price: number; sum: number }[];
  total: number;
  totalWords: string;
  paid: number;
  vatNote: string;
  basis?: string;
}

export interface DocumentSnapshot {
  kind: DocumentKind;
  label: string;
  date: string;
  data: DocumentData;
}

export interface OrderDocumentInfo {
  id: string;
  kind: DocumentKind;
  label: string;
  date: string;
  total: number;
  replaced: boolean;
  sentAt?: string;
  linkExpiresAt?: string;
}

/** Дата документа по Алматы: «14.10.2026». */
export function docDate(iso: string): string {
  const d = new Date(Date.parse(iso) + 5 * 3600_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}

/** Сумма в документе: «15 000,00». */
export const docMoney = (n: number): string => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n).replace(/ /g, " ");
