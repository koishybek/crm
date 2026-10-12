// Навыки (ТЗ п.11, п.12, п.21): одно написание, одно сравнение и одни лимиты для сервера и интерфейса.
// Навыки сравниваются по «ключу»: регистр, лишние пробелы, «ё/е» и вид дефиса не важны —
// « монтаж  сплит‑систем » и «Монтаж сплит-систем» — один и тот же навык.
import type { Category } from "./catalog";
import type { CategoryId } from "./types";

/** Длина одного навыка — чтобы чипы помещались на экране телефона. */
export const SKILL_MAX_LENGTH = 40;
/** Навыков в одном направлении справочника. */
export const SKILLS_PER_CATEGORY = 30;
/** Навыков у одного исполнителя (из справочника и свои). */
export const SKILLS_PER_EXECUTOR = 100;

const DASHES = /[‐-―−]/g;

/** Ключ сравнения навыков и городов. */
export function textKey(s: string): string {
  return s.normalize("NFC").toLowerCase().replace(/ё/g, "е").replace(DASHES, "-").replace(/\s+/g, " ").trim();
}

/** Навык для хранения и показа: исходное написание без лишних пробелов. */
export function cleanSkill(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

export type SkillsResult = { ok: true; skills: string[] } | { ok: false; error: string };

/** Список навыков: чистим, убираем пустые и повторы (первое написание побеждает), проверяем лимиты. */
export function normalizeSkills(input: readonly string[], max: number): SkillsResult {
  const skills: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const s = cleanSkill(raw);
    if (!s) continue;
    if (s.length > SKILL_MAX_LENGTH) return { ok: false, error: `Навык «${s.slice(0, 24)}…» длиннее ${SKILL_MAX_LENGTH} символов — сократите` };
    const k = textKey(s);
    if (seen.has(k)) continue;
    seen.add(k);
    skills.push(s);
    if (skills.length > max) return { ok: false, error: `Не больше ${max} навыков` };
  }
  return { ok: true, skills };
}

/** Навыки справочника — всех направлений или только указанных; без повторов, в порядке справочника. */
export function catalogSkills(categories: readonly Pick<Category, "id" | "skills">[], only?: readonly CategoryId[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of categories) {
    if (only && !only.includes(c.id)) continue;
    for (const s of c.skills ?? []) {
      const k = textKey(s);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(s);
    }
  }
  return out;
}

/** Есть ли навык в списке (без учёта регистра, пробелов, «ё»). */
export function hasSkill(list: readonly string[], skill: string): boolean {
  const k = textKey(skill);
  return list.some((s) => textKey(s) === k);
}

/** Написание из справочника вместо введённого вручную: «мытье окон» → «Мытьё окон». */
export function canonicalSkills(skills: readonly string[], catalog: readonly string[]): string[] {
  const byKey = new Map(catalog.map((s) => [textKey(s), s] as const));
  return skills.map((s) => byKey.get(textKey(s)) ?? s);
}

export interface SkillsDiff {
  added: string[];
  removed: string[];
}

/** Что изменилось в списке навыков — для журнала действий. */
export function skillsDiff(before: readonly string[], after: readonly string[]): SkillsDiff {
  return { added: after.filter((s) => !hasSkill(before, s)), removed: before.filter((s) => !hasSkill(after, s)) };
}

/** «; навыки: +«А», −«Б»» — изменения навыков одной строкой для журнала; пусто, если ничего не поменялось. */
export function skillsDiffNote(diff: SkillsDiff): string {
  const parts = [...diff.added.map((s) => `+«${s}»`), ...diff.removed.map((s) => `−«${s}»`)];
  return parts.length ? `; навыки: ${parts.join(", ")}` : "";
}
