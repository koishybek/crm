// Настройки адаптеров интеграций (ТЗ п.19.1, п.19.7, п.19.8, п.19.9): провайдер АТС и внутренние номера сотрудников,
// онлайн-оплата (Freedom Pay, CloudPayments, ссылка Kaspi), реквизиты для документов и выгрузки для 1С.
// Ключи провайдеров хранятся зашифрованными и обратно не показываются; без подключения — «Не подключено» и шаги настройки.
import { useQuery } from "convex/react";
import { Check, CreditCard, ExternalLink, FileText, Link2, PhoneOutgoing, Plus, PlugZap, Save, Trash2, Unplug } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { ExportButton } from "../components/ExportButton";
import { Badge, Button, Card, FormRow, Input, Loading, Segmented, Select } from "../components/ui";
import { checkPbx, disablePay, disablePbx, saveKaspiTemplate, savePay, savePbx, saveRequisites, setPbxExtension, setPbxLines } from "../data/adapterActions";
import { SOURCE_IDS, SOURCES } from "../data/catalog";
import { REQUISITE_FIELDS, requisitesIssues, type CompanyRequisites } from "../data/documents";
import { ONLINE_PROVIDERS, PAY_INFO, payWebhookPath, type OnlineProvider } from "../data/payIntents";
import { PBX_INFO, PBX_PROVIDERS, pbxWebhookPath, type PbxProvider } from "../data/pbx";
import { revealPbxSecret } from "../data/securityActions";
import { report, toast } from "../data/store";
import { copy, CopyRow } from "./Integrations";
import { ModuleGate } from "../components/ModuleGate";

/** Карточки адаптеров — одной строкой в «Настройках». */
export function AdapterCards() {
  return (
    <>
      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ModuleGate module="telephony" card><PbxProviderCard /></ModuleGate>
        <ModuleGate module="online_payments" card><PaymentsCard /></ModuleGate>
      </div>
      <div className="mt-4">
        <ModuleGate module="documents" card><DocumentsCard /></ModuleGate>
      </div>
    </>
  );
}

function Steps({ steps, docs }: { steps: string[]; docs: string }) {
  return (
    <details className="rounded-[12px] border border-line">
      <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">Как подключить</summary>
      <div className="border-t border-line px-3.5 py-3 text-[13px] text-ink-2">
        <ol className="list-decimal space-y-1.5 pl-4">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <a href={docs} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1 text-brand-ink hover:underline">
          Документация провайдера <ExternalLink size={13} aria-hidden />
        </a>
      </div>
    </details>
  );
}

function Status({ on, children }: { on: boolean; children?: ReactNode }) {
  return (
    <Badge tone={on ? "green" : "gray"} size="sm">
      {children ?? (on ? "Подключено" : "Не подключено")}
    </Badge>
  );
}

interface FieldDef {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  hint?: string;
  options?: { value: string; label: string }[];
}

/** Поля подключения: секретные пустые — «оставить сохранённое». */
function Fields({ defs, values, onChange, saved }: { defs: FieldDef[]; values: Record<string, string>; onChange: (k: string, v: string) => void; saved: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {defs.map((f) => (
        <FormRow key={f.key} label={f.label} required={!f.optional && !(f.secret && saved)} hint={f.hint}>
          {(id) =>
            f.options ? (
              <Select id={id} value={values[f.key] ?? f.options[0]!.value} onChange={(e) => onChange(f.key, e.target.value)}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id={id}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                value={values[f.key] ?? ""}
                placeholder={f.secret && saved ? "сохранено — оставьте пустым, чтобы не менять" : f.placeholder}
                onChange={(e) => onChange(f.key, e.target.value)}
              />
            )
          }
        </FormRow>
      ))}
    </div>
  );
}

// ── Телефония ────────────────────────────────────────────────────────────────

