// «Платформа» (ТЗ §24): компании клиентов заводит администратор, оплату подписки принимает лично (Kaspi, перевод,
// наличные) и вносит здесь. Правила сроков — src/data/billing.ts, сервер — convex/billing.ts и convex/platform.ts.
import { useQuery } from "convex/react";
import { Copy, Download, KeyRound, Settings2, Undo2, Wallet } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { Badge, Button, Card, FormRow, Input, Loading, Modal, Segmented, Select, Textarea } from "../components/ui";
import { acceptPayment, createCompany, loadAllPayments, savePlatformSettings, undoPayment } from "../data/billingActions";
import {
  dayText,
  MAX_GRACE_DAYS,
  MAX_HOW_TO_PAY,
  MAX_MONTHS,
  MAX_NOTE,
  PAY_METHOD_LABEL,
  PAY_METHODS,
  paymentPeriod,
  paymentsCsv,
  periodProblem,
  statusText,
  subscriptionStatus,
  todayAlmaty,
  type PayMethod,
  type PlatformSettings,
  type SubscriptionPaymentRow,
  type SubscriptionState,
} from "../data/billing";
import { APP_NAME, CITIES, type Tone } from "../data/catalog";
import { PLAN_INFO, PLANS, slugify, SLUG_RE, type Plan, type PlatformTenantRow } from "../data/plans";
import { report, toast } from "../data/store";
import { exportCsv, stamp } from "../lib/csv";
import { dateTime, money } from "../lib/format";

const STATE_TONE: Record<SubscriptionState, Tone> = { unlimited: "gray", paid: "green", ending: "amber", expired: "red" };

/** Срок подписки в списке: оплачено / заканчивается через ≤ 7 дней / просрочено N дней / бессрочно. */
export function SubscriptionBadge({ paidUntil }: { paidUntil: string | null }) {
  const s = subscriptionStatus(paidUntil, todayAlmaty());
  return (
    <Badge tone={STATE_TONE[s.state]} size="sm">
      {statusText(s, paidUntil)}
    </Badge>
  );
}

/** Выгрузка всех оплат подписки в CSV (ячейки обезврежены от формул — src/lib/csv.ts). */
export async function exportPayments(): Promise<void> {
  const r = await loadAllPayments();
  if (!report(r)) return;
  if (!r.value.length) return void toast("Оплат пока нет", "info");
  exportCsv(paymentsCsv(r.value, dateTime), `oplaty-podpiski-${stamp()}.csv`);
}

// ── Создать компанию ─────────────────────────────────────────────────────────

