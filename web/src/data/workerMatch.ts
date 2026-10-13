// Подходит ли заказ мастеру по профилю: тот же город, его направление и все требуемые навыки.
// Сравнение — как в правиле подбора команды: регистр, лишние пробелы, «ё/е» и вид дефиса не важны.
// «Принимаю заказы» здесь не учитывается: превью заказа мастер видит и с выключенным приёмом.

const DASHES = /[‐-―−]/g;

/** Ключ сравнения города и навыков. */
export const matchKey = (s: string): string => s.normalize("NFC").toLowerCase().replace(/ё/g, "е").replace(DASHES, "-").replace(/\s+/g, " ").trim();

export interface MatchExecutor {
  city: string;
  categories: readonly string[];
  skills: readonly string[];
}

export interface MatchOrder {
  city: string;
  category: string;
  requiredSkills?: readonly string[];
}

/** Требуемые навыки заказа, которых у мастера нет. */
export function missingSkills(ex: Pick<MatchExecutor, "skills">, required: readonly string[] = []): string[] {
  const own = new Set(ex.skills.map(matchKey));
  return required.filter((s) => !own.has(matchKey(s)));
}

/** Есть ли у мастера этот навык. */
export function hasSkill(ex: Pick<MatchExecutor, "skills">, skill: string): boolean {
  const key = matchKey(skill);
  return ex.skills.some((s) => matchKey(s) === key);
}

export function fitsProfile(ex: MatchExecutor, o: MatchOrder): boolean {
  return matchKey(ex.city) === matchKey(o.city) && ex.categories.includes(o.category) && missingSkills(ex, o.requiredSkills).length === 0;
}
