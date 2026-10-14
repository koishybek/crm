// Замок платного модуля (ТЗ §24.3): модуль выключен у компании — вместо функции подпись «Доступно на тарифе …».
// Сервер проверяет модуль сам (lib/tenant.ts hasModule) — замок только объясняет, почему функции нет.
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { useModule } from "../data/tenant";
import { lockText, MODULE_LABEL, type TenantModule } from "../data/plans";
import { Card } from "./ui";

export function LockNote({ module }: { module: TenantModule }) {
  return (
    <p className="flex items-start gap-2 text-[13.5px] text-muted">
      <Lock size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{lockText(module)}. Тариф меняет администратор платформы.</span>
    </p>
  );
}

/** card — замок карточкой с названием модуля (для «Настроек»), иначе — строкой (в карточке заказа, в аналитике). */
export function ModuleGate({ module, card, children }: { module: TenantModule; card?: boolean; children: ReactNode }) {
  const on = useModule(module);
  if (on === undefined) return null;
  if (on) return <>{children}</>;
  if (!card) return <LockNote module={module} />;
  return (
    <Card icon={Lock} title={MODULE_LABEL[module]}>
      <LockNote module={module} />
    </Card>
  );
}