function PbxProviderCard() {
  const s = useQuery(api.pbx.settings);
  const [provider, setProvider] = useState<PbxProvider>(PBX_PROVIDERS[0]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!s) return;
    if (s.provider) setProvider(s.provider);
    setValues({ ...s.config });
  }, [s]);
  if (s === undefined) return <Card icon={PhoneOutgoing} title="Провайдер АТС"><Loading className="py-6" /></Card>;
  const connected = !!s.provider && s.hasSecrets;
  const same = s.provider === provider && s.hasSecrets;
  const info = PBX_INFO[provider];

  const save = async () => {
    setBusy(true);
    const r = await savePbx(provider, values);
    setBusy(false);
    if (report(r, `${info.label}: ключи сохранены`)) setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !info.fields.find((f) => f.key === k)?.secret)));
  };
  const check = async () => {
    setBusy(true);
    const r = await checkPbx();
    setBusy(false);
    if (report(r)) toast(r.value, "ok");
  };
  const copyWebhook = async () => {
    if (!s.siteUrl) return toast("Адрес сервера не определён — проверьте настройки деплоя", "bad");
    const r = await revealPbxSecret();
    if (report(r)) copy(`${s.siteUrl}${pbxWebhookPath(provider)}?key=${r.value}`);
  };

  return (
    <Card icon={PhoneOutgoing} title="Провайдер АТС" titleExtra={<Status on={connected}>{connected ? `${PBX_INFO[s.provider!].label} подключён` : undefined}</Status>}>
      <p className="text-[13.5px] text-muted">Binotel, Zadarma или OnlinePBX: события звонков с проверкой подписи, записи разговоров по API провайдера и «Позвонить через АТС» из карточек.</p>
      <div className="mt-3">
        <Segmented options={PBX_PROVIDERS.map((p) => ({ value: p, label: PBX_INFO[p].label }))} value={provider} onChange={(p) => (setProvider(p), setValues(p === s.provider ? { ...s.config } : {}))} />
      </div>
      {s.keyIssue && <p className="mt-3 text-[13px] text-bad-ink">{s.keyIssue}</p>}
      <div className="mt-3">
        <Fields defs={info.fields} values={values} onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))} saved={same} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={Save} disabled={busy} onClick={() => void save()}>
          {same ? "Сохранить" : "Подключить"}
        </Button>
        {connected && s.provider === provider && (
          <>
            <Button size="sm" variant="secondary" icon={PlugZap} disabled={busy} onClick={() => void check()}>
              Проверить подключение
            </Button>
            <Button size="sm" variant="secondary" icon={Link2} disabled={busy} onClick={() => void copyWebhook()}>
              Скопировать адрес для АТС
            </Button>
            <Button size="sm" variant="danger" icon={Unplug} disabled={busy} onClick={async () => report(await disablePbx(), "Провайдер АТС отключён")}>
              Отключить
            </Button>
          </>
        )}
      </div>
      {connected && s.provider === provider && (
        <p className="mt-2 text-[12.5px] text-muted">Адрес для АТС содержит ключ АТС (каждое копирование — в журнале): вставьте его в настройки вебхуков {info.label}. Общий ключ и адрес /pbx/events — в карточке «Телефония (АТС)».</p>
      )}
      <div className="mt-3">
        <Steps steps={info.steps} docs={info.docs} />
      </div>
      <Extensions staff={s.staff} />
      <Lines saved={s.lines} />
    </Card>
  );
}

