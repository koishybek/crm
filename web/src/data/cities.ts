// Города (ТЗ п.12 «территория», E11): одно написание на город. Город приходит свободной строкой — из AI-разбора,
// форм, импорта Excel, бота, сайта и API; «г. Алматы», «алматы» и «Almaty» — один город, иначе заказ с таким
// городом не увидит ни один мастер. Модуль общий для интерфейса и сервера.
import { CITIES } from "./catalog";
import { textKey } from "./skills";

type City = (typeof CITIES)[number];

/** Другие написания городов справочника: латиница, прежние названия, казахское написание. */
const ALIASES: Record<City, readonly string[]> = {
  Алматы: ["алма-ата", "алмата", "алма ата", "almaty", "alma-ata", "alma ata"],
  Астана: ["нур-султан", "нурсултан", "нур султан", "nur-sultan", "nursultan", "astana", "акмола", "целиноград"],
  Шымкент: ["чимкент", "shymkent", "chimkent"],
  Караганда: ["қарағанды", "караганды", "karaganda", "karagandy", "qaraghandy"],
};

const KNOWN = new Map<string, City>(CITIES.flatMap((c) => [[textKey(c), c] as const, ...ALIASES[c].map((a) => [textKey(a), c] as const)]));

/** «г.», «гор.», «город», казахское «қ.» и «қаласы», английское «city» — не часть названия. */
const PREFIX = /^(?:г\.|г\s|гор\.|город\s|қ\.|қала\s|city of\s)\s*/iu;
const SUFFIX = /\s+(?:г\.?|гор\.?|город|қ\.?|қаласы|city)$/iu;

/** Слова города с заглавной: «усть-каменогорск» → «Усть-Каменогорск». */
const capitalize = (s: string) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());

/**
 * Город в едином написании. Город справочника — как в справочнике («г. Алматы», «ALMATY» → «Алматы»);
 * другой город — без «г.» и лишних пробелов, а набранный целиком строчными или прописными — с заглавной.
 * Пусто — пустая строка (проверку «укажите город» делает вызывающий).
 */
export function normalizeCity(raw: string | null | undefined): string {
  let s = (raw ?? "").normalize("NFC").replace(/\s+/g, " ").trim().replace(/[\s.,;:]+$/, "");
  for (let i = 0; i < 2; i++) s = s.replace(PREFIX, "").replace(SUFFIX, "").trim();
  if (!s) return "";
  const known = KNOWN.get(textKey(s));
  if (known) return known;
  return s === s.toLowerCase() || s === s.toUpperCase() ? capitalize(s) : s;
}

/** Ключ сравнения городов: один город в любом написании — один ключ. */
export const cityKey = (raw: string): string => textKey(normalizeCity(raw));
