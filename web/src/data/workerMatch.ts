// Подходит ли заказ мастеру по профилю — то же правило, что у команды (fitsOrder в src/data/logic.ts):
// тот же город (и район, если у мастера заданы районы), его направление и все требуемые навыки; регистр, лишние
// пробелы, «ё/е» и вид дефиса не важны.
// «Принимаю заказы» здесь не учитывается: превью заказа мастер видит и с выключенным приёмом.
import { fitsOrder } from "./logic";
import { hasSkill as listHasSkill, textKey } from "./skills";

/** Ключ сравнения города и навыков. */
export const matchKey = textKey;

export interface MatchExecutor {
  city: string;
  categories: readonly string[];
  skills: readonly string[];
  districts?: readonly string[];
}

export interface MatchOrder {
  city: string;
  category: string;
  requiredSkills?: readonly string[];
  district?: string;
}

/** Требуемые навыки заказа, которых у мастера нет. */
export function missingSkills(ex: Pick<MatchExecutor, "skills">, required: readonly string[] = []): string[] {
  return required.filter((s) => !listHasSkill(ex.skills, s));
}

/** Есть ли у мастера этот навык. */
export function hasSkill(ex: Pick<MatchExecutor, "skills">, skill: string): boolean {
  return listHasSkill(ex.skills, skill);
}

export function fitsProfile(ex: MatchExecutor, o: MatchOrder): boolean {
  return fitsOrder({ available: true, city: ex.city, categories: [...ex.categories], skills: [...ex.skills], districts: ex.districts }, o).fits;
}