function Extensions({ staff }: { staff: { id: string; name: string; role: string; extension: string | null }[] }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  if (!staff.length) return null;
  const save = async (id: string) => {
    const value = draft[id];
    if (value === undefined) return;
    if (report(await setPbxExtension(id, value), value.trim() ? "Внутренний номер сохранён" : "Внутренний номер снят")) setDraft(({ [id]: _, ...rest }) => rest);
  };
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[13.5px] font-semibold text-ink">Внутренние номера сотрудников</div>
      <p className="mb-2 text-[12.5px] text-muted">По номеру АТС звонит сотруднику при «Позвонить через АТС» и узнаёт, кто принял входящий.</p>
      <ul className="divide-y divide-line rounded-[12px] border border-line">
        {staff.map((u) => (
          <li key={u.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink">{u.name}</div>
              <div className="text-[12px] text-muted">{u.role}</div>
            </div>
            <Input
              aria-label={`Внутренний номер: ${u.name}`}
              inputMode="numeric"
              className="w-24"
              placeholder="—"
              value={draft[u.id] ?? u.extension ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [u.id]: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && void save(u.id)}
            />
            <Button size="sm" variant="ghost" icon={Check} disabled={draft[u.id] === undefined} onClick={() => void save(u.id)} aria-label={`Сохранить номер: ${u.name}`}>
              <span className="sr-only">Сохранить</span>
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Источник по номеру линии: номер АТС в объявлениях OLX → заявки из звонков на него — «OLX», а не «Телефон». */
function Lines({ saved }: { saved: { number: string; source: string }[] }) {
  const [rows, setRows] = useState(saved);
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(saved), [saved]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const patch = (i: number, p: Partial<{ number: string; source: string }>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const save = async () => {
    setBusy(true);
    report(await setPbxLines(rows.filter((r) => r.number.trim())), "Источники по номерам сохранены");
    setBusy(false);
  };
  return (
    <div className="mt-4">
      <div className="mb-1.5 text-[13.5px] font-semibold text-ink">Источник по номеру</div>
      <p className="mb-2 text-[12.5px] text-muted">Номер АТС, указанный в объявлениях OLX (или другой рекламе): заявки из звонков на него получат этот источник — в аналитике видно, сколько звонков и заказов принёс OLX. Остальные звонки — «Телефон».</p>
      <div className="flex flex-col gap-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input aria-label="Номер линии" inputMode="tel" placeholder="+7 727 …" value={r.number} onChange={(e) => patch(i, { number: e.target.value })} className="min-w-0 flex-1" />
            <Select aria-label="Источник" value={r.source} onChange={(e) => patch(i, { source: e.target.value })} className="w-36 shrink-0">
              {SOURCE_IDS.map((id) => (
                <option key={id} value={id}>
                  {SOURCES[id].label}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" icon={Trash2} aria-label="Убрать номер" onClick={() => setRows((x) => x.filter((_, j) => j !== i))} />
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => setRows((x) => [...x, { number: "", source: "olx" }])}>
          Добавить номер
        </Button>
        {dirty && (
          <Button size="sm" icon={Save} disabled={busy} onClick={() => void save()}>
            Сохранить
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Онлайн-оплата ────────────────────────────────────────────────────────────

function PaymentsCard() {
  const s = useQuery(api.payments.settings);
  const [provider, setProvider] = useState<OnlineProvider>("freedompay");
  const [values, setValues] = useState<Record<string, string>>({});
  const [kaspi, setKaspi] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!s) return;
    if (s.provider) setProvider(s.provider);
    setValues({ ...s.config });
    setKaspi(s.kaspiTemplate ?? "");
  }, [s]);
  if (s === undefined) return <Card icon={CreditCard} title="Онлайн-оплата"><Loading className="py-6" /></Card>;
  const connected = !!s.provider && s.hasSecrets;
  const same = s.provider === provider && s.hasSecrets;
  const info = PAY_INFO[provider];

  const save = async () => {
    setBusy(true);
    const r = await savePay(provider, values);
    setBusy(false);
    if (report(r, `${info.label}: ключи сохранены`)) setValues((v) => Object.fromEntries(Object.entries(v).filter(([k]) => !info.fields.find((f) => f.key === k)?.secret)));
  };

  return (
    <Card icon={CreditCard} title="Онлайн-оплата" titleExtra={<Status on={connected || !!s.kaspiTemplate}>{connected ? `${PAY_INFO[s.provider!].label} подключён` : s.kaspiTemplate ? "Только Kaspi" : undefined}</Status>}>
      <p className="text-[13.5px] text-muted">«Выставить счёт на оплату» в заказе: ссылка уходит клиенту, оплата засчитывается сама по уведомлению провайдера (подпись проверяется) — от имени «Система».</p>
      <div className="mt-3">
        <Segmented options={ONLINE_PROVIDERS.map((p) => ({ value: p, label: PAY_INFO[p].label }))} value={provider} onChange={(p) => (setProvider(p), setValues(p === s.provider ? { ...s.config } : {}))} />
      </div>
      {s.keyIssue && <p className="mt-3 text-[13px] text-bad-ink">{s.keyIssue}</p>}
      <div className="mt-3">
        <Fields defs={info.fields} values={values} onChange={(k, v) => setValues((x) => ({ ...x, [k]: v }))} saved={same} />
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon={Save} disabled={busy} onClick={() => void save()}>
          {same ? "Сохранить" : "Подключить"}
        </Button>
        {connected && s.provider === provider && (
          <Button size="sm" variant="danger" icon={Unplug} disabled={busy} onClick={async () => report(await disablePay(), "Онлайн-оплата отключена")}>
            Отключить
          </Button>
        )}
      </div>
      {s.siteUrl && <div className="mt-3"><CopyRow label="Адрес для уведомлений об оплате" value={`${s.siteUrl}${payWebhookPath(provider)}${s.company ? `?c=${encodeURIComponent(s.company)}` : ""}`} /></div>}
      <div className="mt-3">
        <Steps steps={info.steps} docs={info.docs} />
      </div>

      <div className="mt-4 rounded-[12px] border border-line p-3">
        <div className="text-[14px] font-semibold text-ink">{PAY_INFO.kaspi.label}</div>
        <p className="mt-0.5 text-[12.5px] text-muted">{PAY_INFO.kaspi.steps.join(" ")}</p>
        <div className="mt-2 flex gap-2">
          <Input aria-label="Ссылка на оплату Kaspi" className="min-w-0 flex-1" placeholder={PAY_INFO.kaspi.fields[0]!.placeholder} value={kaspi} onChange={(e) => setKaspi(e.target.value)} />
          <Button size="sm" variant="secondary" icon={Save} onClick={async () => report(await saveKaspiTemplate(kaspi), kaspi.trim() ? "Ссылка Kaspi сохранена" : "Ссылка Kaspi убрана")}>
            Сохранить
          </Button>
        </div>
      </div>
    </Card>
  );
}

// ── Документы и 1С ───────────────────────────────────────────────────────────

const EMPTY: CompanyRequisites = { name: "", bin: "", address: "", bank: "", iik: "", bik: "", kbe: "", director: "" };

function DocumentsCard() {
  const data = useQuery(api.documents.getRequisites);
  const [r, setR] = useState<CompanyRequisites>(EMPTY);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data?.requisites) setR(data.requisites);
  }, [data]);
  if (data === undefined) return <Card icon={FileText} title="Документы и 1С"><Loading className="py-6" /></Card>;
  const set = (k: keyof CompanyRequisites, v: string | number | undefined) => setR((x) => ({ ...x, [k]: v }));
  const issues = requisitesIssues(r);
  const save = async () => {
    if (issues.length) return toast(issues[0]!, "bad");
    setBusy(true);
    report(await saveRequisites(r), "Реквизиты сохранены");
    setBusy(false);
  };
  const startOf = (raw: string) => {
    const n = Number(raw);
    return raw.trim() && Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
  };

  return (
    <Card
      icon={FileText}
      title="Документы и 1С"
      titleExtra={<Status on={!data.issues.length}>{data.issues.length ? "Реквизиты не заполнены" : "Реквизиты заполнены"}</Status>}
      action={<ExportButton kinds={["accounting", "commerceml"]} label="Выгрузка для 1С" height={44} />}
    >
      <p className="text-[13.5px] text-muted">
        Реквизиты для «Счёта на оплату» и «Акта выполненных работ» в карточке заказа. Выпущенный документ хранит снимок: изменение реквизитов на него не влияет. Выгрузка для 1С — реестр оплат, возвратов и
        выплат (CSV) и выполненные заказы в CommerceML 2 (XML).
      </p>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {REQUISITE_FIELDS.map((f) => (
          <FormRow key={f.key} label={f.label} required={f.key !== "phone" && f.key !== "vatNote"}>
            {(id) => <Input id={id} value={String(r[f.key] ?? "")} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />}
          </FormRow>
        ))}
        <FormRow label="Префикс номера счёта" hint="Например, «СЧ-»">
          {(id) => <Input id={id} value={r.invoicePrefix ?? ""} onChange={(e) => set("invoicePrefix", e.target.value)} />}
        </FormRow>
        <FormRow label="Префикс номера акта" hint="Например, «АВР-»">
          {(id) => <Input id={id} value={r.actPrefix ?? ""} onChange={(e) => set("actPrefix", e.target.value)} />}
        </FormRow>
        <FormRow label="Начать нумерацию счетов с" hint="Номера только растут">
          {(id) => <Input id={id} inputMode="numeric" value={r.invoiceStart ?? ""} onChange={(e) => set("invoiceStart", startOf(e.target.value))} />}
        </FormRow>
        <FormRow label="Начать нумерацию актов с" hint="Номера только растут">
          {(id) => <Input id={id} inputMode="numeric" value={r.actStart ?? ""} onChange={(e) => set("actStart", startOf(e.target.value))} />}
        </FormRow>
      </div>
      {issues.length > 0 && <p className="mt-2 text-[12.5px] text-warn-ink">{issues.join(" · ")}</p>}
      <Button className="mt-3" size="sm" icon={Save} disabled={busy} onClick={() => void save()}>
        Сохранить реквизиты
      </Button>
    </Card>
  );
}
