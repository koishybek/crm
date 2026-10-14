// Владелец меняет роль сотрудника, направления руководителя и права поверх роли (ТЗ п.5.12). Права действуют сразу,
// каждое изменение пишется в журнал; сервер проверяет те же правила (convex/permissions.ts).
import { RotateCcw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { CATEGORIES } from "../data/catalog";
import { isRoleDefault, PERMISSION_INFO, PERMISSIONS, permissionFits, permissionsOf, type Permission } from "../data/permissions";
import { report, toast } from "../data/store";
import { setPermissions, updateAccess, type StaffRole } from "../data/team";
import type { User } from "../data/types";
import { cn } from "../lib/format";
import { Button, Modal, Segmented, Toggle } from "./ui";

const ROLES: { value: StaffRole; label: string }[] = [
  { value: "operator", label: "Оператор" },
  { value: "manager", label: "Руководитель" },
  { value: "owner", label: "Владелец" },
];

/** Включить право — вместе с тем, без чего оно не работает; выключить — вместе с тем, что от него зависит. */
function toggle(perms: readonly Permission[], p: Permission, on: boolean): Permission[] {
  const set = new Set(perms);
  if (on) {
    for (let x: Permission | undefined = p; x; x = PERMISSION_INFO[x].needs) set.add(x);
  } else {
    set.delete(p);
    for (let changed = true; changed; ) {
      changed = false;
      for (const x of set) {
        const needs = PERMISSION_INFO[x].needs;
        if (needs && !set.has(needs)) {
          set.delete(x);
          changed = true;
        }
      }
    }
  }
  return PERMISSIONS.filter((x) => set.has(x));
}

export function AccessModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const [role, setRole] = useState<StaffRole>("operator");
  const [cats, setCats] = useState<string[]>([]);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!user || user.role === "executor") return;
    setRole(user.role);
    setCats(user.categories ?? []);
    setPerms(permissionsOf(user));
  }, [user]);

  // Новая роль — права по её умолчаниям (так же делает сервер при смене роли).
  const pickRole = (r: StaffRole) => {
    setRole(r);
    setPerms(user && r === user.role ? permissionsOf(user) : permissionsOf({ role: r }));
  };

  const save = async () => {
    if (!user || user.role === "executor") return;
    setBusy(true);
    const roleChanged = role !== user.role || cats.join() !== (user.categories ?? []).join();
    let ok = true;
    if (roleChanged) ok = report(await updateAccess(user.id, role, cats));
    const before = role === user.role ? permissionsOf(user) : permissionsOf({ role });
    const permsChanged = role !== "owner" && perms.join() !== before.join();
    if (ok && permsChanged) ok = report(await setPermissions(user.id, isRoleDefault(role, perms) ? null : perms));
    setBusy(false);
    if (!ok) return;
    if (roleChanged || permsChanged) toast("Доступ изменён");
    onClose();
  };

  const options = PERMISSIONS.filter((p) => permissionFits(p, role));
  const isDefault = isRoleDefault(role, perms);

  return (
    <Modal
      open={!!user}
      onClose={onClose}
      title={`Доступ: ${user?.name ?? ""}`}
      width={560}
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
        <Segmented options={ROLES} value={role} onChange={pickRole} />
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
        {role === "owner" ? (
          <p className="rounded-[12px] bg-[#f8f6f1] px-4 py-3 text-[13.5px] text-ink-2">Владелец видит и меняет всё: деньги, клиентов, аналитику, настройки.</p>
        ) : (
          <div>
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[14px] font-semibold text-ink">Права</div>
              {isDefault ? (
                <span className="text-[12.5px] text-muted">как у роли по умолчанию</span>
              ) : (
                <button type="button" onClick={() => setPerms(permissionsOf({ role }))} className="inline-flex items-center gap-1.5 text-[13px] font-medium text-brand-ink hover:text-brand-deep">
                  <RotateCcw size={14} /> Как у роли по умолчанию
                </button>
              )}
            </div>
            <ul className="divide-y divide-line">
              {options.map((p) => {
                const info = PERMISSION_INFO[p];
                return (
                  <li key={p} className="py-2.5">
                    <Toggle checked={perms.includes(p)} onChange={(on) => setPerms((xs) => toggle(xs, p, on))} label={info.label} />
                    <p className="mt-1 pl-[54px] text-[12.5px] text-muted">
                      {info.hint}
                      {info.needs ? ` Включает «${PERMISSION_INFO[info.needs].label}».` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