export function CreateCompanyModal({ onClose }: { onClose: () => void }) {
  const [company, setCompany] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [city, setCity] = useState<string>(CITIES[0]);
  const [plan, setPlan] = useState<Plan>("standard");
  const [ownerName, setOwnerName] = useState("");
  const [login, setLogin] = useState("");
  const [paidUntil, setPaidUntil] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creds, setCreds] = useState<{ slug: string; login: string; password: string } | null>(null);

  const changeName = (v: string) => {
    setCompany(v);
    if (!slugEdited) setSlug(v.trim() ? slugify(v) : "");
  };
  const submit = async () => {
    setError("");
    if (!SLUG_RE.test(slug)) return setError("Адрес компании — от 3 до 40 символов: латиница, цифры и дефис");
    setBusy(true);
    const r = await createCompany({ company, slug, city, plan, ownerName, login, ...(paidUntil ? { paidUntil } : {}) });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setCreds(r.value);
  };

  if (creds)
    return (
      <Modal open onClose={onClose} title="Компания создана">
        <div className="flex flex-col gap-4 text-[14.5px]">
          <p className="rounded-[14px] border border-[#bfeed5] bg-ok-bg/60 p-4 text-ink-2">
            <b className="text-ink">{company.trim()}</b> ({creds.slug}) — тариф «{PLAN_INFO[plan].label}», справочник услуг по умолчанию. Передайте владельцу данные для входа: пароль показывается один раз, при первом входе он задаст свой.
          </p>
          <div className="rounded-[14px] border border-line p-4">
            <div className="flex items-center gap-2 font-semibold text-ink">
              <KeyRound size={17} className="text-brand-ink" aria-hidden /> Вход в {APP_NAME}
            </div>
            <dl className="mt-3 space-y-2 text-[15px]">
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Логин</dt>
                <dd className="font-semibold break-all text-ink">{creds.login}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Временный пароль</dt>
                <dd className="font-mono text-[16px] font-semibold tracking-wide text-ink">{creds.password}</dd>
              </div>
            </dl>
            <Button
              variant="secondary"
              size="sm"
              icon={Copy}
              className="mt-4"
              onClick={() => {
                void navigator.clipboard?.writeText(`${APP_NAME} — вход: ${window.location.origin}\nЛогин: ${creds.login}\nВременный пароль: ${creds.password}`);
                toast("Скопировано — отправьте владельцу", "info");
              }}
            >
              Скопировать для отправки
            </Button>
          </div>
          <Button onClick={onClose}>Готово</Button>
        </div>
      </Modal>
    );

  return (
    <Modal open onClose={onClose} title="Создать компанию" width={560}>
      <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
        <FormRow label="Название компании" required>
          {(id) => <Input id={id} value={company} maxLength={80} onChange={(e) => changeName(e.target.value)} autoFocus />}
        </FormRow>
        <FormRow label="Адрес компании" required hint="В ссылке на форму заявки (/zayavka?c=…). Потом не меняется.">
          {(id) => (
            <Input
              id={id}
              value={slug}
              maxLength={40}
              onChange={(e) => (setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "")), setSlugEdited(true))}
            />
          )}
        </FormRow>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <FormRow label="Город" required>
            {(id) => (
              <Select id={id} value={city} onChange={(e) => setCity(e.target.value)}>
                {CITIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </Select>
            )}
          </FormRow>
          <FormRow label="Тариф" required>
            {(id) => (
              <Select id={id} value={plan} onChange={(e) => setPlan(e.target.value as Plan)}>
                {PLANS.map((p) => (
                  <option key={p} value={p}>
                    {PLAN_INFO[p].label}
                  </option>
                ))}
              </Select>
            )}
          </FormRow>
        </div>
        <FormRow label="Имя владельца" required>
          {(id) => <Input id={id} value={ownerName} maxLength={80} onChange={(e) => setOwnerName(e.target.value)} />}
        </FormRow>
        <FormRow label="Логин владельца" required hint="Email или казахстанский номер телефона. Пароль создаст система — покажем один раз.">
          {(id) => <Input id={id} value={login} maxLength={120} autoComplete="off" onChange={(e) => setLogin(e.target.value)} />}
        </FormRow>
        <FormRow label="Оплачено до" hint="Пусто — бессрочно. Оплату потом вносите кнопкой «Принять оплату».">
          {(id) => <Input id={id} type="date" min={todayAlmaty()} value={paidUntil} onChange={(e) => setPaidUntil(e.target.value)} />}
        </FormRow>
        {error && <p className="text-[13.5px] font-medium text-bad-ink">{error}</p>}
        <Button type="submit" disabled={busy || !company.trim() || !ownerName.trim() || !login.trim()}>
          Создать компанию
        </Button>
      </form>
    </Modal>
  );
}

// ── Оплата подписки компании ─────────────────────────────────────────────────

