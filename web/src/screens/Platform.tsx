// «Платформа» (ТЗ §24.3–§24.5): администратор платформы (PLATFORM_ADMINS) видит компании, тариф, модули, статус
// и нагрузку и меняет их. Оплату тарифа ведут вне системы.
import { useQuery } from "convex/react";
import { Building2 } from "lucide-react";
import { useState } from "react";
import { Navigate } from "react-router";
import { api } from "../../convex/_generated/api";
import { Badge, Button, Card, Drawer, EmptyState, Input, Loading, PageHeader, Select } from "../components/ui";
import { report } from "../data/store";
import { updateTenant, useTenant } from "../data/tenant";
import { MODULE_LABEL, MODULES, PLAN_INFO, PLANS, type Plan, type PlatformTenantRow, type TenantModule } from "../data/plans";
import { date } from "../lib/format";

export default function Platform() {
  const me = useTenant();
  const rows = useQuery(api.platform.tenants, me?.platformAdmin ? {} : "skip");
  const [open, setOpen] = useState<PlatformTenantRow | null>(null);
  if (me === undefined) return <Loading />;
  if (!me?.platformAdmin) return <Navigate to="/" replace />;

  return (
    <>
      <PageHeader title="Платформа" subtitle="Компании, тарифы, модули и комиссия платформы" />
      <Card icon={Building2} title="Компании" bodyClass="px-0 pb-2">
        {rows === undefined ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState icon={Building2} title="Компаний пока нет" />
        ) : (
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[760px] text-[14px]">
              <thead className="bg-thead text-left text-[12.5px] text-muted">
                <tr>
                  <th className="px-5 py-2 font-medium">Компания</th>
                  <th className="px-3 py-2 font-medium">Тариф</th>
                  <th className="px-3 py-2 font-medium">Статус</th>
                  <th className="px-3 py-2 text-right font-medium">Сотрудники</th>
                  <th className="px-3 py-2 text-right font-medium">Исполнители</th>
                  <th className="px-3 py-2 text-right font-medium">Заказы за месяц</th>
                  <th className="px-5 py-2 font-medium">Создана</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.slug} className="cursor-pointer border-t border-line hover:bg-hover" onClick={() => setOpen(r)}>
                    <td className="px-5 py-2.5">
                      <div className="font-semibold text-ink">{r.name}</div>
                      <div className="text-[12.5px] text-muted">
                        {r.slug}
                        {r.owner ? ` · ${r.owner}` : ""}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">{PLAN_INFO[r.plan].label}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={r.status === "active" ? "green" : "red"} size="sm">
                        {r.status === "active" ? "работает" : "приостановлена"}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.usage.users}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.usage.executors}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums">{r.usage.ordersPerMonth}</td>
                    <td className="px-5 py-2.5 text-muted">{r.createdAt ? date(r.createdAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && <TenantDrawer row={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function TenantDrawer({ row, onClose }: { row: PlatformTenantRow; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan>(row.plan);
  const [modules, setModules] = useState<TenantModule[]>(row.modules);
  const [status, setStatus] = useState(row.status);
  const [feeMode, setFeeMode] = useState<"none" | "percent" | "fixed">(row.platformFee?.mode ?? "none");
  const [feeValue, setFeeValue] = useState(String(row.platformFee?.value ?? ""));
  const [busy, setBusy] = useState(false);

  const changePlan = (p: Plan) => {
    setPlan(p);
    setModules([...PLAN_INFO[p].modules]);
  };
  const toggle = (m: TenantModule) => setModules((list) => (list.includes(m) ? list.filter((x) => x !== m) : [...list, m]));
  const save = async () => {
    const value = Number(feeValue.replace(",", "."));
    if (feeMode !== "none" && (!Number.isFinite(value) || value < 0)) return report({ ok: false, error: "Комиссия — число не меньше нуля" });
    setBusy(true);
    const r = await updateTenant({ slug: row.slug, plan, modules, status, platformFee: feeMode === "none" ? null : { mode: feeMode, value } });
    setBusy(false);
    if (report(r, "Сохранено")) onClose();
  };

  return (
    <Drawer open onClose={onClose} title={row.name}>
      <div className="flex flex-col gap-5 text-[14px]">
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-muted">Тариф</span>
          <Select value={plan} onChange={(e) => changePlan(e.target.value as Plan)}>
            {PLANS.map((p) => (
              <option key={p} value={p}>
                {PLAN_INFO[p].label}
              </option>
            ))}
          </Select>
        </label>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-medium text-muted">Модули</legend>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {MODULES.map((m) => (
              <label key={m} className="flex items-center gap-2">
                <input type="checkbox" className="h-4 w-4 accent-[#b07200]" checked={modules.includes(m)} onChange={() => toggle(m)} />
                {MODULE_LABEL[m]}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="mb-1.5 block text-[13px] font-medium text-muted">Статус</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value as "active" | "suspended")}>
            <option value="active">Работает</option>
            <option value="suspended">Приостановлена</option>
          </Select>
        </label>
        <div>
          <span className="mb-1.5 block text-[13px] font-medium text-muted">Комиссия платформы с выполненного заказа</span>
          <div className="flex gap-2">
            <Select value={feeMode} onChange={(e) => setFeeMode(e.target.value as "none" | "percent" | "fixed")} aria-label="Вид комиссии">
              <option value="none">Нет</option>
              <option value="percent">Процент от цены</option>
              <option value="fixed">Сумма, ₸</option>
            </Select>
            {feeMode !== "none" && <Input inputMode="decimal" value={feeValue} onChange={(e) => setFeeValue(e.target.value)} aria-label="Размер комиссии" />}
          </div>
        </div>
        <Button disabled={busy} onClick={() => void save()}>
          Сохранить
        </Button>
      </div>
    </Drawer>
  );
}
