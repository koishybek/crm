import { useQuery } from "convex/react";
import { Layers, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { asService, type Category, type Service, type ServiceIcon, type Tone } from "../data/catalog";
import { convex, run } from "../data/convex";
import { report, toast } from "../data/store";
import { SERVICE_ICON_NAMES, ServiceTile, TONE_SOFT } from "../components/icons";
import { SkillChips, SkillListEditor } from "../components/SkillChips";
import { Badge, Button, Card, FormRow, Input, Loading, Modal, Select, Textarea, Toggle } from "../components/ui";
import { normalizeSkills, SKILLS_PER_CATEGORY } from "../data/skills";
import { cn, digits, num } from "../lib/format";

const TONES: { id: Tone; label: string }[] = [
  { id: "blue", label: "Синий" },
  { id: "green", label: "Зелёный" },
  { id: "amber", label: "Янтарный" },
  { id: "orange", label: "Оранжевый" },
  { id: "violet", label: "Фиолетовый" },
  { id: "sky", label: "Голубой" },
  { id: "red", label: "Красный" },
  { id: "gray", label: "Серый" },
];

/**
 * Справочник «направления → услуги». Цены здесь — подсказка оператору и база для доли исполнителя;
 * в каждом заказе цена всё равно ставится вручную. Удаления нет — только «скрыть», чтобы не ломать старые заказы.
 */
export function CatalogEditor() {
  const data = useQuery(api.catalog.list);
  const [cat, setCat] = useState<Category | "new" | null>(null);
  const [svc, setSvc] = useState<Service | { category: string } | null>(null);
  if (!data) return <Loading />;

  return (
    <Card
      icon={Layers}
      title="Услуги и цены"
      action={
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => setCat("new")}>
          Направление
        </Button>
      }
    >
      <p className="-mt-1 mb-4 text-[13.5px] text-muted">
        По направлениям, навыкам и городу исполнители видят заказы в ленте. Навыки направления мастер отмечает у себя, оператор — в заказе. Цена — подсказка оператору, доля — выплата исполнителю по умолчанию.
      </p>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {data.categories.map((c) => {
          const list = data.services.map(asService).filter((s) => s.category === c.id);
          return (
            <section key={c.id} className={cn("rounded-[14px] border border-line p-3", c.active === false && "opacity-60")}>
              <header className="flex items-center gap-2 px-1 pb-2">
                <span className={cn("rounded-[8px] px-2.5 py-1 text-[13px] font-semibold", TONE_SOFT[c.tone])}>{c.label}</span>
                {c.active === false && <Badge tone="gray" size="sm">скрыто</Badge>}
                <span className="flex-1" />
                <button onClick={() => setCat(c)} aria-label={`Изменить направление ${c.label}`} className="inline-flex h-8 w-8 items-center justify-center rounded-[8px] text-muted hover:bg-hover hover:text-ink">
                  <Pencil size={15} />
                </button>
                <button onClick={() => setSvc({ category: c.id })} className="inline-flex h-8 items-center gap-1 rounded-[8px] px-2 text-[13px] font-medium text-brand-ink hover:bg-brand-soft">
                  <Plus size={15} /> Услуга
                </button>
              </header>
              <button onClick={() => setCat(c)} className="mb-2 block w-full rounded-[10px] px-1 py-1.5 text-left hover:bg-hover" aria-label={`Навыки направления ${c.label}: изменить`}>
                <span className="mb-1 block text-[12px] font-semibold tracking-wide text-muted uppercase">Навыки · {c.skills?.length ?? 0}</span>
                <SkillChips skills={c.skills} max={8} empty={<span className="text-[13px] text-warn-ink">Не заданы — добавьте, чтобы точнее подбирать исполнителей</span>} />
              </button>
              <ul className="divide-y divide-line">
                {list.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => setSvc(s)} className={cn("flex w-full items-center gap-3 rounded-[10px] px-1 py-2 text-left hover:bg-hover", s.active === false && "opacity-55")}>
                      <ServiceTile serviceId={s.id} size={34} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-ink">{s.label}</span>
                        <span className="text-[12.5px] text-muted">
                          {s.price[1] > 0 ? `${num(s.price[0])}–${num(s.price[1])} ₸` : "цена по договорённости"} · исполнителю {s.payoutPct}%{s.active === false ? " · скрыта" : ""}
                        </span>
                      </span>
                      <Pencil size={14} className="text-faint" />
                    </button>
                  </li>
                ))}
                {!list.length && <li className="px-1 py-3 text-[13px] text-muted">Услуг пока нет</li>}
              </ul>
            </section>
          );
        })}
      </div>

      {cat && <CategoryModal value={cat === "new" ? null : cat} onClose={() => setCat(null)} />}
      {svc && <ServiceModal value={"id" in svc ? svc : null} category={svc.category} categories={data.categories} onClose={() => setSvc(null)} />}
    </Card>
  );
}

