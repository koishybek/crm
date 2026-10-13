// Навыки в интерфейсе: показ чипами, выбор из справочника, редактирование списка.
// Сравнение и лимиты — из src/data/skills.ts, те же, что проверяет сервер.
import { Check, Plus, Wrench, X } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { CATEGORIES, categoryById } from "../data/catalog";
import { canonicalSkills, catalogSkills, cleanSkill, hasSkill, normalizeSkills, SKILL_MAX_LENGTH, SKILLS_PER_EXECUTOR, textKey } from "../data/skills";
import type { CategoryId } from "../data/types";
import { cn } from "../lib/format";

// Чип — блок внутри flex-ряда: так работает обрезка «…» у длинного навыка.
const CHIP = "block max-w-full rounded-[8px] border px-2 py-[3px] text-[12.5px] leading-[18px] font-medium whitespace-nowrap";

/** Есть ли навык где-нибудь в справочнике (всех направлений). */
export const inCatalog = (skill: string) => hasSkill(catalogSkills(CATEGORIES), skill);

/**
 * Навыки чипами. max — сколько показать, остальное «+N» (полный список — во всплывающей подсказке).
 * outline — требования заказа, заливка — навыки мастера. markCustom — пунктир у навыков не из справочника.
 */
export function SkillChips({
  skills,
  max,
  variant = "filled",
  empty,
  markCustom,
  className,
}: {
  skills?: readonly string[];
  max?: number;
  variant?: "filled" | "outline";
  empty?: ReactNode;
  markCustom?: boolean;
  className?: string;
}) {
  const list = skills ?? [];
  if (!list.length) return empty ? <>{empty}</> : null;
  const shown = max && list.length > max ? list.slice(0, max) : list;
  const rest = list.slice(shown.length);
  return (
    <span className={cn("flex min-w-0 flex-wrap gap-1.5", className)}>
      {shown.map((s) => {
        const custom = markCustom && !inCatalog(s);
        // Цвет рамки — одним классом: два border-* спорили бы, и пунктир не был бы виден.
        const look = custom ? "border-dashed border-faint bg-white text-ink-2" : variant === "outline" ? "border-line-strong bg-white text-ink-2" : "border-transparent bg-slate-bg text-ink-2";
        return (
          <span key={s} title={custom ? `${s} — не из справочника` : s} className={cn(CHIP, "min-w-0 truncate", look)}>
            {s}
          </span>
        );
      })}
      {rest.length > 0 && (
        <span title={rest.join(", ")} className={cn(CHIP, "shrink-0 border-transparent bg-slate-bg text-muted")}>
          +{rest.length}
        </span>
      )}
    </span>
  );
}

/** Навыки одной строкой с обрезкой — для ячеек таблиц. label — для экранного диктора и подсказки. */
export function SkillLine({ skills, label, icon, className }: { skills?: readonly string[]; label: string; icon?: boolean; className?: string }) {
  if (!skills?.length) return null;
  const text = skills.join(" · ");
  return (
    <span title={`${label}: ${text}`} className={cn("flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted", className)}>
      {icon && <Wrench size={13} className="shrink-0" aria-hidden />}
      <span className="sr-only">{label}: </span>
      <span className="truncate">{text}</span>
    </span>
  );
}

function ToggleChip({ on, onClick, children, note }: { on: boolean; onClick: () => void; children: ReactNode; note?: string }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex min-h-9 max-w-full items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-left text-[13.5px] font-medium transition-colors",
        on ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong bg-white text-ink-2 hover:border-brand-line",
      )}
    >
      {on && <Check size={15} strokeWidth={2.4} className="shrink-0" aria-hidden />}
      <span className="min-w-0">{children}</span>
      {note && <span className="shrink-0 text-[11.5px] font-normal text-muted">· {note}</span>}
    </button>
  );
}

const toggled = (value: readonly string[], skill: string): string[] =>
  hasSkill(value, skill) ? value.filter((x) => textKey(x) !== textKey(skill)) : [...value, skill];

/**
 * Выбор нескольких навыков из справочника (требования заказа).
 * Выбранные навыки, которых в справочнике уже нет, остаются видны — их можно снять.
 */
export function SkillPicker({ options, value, onChange, label }: { options: readonly string[]; value: readonly string[]; onChange: (v: string[]) => void; label: string }) {
  const stale = value.filter((s) => !hasSkill(options, s));
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((s) => (
        <ToggleChip key={s} on={hasSkill(value, s)} onClick={() => onChange(toggled(value, s))}>
          {s}
        </ToggleChip>
      ))}
      {stale.map((s) => (
        <ToggleChip key={s} on note="нет в справочнике" onClick={() => onChange(toggled(value, s))}>
          {s}
        </ToggleChip>
      ))}
    </div>
  );
}

/**
 * Список навыков с добавлением и удалением. Можно вставить сразу несколько через запятую.
 * taken — навыки, которые уже выбраны в другом месте формы (для сообщения «уже есть»).
 * counted — показывать «N из max» (в справочнике лимит на направление понятен, у мастера — нет).
 */
