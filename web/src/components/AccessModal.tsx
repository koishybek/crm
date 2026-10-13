// Владелец меняет роль сотрудника и направления руководителя. Права действуют сразу, изменение пишется в журнал.
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { CATEGORIES } from "../data/catalog";
import { report } from "../data/store";
import { updateAccess, type StaffRole } from "../data/team";
import type { User } from "../data/types";
import { cn } from "../lib/format";
import { Button, Modal, Segmented } from "./ui";

const ROLES: { value: StaffRole; label: string }[] = [
  { value: "operator", label: "Оператор" },
  { value: "manager", label: "Руководитель" },
  { value: "owner", label: "Владелец" },
];

export function AccessModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [role, setRole] = useState<StaffRole>("operator");
  const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user || user.role === "executor") return;
    setRole(user.role);
    setCats(user.categories ?? []);
  }, [user]);

  const save = async () => {
    if (!user) return;
    setBusy(true);
    const ok = report(await updateAccess(user.id, role, cats), "Доступ изменён");
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Роль: ${user?.name ?? ""}`}
      width={460}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button icon={ShieldCheck} disabled={busy || (role === "manager" && !cats.length)} onClick={() => void save()}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[13.5px] text-muted">Права меняются сразу — сотруднику придёт уведомление. Свою роль поменять нельзя: в компании всегда остаётся владелец.</p>
        <Segmented options={ROLES} value={role} onChange={setRole} />
        {role === "manager" && (
          <div>
            <div className="mb-2 text-[14px] font-semibold text-ink">Направления</div>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.filter((c) => c.active !== false || cats.includes(c.id)).map((c) => {
                const on = cats.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setCats((xs) => (on ? xs.filter((x) => x !== c.id) : [...xs, c.id]))}
                    className={cn(
                      "rounded-[10px] border px-3 py-2 text-[13.5px] font-medium",
                      on ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong text-ink-2 hover:border-brand-line",
                    )}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