function CategoryModal({ value, onClose }: { value: Category | null; onClose: () => void }) {
  const [label, setLabel] = useState(value?.label ?? "");
  const [tone, setTone] = useState<Tone>(value?.tone ?? "blue");
  const [active, setActive] = useState(value?.active !== false);
  const [skills, setSkills] = useState<string[]>(value?.skills ?? []);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const checked = normalizeSkills(skills, SKILLS_PER_CATEGORY);
    if (!checked.ok) return toast(checked.error, "bad");
    setBusy(true);
    const r = await run(convex.mutation(api.catalog.saveCategory, { id: value?.id, label, tone, active, skills: checked.skills }));
    setBusy(false);
    if (report(r, "Направление сохранено")) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={value ? "Направление" : "Новое направление"}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormRow label="Название" required>
          {(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Разработка сайтов" />}
        </FormRow>
        <div>
          <div className="mb-2 text-[14px] font-semibold text-ink">Цвет метки</div>
          <div className="flex flex-wrap gap-2">
            {TONES.map((t) => (
              <button key={t.id} type="button" onClick={() => setTone(t.id)} className={cn("rounded-[8px] border-2 px-2.5 py-1 text-[13px] font-semibold", TONE_SOFT[t.id], tone === t.id ? "border-ink" : "border-transparent")}>
                {t.label}
              </button>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-[14px] font-semibold text-ink">Навыки</div>
          <p className="mb-2 text-[12.5px] text-muted">Мастер отмечает свои навыки из этого списка, оператор — нужные в заказе. Заказ с навыком увидят только мастера, у которых он есть.</p>
          <SkillListEditor label={`Навыки направления ${label || "без названия"}`} value={skills} onChange={setSkills} max={SKILLS_PER_CATEGORY} placeholder="Например: Монтаж сплит-систем" />
        </div>
        <Toggle checked={active} onChange={setActive} label={active ? "Показывается в формах" : "Скрыто (старые заказы не меняются)"} />
      </div>
    </Modal>
  );
}

function ServiceModal({ value, category, categories, onClose }: { value: Service | null; category: string; categories: Category[]; onClose: () => void }) {
  const [label, setLabel] = useState(value?.label ?? "");
  const [cat, setCat] = useState(value?.category ?? category);
  const [icon, setIcon] = useState<ServiceIcon>(value?.icon ?? "wrench");
  const [min, setMin] = useState(String(value?.price[0] ?? ""));
  const [max, setMax] = useState(String(value?.price[1] ?? ""));
  const [pct, setPct] = useState(String(value?.payoutPct ?? 70));
  const [examples, setExamples] = useState((value?.examples ?? []).join("\n"));
  const [active, setActive] = useState(value?.active !== false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await run(
      convex.mutation(api.catalog.saveService, {
        id: value?.id,
        category: cat,
        label,
        icon,
        priceMin: Number(digits(min)) || 0,
        priceMax: Number(digits(max)) || 0,
        payoutPct: Number(pct.replace(",", ".")) || 0,
        examples: examples.split("\n"),
        active,
      }),
    );
    setBusy(false);
    if (report(r, "Услуга сохранена")) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={value ? "Услуга" : "Новая услуга"}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button disabled={busy} onClick={() => void save()}>
            Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormRow label="Название" required>
          {(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Настройка сервера" />}
        </FormRow>
        <FormRow label="Направление">
          {(id) => (
            <Select id={id} value={cat} onChange={(e) => setCat(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          )}
        </FormRow>
        <div className="grid grid-cols-3 gap-3">
          <FormRow label="Цена от, ₸">{(id) => <Input id={id} inputMode="numeric" value={min ? num(Number(digits(min))) : ""} onChange={(e) => setMin(digits(e.target.value))} />}</FormRow>
          <FormRow label="до, ₸">{(id) => <Input id={id} inputMode="numeric" value={max ? num(Number(digits(max))) : ""} onChange={(e) => setMax(digits(e.target.value))} />}</FormRow>
          <FormRow label="Исполнителю, %">{(id) => <Input id={id} inputMode="decimal" value={pct} onChange={(e) => setPct(e.target.value.replace(/[^\d.,]/g, ""))} />}</FormRow>
        </div>
        <div>
          <div className="mb-2 text-[14px] font-semibold text-ink">Иконка</div>
          <div className="flex flex-wrap gap-1.5">
            {SERVICE_ICON_NAMES().map((name) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                onClick={() => setIcon(name)}
                className={cn("rounded-[12px] border-2 p-0.5", icon === name ? "border-ink" : "border-transparent")}
              >
                <IconPreview icon={name} category={cat} categories={categories} />
              </button>
            ))}
          </div>
        </div>
        <FormRow label="Примеры описаний" hint="По одному в строке — оператор подставит их в заявку одним нажатием">
          {(id) => <Textarea id={id} rows={3} value={examples} onChange={(e) => setExamples(e.target.value)} placeholder={"Не включается\nНужна диагностика"} />}
        </FormRow>
        <Toggle checked={active} onChange={setActive} label={active ? "Показывается в формах" : "Скрыта (старые заказы не меняются)"} />
      </div>
    </Modal>
  );
}

/** Превью иконки в цвете направления — без временной услуги в справочнике. */
function IconPreview({ icon, category, categories }: { icon: ServiceIcon; category: string; categories: Category[] }) {
  const tone = categories.find((c) => c.id === category)?.tone ?? "gray";
  return <ServiceTile serviceId="" size={34} preview={{ icon, tone }} />;
}
