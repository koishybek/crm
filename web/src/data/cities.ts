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

// ── Районы (ТЗ п.12.3 «территория») ─────────────────────────────────────────
// Справочник районов городов: по умолчанию — административные районы; владелец правит список в «Настройках»
// (convex/districts.ts). У мастера районы необязательны (пусто — весь город), у заказа и заявки — тоже.

/** Районы по умолчанию — административное деление городов справочника. */
export const DEFAULT_DISTRICTS: Readonly<Record<City, readonly string[]>> = {
  Алматы: ["Алмалинский", "Ауэзовский", "Бостандыкский", "Жетысуский", "Медеуский", "Наурызбайский", "Турксибский", "Алатауский"],
  Астана: ["Алматинский", "Байконурский", "Есильский", "Сарыаркинский", "Нуринский"],
  Шымкент: ["Абайский", "Аль-Фарабийский", "Енбекшинский", "Каратауский", "Туранский"],
  Караганда: ["имени Казыбек би", "Алихана Бокейханова"],
};

/** Справочник районов: город (в едином написании) → районы. */
export type DistrictMap = Record<string, string[]>;
/** Справочник районов для передачи между сервером и интерфейсом: ключи объектов Convex — только ASCII, города — списком. */
export type DistrictList = { city: string; districts: string[] }[];

export const toDistrictList = (map: DistrictMap): DistrictList => Object.entries(map).map(([city, districts]) => ({ city, districts }));
export const fromDistrictList = (list: DistrictList): DistrictMap => Object.fromEntries(list.map((x) => [x.city, x.districts]));

/** Сколько районов в одном городе и какой длины название — не больше. */
export const DISTRICT_LIMITS = { perCity: 30, cities: 20, name: 40 } as const;

/** Ключ сравнения районов: «Бостандыкский» = «бостандыкский » = «БОСТАНДЫКСКИЙ». */
export const districtKey = (raw: string): string => textKey(raw);

/** Район в тексте: «Бостандыкский р-н», «р-н имени Казыбек би». */
export const districtLabel = (d: string): string => (/(?:ий|ой)$/u.test(d) ? `${d} р-н` : `р-н ${d}`);

/** Районы города по справочнику: город — в любом написании. */
export function districtsOf(map: DistrictMap, city: string): string[] {
  const key = cityKey(city);
  for (const [c, list] of Object.entries(map)) if (cityKey(c) === key) return list;
  return [];
}

/** Район в написании справочника; не из справочника города — null. */
export function canonicalDistrict(map: DistrictMap, city: string, raw: string | null | undefined): string | null {
  const key = districtKey(raw ?? "");
  if (!key) return null;
  return districtsOf(map, city).find((d) => districtKey(d) === key) ?? null;
}

/** «Бостандыкский» → «бостандык», «имени Казыбек би» → «казыбек»: основа названия для поиска в тексте. */
function districtStem(name: string): string {
  const words = districtKey(name).split(" ").filter((w) => w !== "имени" && w !== "им.");
  return (words[0] ?? "").replace(/(?:инский|ский|ской|ий|ый|ой|а)$/u, "");
}

/** Слово «район» в тексте: «район», «р-н», «р.н.», казахское «ауданы». */
const DISTRICT_WORD = String.raw`(?:район|р-н|р\.?н\.?|ауданы)`;
/** Граница слова для кириллицы (\b в JS её не понимает). */
const EDGE = String.raw`(?:^|[^\p{L}])`;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Район, который в тексте назван явно: «Бостандыкский район», «Алмалинский р-н», «район Есиль», «Медеу ауданы».
 * По улицам и микрорайонам район не угадываем: без слова «район» рядом с названием — null. Нашлось два разных — тоже null.
 */
export function findDistrict(text: string | null | undefined, districts: readonly string[]): string | null {
  const t = districtKey(text ?? "");
  if (!t) return null;
  const found = districts.filter((d) => {
    const stem = districtStem(d);
    if (stem.length < 3) return false;
    const name = String.raw`${escapeRe(stem)}\p{L}*`;
    const after = new RegExp(String.raw`${EDGE}${name}\s+${DISTRICT_WORD}(?![\p{L}])`, "u");
    const before = new RegExp(String.raw`${EDGE}${DISTRICT_WORD}\s+(?:имени\s+)?${name}`, "u");
    return after.test(t) || before.test(t);
  });
  return found.length === 1 ? found[0]! : null;
}