/** «Принять оплату» и история оплат — в карточке компании на экране «Платформа». */
export function PaymentPanel({ row }: { row: PlatformTenantRow }) {
  const history = useQuery(api.billing.payments, { slug: row.slug });
  const settings = useQuery(api.billing.settings);
  const [open, setOpen] = useState(false);

  return (
    <section className="border-t border-line pt-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-muted">Подписка</div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{row.paidUntil ? `до ${dayText(row.paidUntil)}` : "бессрочно"}</span>
            <SubscriptionBadge paidUntil={row.paidUntil} />
            {row.suspendedFor === "unpaid" && <Badge tone="red" size="sm">приостановлена за неоплату</Badge>}
          </div>
        </div>
        {!open && (
          <Button size="sm" icon={Wallet} onClick={() => setOpen(true)}>
            Принять оплату
          </Button>
        )}
      </div>
      {open && settings && <PaymentForm row={row} price={settings.prices[row.plan]} onDone={() => setOpen(false)} />}
      <h3 className="mt-5 mb-2 text-[13px] font-medium text-muted">История оплат</h3>
      {history === undefined ? (
        <Loading />
      ) : history.length === 0 ? (
        <p className="text-[13.5px] text-muted">Оплат пока не было.</p>
      ) : (
        <ul className="divide-y divide-line">
          {history.map((p) => (
            <PaymentItem key={p.id} slug={row.slug} p={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PaymentForm({ row, price, onDone }: { row: PlatformTenantRow; price: number; onDone: () => void }) {
  const [mode, setMode] = useState<"months" | "until">("months");
  const [months, setMonths] = useState("1");
  const [until, setUntil] = useState("");
  const [amount, setAmount] = useState(price ? String(price) : "");
  const [amountEdited, setAmountEdited] = useState(false);
  const [method, setMethod] = useState<PayMethod>("kaspi");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const today = todayAlmaty();
  const n = Number(months);
  const validMonths = Number.isInteger(n) && n >= 1 && n <= MAX_MONTHS;
  const period = mode === "months" ? (validMonths ? paymentPeriod(row.paidUntil, today, { months: n }) : null) : until ? paymentPeriod(row.paidUntil, today, { until }) : null;
  const problem = period ? periodProblem(period, today) : null;

  const changeMonths = (v: string) => {
    setMonths(v);
    const m = Number(v);
    if (!amountEdited && price && Number.isInteger(m) && m > 0) setAmount(String(price * m));
  };
  const submit = async () => {
    const sum = Number(amount.replace(/\s/g, "").replace(",", "."));
    if (!Number.isFinite(sum) || sum < 0) return report({ ok: false, error: "Сумма — число не меньше нуля" });
    if (!period || problem) return report({ ok: false, error: problem ?? "Укажите период" });
    setBusy(true);
    const r = await acceptPayment({ slug: row.slug, amount: sum, method, ...(mode === "months" ? { months: n } : { until }), ...(note.trim() ? { note: note.trim() } : {}) });
    setBusy(false);
    if (report(r, r.ok ? `Оплата принята — оплачено до ${dayText(r.value.paidUntil)}${r.value.reactivated ? ", работа возобновлена" : ""}` : undefined)) onDone();
  };

  return (
    <form className="mt-4 flex flex-col gap-4 rounded-[14px] border border-line p-4" onSubmit={(e) => (e.preventDefault(), void submit())}>
      <Segmented
        value={mode}
        onChange={setMode}
        options={[
          { value: "months", label: "На месяцы" },
          { value: "until", label: "До даты" },
        ]}
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {mode === "months" ? (
          <FormRow label="Месяцев" required>
            {(id) => <Input id={id} type="number" min={1} max={MAX_MONTHS} step={1} value={months} onChange={(e) => changeMonths(e.target.value)} />}
          </FormRow>
        ) : (
          <FormRow label="Оплачено до" required>
            {(id) => <Input id={id} type="date" min={today} value={until} onChange={(e) => setUntil(e.target.value)} />}
          </FormRow>
        )}
        <FormRow label="Сумма, ₸" required hint={price ? `Цена тарифа «${PLAN_INFO[row.plan].label}» — ${money(price)} в месяц` : undefined}>
          {(id) => <Input id={id} inputMode="decimal" value={amount} onChange={(e) => (setAmount(e.target.value), setAmountEdited(true))} />}
        </FormRow>
      </div>
      <FormRow label="Способ оплаты" required>
        {(id) => (
          <Select id={id} value={method} onChange={(e) => setMethod(e.target.value as PayMethod)}>
            {PAY_METHODS.map((m) => (
              <option key={m} value={m}>
                {PAY_METHOD_LABEL[m]}
              </option>
            ))}
          </Select>
        )}
      </FormRow>
      <FormRow label="Комментарий">
        {(id) => <Textarea id={id} rows={2} maxLength={MAX_NOTE} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Например: номер перевода Kaspi" />}
      </FormRow>
      <p className={problem ? "text-[13.5px] font-medium text-bad-ink" : "text-[13.5px] text-ink-2"}>
        {problem ?? (period ? `Период: ${dayText(period.from)} — ${dayText(period.to)}${row.suspendedFor === "unpaid" ? ". Работа компании возобновится сразу" : ""}` : "Укажите период")}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !period || !!problem}>
          Принять оплату
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Отмена
        </Button>
      </div>
    </form>
  );
}

function PaymentItem({ slug, p }: { slug: string; p: SubscriptionPaymentRow }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    const r = await undoPayment(slug, p.id);
    setBusy(false);
    setConfirm(false);
    report(r, "Оплата отменена");
  };
  return (
    <li className={p.undoneAt ? "py-2.5 text-[13.5px] text-muted line-through" : "py-2.5 text-[13.5px]"}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-semibold text-ink">
          {money(p.amount)} · {PAY_METHOD_LABEL[p.method]}
        </span>
        <span className="text-muted">{dateTime(p.paidAt)}</span>
      </div>
      <div className="text-ink-2">
        {dayText(p.periodFrom)} — {dayText(p.periodTo)}
        {p.months ? ` (${p.months} мес.)` : ""} · {PLAN_INFO[p.plan].label} · принял {p.byName}
      </div>
      {p.note && <div className="text-muted">{p.note}</div>}
      {p.undoneAt && <div className="text-muted no-underline">отменена {dateTime(p.undoneAt)}</div>}
      {p.canUndo &&
        (confirm ? (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <span className="text-ink-2">Отменить оплату? Срок вернётся прежним.</span>
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void undo()}>
              Да, отменить
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              Нет
            </Button>
          </div>
        ) : (
          <Button size="sm" variant="ghost" icon={Undo2} className="mt-1" onClick={() => setConfirm(true)}>
            Отменить (в течение суток)
          </Button>
        ))}
    </li>
  );
}

// ── Настройки платформы ──────────────────────────────────────────────────────

export function PlatformSettingsCard() {
  const saved = useQuery(api.billing.settings);
  if (saved === undefined) return null;
  return <SettingsForm key={JSON.stringify(saved)} saved={saved} />;
}

function SettingsForm({ saved }: { saved: PlatformSettings }) {
  const [grace, setGrace] = useState(String(saved.graceDays));
  const [howToPay, setHowToPay] = useState(saved.howToPay);
  const [prices, setPrices] = useState<Record<Plan, string>>({ free: String(saved.prices.free || ""), standard: String(saved.prices.standard || ""), pro: String(saved.prices.pro || "") });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const num = (s: string) => (s.trim() ? Number(s.replace(/\s/g, "")) : 0);
    setBusy(true);
    const r = await savePlatformSettings({ graceDays: Number(grace), howToPay, prices: { free: num(prices.free), standard: num(prices.standard), pro: num(prices.pro) } });
    setBusy(false);
    report(r, "Настройки платформы сохранены");
  };

  return (
    <Card icon={Settings2} title="Настройки платформы" className="mt-4">
      <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), void save())}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
          <FormRow label="Льготных дней" hint="После «оплачено до» — потом приостановка">
            {(id) => <Input id={id} type="number" min={0} max={MAX_GRACE_DAYS} value={grace} onChange={(e) => setGrace(e.target.value)} />}
          </FormRow>
          {PLANS.map((p) => (
            <FormRow key={p} label={`${PLAN_INFO[p].label}, ₸/мес`}>
              {(id) => <Input id={id} inputMode="numeric" value={prices[p]} placeholder="не задана" onChange={(e) => setPrices((x) => ({ ...x, [p]: e.target.value }))} />}
            </FormRow>
          ))}
        </div>
        <FormRow label="Как оплатить" hint="Видят владельцы в напоминаниях и на экране «Доступ отключён»: номер Kaspi, реквизиты, телефон.">
          {(id) => <Textarea id={id} rows={3} maxLength={MAX_HOW_TO_PAY} value={howToPay} onChange={(e) => setHowToPay(e.target.value)} placeholder="Например: Kaspi Gold +7 7XX XXX XX XX, после оплаты пришлите чек в WhatsApp" />}
        </FormRow>
        <div>
          <Button type="submit" disabled={busy}>
            Сохранить
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Кнопка выгрузки оплат — в шапке экрана. */
export function ExportPaymentsButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      icon={Download}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await exportPayments();
        setBusy(false);
      }}
    >
      Оплаты в CSV
    </Button>
  );
}
