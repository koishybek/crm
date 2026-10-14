// Район города (ТЗ п.12.3): один район — у заявки и заказа, несколько — у мастера (пусто — весь город).
// Списки — из справочника районов (владелец правит в «Настройках»); у города без районов поля нет.
import { MapPinned } from "lucide-react";
import { useCityDistricts } from "../data/matchActions";
import { districtKey } from "../data/cities";
import { cn } from "../lib/format";
import { FormRow, Select } from "./ui";

/** Район заявки или заказа. Город без районов в справочнике — поле не показываем. */
export function DistrictField({ city, value, onChange, disabled }: { city: string; value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const options = useCityDistricts(city);
  if (!city || (!options.length && !value)) return null;
  // Район, которого уже нет в справочнике, остаётся видимым, пока его не сменят.
  const list = value && !options.some((d) => districtKey(d) === districtKey(value)) ? [value, ...options] : options;
  return (
    <FormRow label="Район" hint="Мастерам с заданными районами заказ уйдёт, только если район — их. Не знаете — оставьте пустым">
      {(id) => (
        <Select id={id} icon={MapPinned} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">Не указан</option>
          {list.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
      )}
    </FormRow>
  );
}

/** Районы мастера: ничего не выбрано — весь город. */
export function DistrictPicker({ city, value, onChange }: { city: string; value: string[]; onChange: (v: string[]) => void }) {
  const options = useCityDistricts(city);
  if (!city || !options.length) return null;
  const on = (d: string) => value.some((x) => districtKey(x) === districtKey(d));
  return (
    <div>
      <div className="mb-1 text-[14px] font-semibold text-ink">Районы</div>
      <p className="mb-2.5 text-[12.5px] text-muted">Ничего не выбрано — мастер берёт заказы по всему городу. Выбраны — только заказы этих районов и заказы без района.</p>
      <div className="flex flex-wrap gap-2">
        {options.map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={on(d)}
            onClick={() => onChange(on(d) ? value.filter((x) => districtKey(x) !== districtKey(d)) : [...value, d])}
            className={cn("rounded-[10px] border px-3 py-2 text-[13.5px] font-medium transition-colors", on(d) ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong text-ink-2 hover:border-brand-line")}
          >
            {d}
          </button>
        ))}
      </div>
    </div>
  );
}