export function SkillListEditor({
  value,
  onChange,
  max,
  placeholder,
  note,
  taken = [],
  label,
  counted = true,
}: {
  value: readonly string[];
  onChange: (v: string[]) => void;
  max: number;
  placeholder: string;
  note?: (skill: string) => string | undefined;
  taken?: readonly string[];
  label: string;
  counted?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const inputId = useId();

  const add = () => {
    const parts = draft.split(/[,;\n]/).map(cleanSkill).filter(Boolean);
    if (!parts.length) return;
    const fresh = parts.filter((p) => !hasSkill(value, p) && !hasSkill(taken, p));
    if (!fresh.length) return setError(`«${parts[0]}» уже есть`);
    const r = normalizeSkills([...value, ...fresh], max);
    if (!r.ok) return setError(r.error);
    onChange(r.skills);
    setDraft("");
    setError("");
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={label}>
          {value.map((s) => {
            const n = note?.(s);
            return (
              <li key={s} className={cn("inline-flex min-h-9 max-w-full items-center gap-1 rounded-[10px] border bg-white py-1 pr-1 pl-3 text-[13.5px] font-medium text-ink-2", n ? "border-dashed border-faint" : "border-line-strong")}>
                <span className="min-w-0 truncate">{s}</span>
                {n && <span className="shrink-0 text-[11.5px] font-normal text-muted">· {n}</span>}
                <button
                  type="button"
                  onClick={() => onChange(value.filter((x) => x !== s))}
                  aria-label={`Убрать навык «${s}»`}
                  className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] text-muted hover:bg-hover hover:text-ink"
                >
                  <X size={15} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          {label}
        </label>
        <input
          id={inputId}
          className="field min-w-0 flex-1"
          value={draft}
          maxLength={SKILL_MAX_LENGTH * 10}
          placeholder={placeholder}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError("");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim()}
          className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-[10px] border border-line-strong bg-white px-3.5 text-[14px] font-semibold text-ink transition-colors hover:bg-hover disabled:opacity-50"
        >
          <Plus size={16} aria-hidden /> Добавить
        </button>
      </div>
      <div className={cn("text-[12.5px]", error ? "font-medium text-bad-ink" : "text-muted")} role={error ? "alert" : undefined}>
        {error || `${counted ? `${value.length} из ${max} · ` : ""}до ${SKILL_MAX_LENGTH} символов, можно несколько через запятую`}
      </div>
    </div>
  );
}

/** Навыки, которые при снятии специализации больше ничем не оправданы: были только в её справочнике. */
export function withoutCategory(skills: readonly string[], removed: CategoryId, remaining: readonly CategoryId[]): string[] {
  const gone = categoryById(removed).skills ?? [];
  const still = catalogSkills(CATEGORIES, remaining);
  return skills.filter((s) => !hasSkill(gone, s) || hasSkill(still, s));
}

/**
 * Навыки мастера: чипы из справочника его специализаций + свои навыки.
 * Свой навык, совпавший со справочником, превращается в навык справочника (его написание).
 */
export function ExecutorSkillsField({ categories, value, onChange }: { categories: readonly CategoryId[]; value: readonly string[]; onChange: (v: string[]) => void }) {
  const options = catalogSkills(CATEGORIES, categories);
  const picked = value.filter((s) => hasSkill(options, s));
  const extras = value.filter((s) => !hasSkill(options, s));
  const setExtras = (next: string[]) => {
    const canon = canonicalSkills(next, catalogSkills(CATEGORIES));
    onChange([...picked, ...canon.filter((s) => !hasSkill(picked, s))]);
  };
  return (
    <div className="flex flex-col gap-3.5">
      {categories.length === 0 && <p className="text-[13px] text-muted">Выберите специализации — появятся навыки из справочника.</p>}
      {categories.map((id) => {
        const c = categoryById(id);
        const list = c.skills ?? [];
        return (
          <div key={id}>
            <div className="mb-1.5 text-[12.5px] font-semibold tracking-wide text-muted uppercase">{c.label}</div>
            {list.length ? (
              <div role="group" aria-label={`Навыки: ${c.label}`} className="flex flex-wrap gap-2">
                {list.map((s) => (
                  <ToggleChip key={s} on={hasSkill(value, s)} onClick={() => onChange(toggled(value, s))}>
                    {s}
                  </ToggleChip>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-muted">Навыков в справочнике пока нет — владелец добавляет их в «Настройках».</p>
            )}
          </div>
        );
      })}
      <div>
        <div className="mb-1.5 text-[12.5px] font-semibold tracking-wide text-muted uppercase">Свои навыки</div>
        <SkillListEditor
          label="Свои навыки"
          value={extras}
          onChange={setExtras}
          max={SKILLS_PER_EXECUTOR}
          counted={false}
          placeholder="Например: Пайка плат"
          taken={picked}
          note={(s) => (inCatalog(s) ? undefined : "не из справочника")}
        />
      </div>
    </div>
  );
}
