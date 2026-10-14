// Компания (ТЗ §2.5, §23.7, §24.3–§24.5): карточка «Компания» в «Настройках» и «С чего начать» на «Главной» — только владельцу.
import { Building2, Check, Circle, Pencil, Rocket } from "lucide-react";
import { useState } from "react";
import { useQuery } from "convex/react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { Badge, Button, Card, IconButton, Input } from "../components/ui";
import { dismissOnboarding, renameCompany, useTenant } from "../data/tenant";
import { LIMIT_TEXT, MODULE_LABEL, MODULES, ONBOARDING_INFO, PLAN_INFO, planFor, type LimitKind } from "../data/plans";
import { report } from "../data/store";
import { money } from "../lib/format";
import { SubscriptionLine } from "./SubscriptionCards";

const LIMIT_ROWS: { kind: LimitKind; label: string }[] = [
  { kind: "users", label: "Сотрудники" },
  { kind: "executors", label: "Исполнители" },
  { kind: "ordersPerMonth", label: "Заказы в этом месяце" },
];

export function CompanyCard() {
  const t = useTenant();
  const owner = useQuery(api.tenants.company);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  if (!t || !owner) return null;

  const save = async () => {
    if (report(await renameCompany(name), "Название сохранено")) setEditing(false);
  };

  return (
    <Card icon={Building2} title="Компания" titleExtra={<Badge tone={t.status === "active" ? "green" : "red"} size="sm">{t.status === "active" ? "работает" : "приостановлена"}</Badge>}>
      <div className="space-y-4 text-[14px]">
        <div>
          <div className="text-[12.5px] font-medium text-muted">Название</div>
          {editing ? (
            <form className="mt-1 flex flex-wrap gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
              <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Название компании" className="min-w-0 flex-1" autoFocus />
              <Button size="sm" type="submit">Сохранить</Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Отмена</Button>
            </form>
          ) : (
            <div className="mt-0.5 flex items-center gap-2">
              <span className="font-semibold text-ink">{t.name}</span>
              <IconButton icon={Pencil} label="Изменить название" onClick={() => (setName(t.name), setEditing(true))} />
            </div>
          )}
        </div>
        <div>
          <div className="text-[12.5px] font-medium text-muted">Адрес компании</div>
          <code className="mt-0.5 inline-block rounded-[6px] bg-field px-1.5 py-0.5 text-[13px]">{t.slug}</code>
          <p className="mt-1 text-[12.5px] text-muted">Он в ссылке на форму заявки и в адресах уведомлений — поэтому не меняется.</p>
        </div>
        <div>
          <div className="text-[12.5px] font-medium text-muted">Тариф</div>
          <div className="mt-0.5 font-semibold text-ink">{PLAN_INFO[t.plan].label}</div>
          <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            {LIMIT_ROWS.map(({ kind, label }) => {
              const u = owner.usage[kind];
              return (
                <li key={kind} className="flex justify-between gap-2 text-[13.5px]">
                  <span className="text-ink-2">{label}</span>
                  <span className={u.cap !== null && u.used >= u.cap ? "font-semibold text-bad-ink tabular-nums" : "tabular-nums text-ink"}>
                    {u.used}
                    {u.cap === null ? " · без ограничения" : ` из ${u.cap}`}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
        <SubscriptionLine />
        <div>
          <div className="text-[12.5px] font-medium text-muted">Модули</div>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {MODULES.map((m) => (
              <li key={m}>
                {t.modules.includes(m) ? (
                  <Badge tone="green" size="sm">{MODULE_LABEL[m]}</Badge>
                ) : (
                  <span title={`Доступно на тарифе «${PLAN_INFO[planFor(m)].label}»`}>
                    <Badge tone="gray" size="sm">🔒 {MODULE_LABEL[m]}</Badge>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
        {owner.platformFee && owner.platformFee.value > 0 && (
          <p className="text-[13.5px] text-ink-2">
            Комиссия платформы с выполненного заказа: <span className="font-semibold text-ink">{owner.platformFee.mode === "percent" ? `${owner.platformFee.value}% от цены` : money(owner.platformFee.value)}</span> — в «Аналитике» вычитается из маржи.
          </p>
        )}
        <p className="text-[12.5px] text-muted">Лимиты: {LIMIT_ROWS.map((r) => LIMIT_TEXT[r.kind]).join(", ")}. Тариф, модули и подписку ведёт администратор платформы.</p>
      </div>
    </Card>
  );
}

/** «С чего начать» — пока владелец не прошёл шаги или не скрыл список. */
export function OnboardingCard() {
  const steps = useQuery(api.tenants.onboarding);
  if (!steps) return null;
  const left = steps.filter((s) => !s.done).length;
  return (
    <Card
      icon={Rocket}
      title="С чего начать"
      className="mb-4"
      titleExtra={<Badge tone="yellow" size="sm">осталось {left}</Badge>}
      action={
        <Button size="sm" variant="ghost" onClick={async () => report(await dismissOnboarding())}>
          Скрыть
        </Button>
      }
    >
      <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map(({ step, done }) => {
          const info = ONBOARDING_INFO[step];
          return (
            <li key={step}>
              <Link to={info.link} className="flex h-full items-start gap-2.5 rounded-[12px] border border-line p-3 hover:bg-hover">
                {done ? <Check size={18} className="mt-0.5 shrink-0 text-ok" aria-label="Сделано" /> : <Circle size={18} className="mt-0.5 shrink-0 text-faint" aria-label="Не сделано" />}
                <span>
                  <span className={done ? "block font-medium text-muted line-through" : "block font-semibold text-ink"}>{info.label}</span>
                  <span className="block text-[12.5px] text-muted">{info.hint}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
