import { Ban, Copy, FileSpreadsheet, KeyRound, Plus, ShieldCheck, Upload, UserPlus, Users } from "lucide-react";
import { useRef, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import { api } from "../../convex/_generated/api";
import { APP_NAME, CATEGORIES, ROLE_LABEL, categoryById } from "../data/catalog";
import { convex, run } from "../data/convex";
import { useMe, useTeam } from "../data/hooks";
import { createStaff, report, resetPassword, setUserActive, toast } from "../data/store";
import { Avatar, Badge, Button, Card, FormRow, Input, Loading, Menu, MenuItem, Modal, PageHeader, Segmented } from "../components/ui";
import { phone } from "../lib/format";
import type { User } from "../data/types";
import { AccessModal } from "../components/AccessModal";
import { CatalogEditor } from "./CatalogEditor";
import { ApiAndSiteCard, NotifyCards, OlxCard, WhatsAppCard } from "./ChannelCards";
import { AiStatusCard, TelegramCard, TelephonyCard } from "./Integrations";
import { SystemCards } from "./SystemCards";
import { MatchingCards } from "./MatchingCards";
import { AdapterCards } from "./AdapterCards";
import { CompanyCard } from "./CompanyCards";
import { ModuleGate } from "../components/ModuleGate";

type Creds = { title: string; rows: { name: string; login: string; password: string }[] };

/** Excel (.xlsx) или CSV → строки-массивы. Первая строка — заголовки. */
async function readTable(file: File): Promise<string[][]> {
  if (/\.csv$/i.test(file.name)) {
    const text = await file.text();
    const sep = (text.split("\n")[0] ?? "").includes(";") ? ";" : ",";
    return text
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => l.split(sep).map((c) => c.replace(/^"|"$/g, "").trim()));
  }
  const rows = await readSheet(file);
  return rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c).trim())));
}

/** Колонку ищем по началу заголовка — люди пишут «Телефон», «телефон клиента» и т.п. */
function col(header: string[], ...names: string[]) {
  const h = header.map((x) => x.toLowerCase());
  return h.findIndex((x) => names.some((n) => x.startsWith(n)));
}

const credsText = (c: Creds) =>
  `${APP_NAME} — вход: ${window.location.origin}\nПароль временный: при первом входе придумайте свой.\n\n` + c.rows.map((r) => `${r.name}\nЛогин: ${r.login}\nПароль: ${r.password}`).join("\n\n");

export default function Settings() {
  const me = useMe()!;
  const team = useTeam();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [role, setRole] = useState<"operator" | "manager" | "owner">("operator");
  const [cats, setCats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [creds, setCreds] = useState<Creds | null>(null);
  const [importing, setImporting] = useState<"clients" | "executors" | null>(null);
  const [accessOf, setAccessOf] = useState<User | null>(null);
  const clientsRef = useRef<HTMLInputElement>(null);
  const execRef = useRef<HTMLInputElement>(null);

  if (!team.loaded) return <Loading />;
  const staff = team.users.filter((u) => u.role !== "executor");

  const addStaff = async () => {
    setBusy(true);
    const r = await createStaff({ name, login, role, categories: role === "manager" ? cats : undefined });
    setBusy(false);
    if (!report(r)) return;
    setAdding(false);
    setName("");
    setLogin("");
    setCats([]);
    setCreds({ title: "Сотрудник добавлен", rows: [{ name, login: r.value.login, password: r.value.password }] });
  };

  const importClients = async (file: File) => {
    setImporting("clients");
    try {
      const [header = [], ...rows] = await readTable(file);
      const iName = col(header, "имя", "фио", "клиент", "назв");
      const iPhone = col(header, "тел", "номер");
      if (iName < 0 || iPhone < 0) return toast("Нужны колонки «Имя» и «Телефон» в первой строке", "bad");
      const iCity = col(header, "город");
      const iAddr = col(header, "адрес");
      const iSrc = col(header, "источ");
      const iMail = col(header, "email", "почта");
      const data = rows
        .filter((r) => r[iName] || r[iPhone])
        .map((r) => ({
          name: r[iName] ?? "",
          phone: r[iPhone] ?? "",
          city: iCity >= 0 ? r[iCity] || undefined : undefined,
          address: iAddr >= 0 ? r[iAddr] || undefined : undefined,
          source: iSrc >= 0 ? r[iSrc] || undefined : undefined,
          email: iMail >= 0 ? r[iMail] || undefined : undefined,
        }));
      const res = await run(convex.mutation(api.imports.clients, { rows: data }));
      if (report(res)) toast(`Клиентов добавлено: ${res.value.added}${res.value.skipped.length ? `, пропущено: ${res.value.skipped.length}` : ""}`, "info");
    } catch {
      toast("Не получилось прочитать файл — сохраните его как .xlsx или .csv", "bad");
    } finally {
      setImporting(null);
    }
  };

  const importExecutors = async (file: File) => {
    setImporting("executors");
    try {
      const [header = [], ...rows] = await readTable(file);
      const iName = col(header, "фио", "имя", "исполн");
      const iPhone = col(header, "тел", "номер");
      const iCity = col(header, "город");
      const iCat = col(header, "специал", "направл", "категор");
      if (iName < 0 || iPhone < 0 || iCat < 0) return toast("Нужны колонки «ФИО», «Телефон», «Город», «Специализации»", "bad");
      const iSkills = col(header, "навык");
      const data = rows
        .filter((r) => r[iName])
        .map((r) => ({ name: r[iName] ?? "", phone: r[iPhone] ?? "", city: iCity >= 0 ? (r[iCity] ?? "") : "", categories: r[iCat] ?? "", skills: iSkills >= 0 ? r[iSkills] || undefined : undefined }));
      const res = await run(convex.action(api.imports.executors, { rows: data }));
      if (!report(res)) return;
      if (res.value.skipped.length) toast(`Пропущено: ${res.value.skipped.slice(0, 3).join("; ")}${res.value.skipped.length > 3 ? "…" : ""}`, "info");
      if (res.value.created.length) setCreds({ title: `Исполнителей добавлено: ${res.value.created.length}`, rows: res.value.created });
    } catch {
      toast("Не получилось прочитать файл — сохраните его как .xlsx или .csv", "bad");
    } finally {
      setImporting(null);
    }
  };

  return (
    <>
      <PageHeader title="Настройки" subtitle="Команда, доступы, импорт данных и уведомления" />
      <div className="mb-4"><CompanyCard /></div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_1fr]">
        <Card
          icon={Users}
          title="Команда"
          action={
            <Button size="sm" icon={UserPlus} onClick={() => setAdding(true)}>
              Добавить
            </Button>
          }
          bodyClass="px-3 pb-3 sm:px-4"
        >
          <p className="px-1 pb-3 text-[13.5px] text-muted">Владельцы видят всё, включая деньги и аналитику. Операторы — заявки, заказы, клиентов, звонки и сообщения, цену и оплаты (без выплат мастерам и маржи). Руководитель направления — только заказы и исполнителей своих направлений, без денег. Права каждого можно изменить: «Доступ» → «Роль и права». Исполнителей добавляют в разделе «Исполнители».</p>
          <ul className="divide-y divide-line">
            {staff.map((u) => (
              <li key={u.id} className="flex items-center gap-3 px-1 py-3">
                <Avatar name={u.name} size={40} variant="person" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[15px] font-semibold text-ink">{u.name}</span>
                    <Badge tone={u.role === "owner" ? "violet" : u.role === "manager" ? "orange" : "blue"} size="sm">
                      {ROLE_LABEL[u.role]}
                    </Badge>
                    {u.active === false && (
                      <Badge tone="gray" size="sm">
                        отключён
                      </Badge>
                    )}
                    {u.telegram && (
                      <Badge tone="sky" size="sm">
                        Telegram
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[13px] text-muted">
                    {u.email.includes("@") ? u.email : phone(u.email)}
                    {u.role === "manager" && u.categories?.length ? ` · ${u.categories.map((c) => categoryById(c).label).join(", ")}` : ""}
                  </div>
                </div>
                {u.id !== me.id && (
                  <Menu
                    width={240}
                    trigger={(toggle) => (
                      <Button size="sm" variant="secondary" icon={KeyRound} onClick={toggle}>
                        Доступ
                      </Button>
                    )}
                  >
                    {(close) => (
                      <>
                        <MenuItem icon={ShieldCheck} hint="Роль, направления, деньги, клиенты, выгрузки" onClick={() => (close(), setAccessOf(u))}>
                          Роль и права
                        </MenuItem>
                        <MenuItem
                          icon={KeyRound}
                          hint="Старые входы закроются"
                          onClick={async () => {
                            close();
                            const r = await resetPassword(u.id);
                            if (report(r)) setCreds({ title: "Новый пароль", rows: [{ name: u.name, ...r.value }] });
                          }}
                        >
                          Выдать новый пароль
                        </MenuItem>
                        <MenuItem
                          icon={Ban}
                          danger={u.active !== false}
                          onClick={async () => {
                            close();
                            report(await setUserActive(u.id, u.active === false), u.active === false ? "Доступ включён" : "Доступ отключён");
                          }}
                        >
                          {u.active === false ? "Включить доступ" : "Отключить доступ"}
                        </MenuItem>
                      </>
                    )}
                  </Menu>
                )}
              </li>
            ))}
          </ul>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card icon={FileSpreadsheet} title="Импорт из Excel">
            <p className="text-[13.5px] text-muted">Файл .xlsx или .csv, первая строка — заголовки. Дубли по телефону пропускаются.</p>
            <div className="mt-3 space-y-3">
              <div className="rounded-[12px] border border-line p-3">
                <div className="text-[14px] font-semibold text-ink">Клиенты</div>
                <div className="mt-0.5 text-[12.5px] text-muted">Колонки: Имя, Телефон, Город, Адрес, Источник, Email</div>
                <input ref={clientsRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => (e.target.files?.[0] && void importClients(e.target.files[0]), (e.target.value = ""))} />
                <Button size="sm" variant="secondary" icon={Upload} className="mt-2" disabled={!!importing} onClick={() => clientsRef.current?.click()}>
                  {importing === "clients" ? "Загружаем…" : "Загрузить клиентов"}
                </Button>
              </div>
              <div className="rounded-[12px] border border-line p-3">
                <div className="text-[14px] font-semibold text-ink">Исполнители</div>
                <div className="mt-0.5 text-[12.5px] text-muted">Колонки: ФИО, Телефон, Город, Специализации (через запятую: «Кондиционеры, Бытовая техника»), Навыки</div>
                <input ref={execRef} type="file" accept=".xlsx,.csv" className="hidden" onChange={(e) => (e.target.files?.[0] && void importExecutors(e.target.files[0]), (e.target.value = ""))} />
                <Button size="sm" variant="secondary" icon={Upload} className="mt-2" disabled={!!importing} onClick={() => execRef.current?.click()}>
                  {importing === "executors" ? "Создаём аккаунты…" : "Загрузить исполнителей"}
                </Button>
                <div className="mt-1.5 text-[12px] text-muted">Каждому создаётся логин (его телефон) и пароль — список покажем после загрузки.</div>
              </div>
            </div>
          </Card>

          <TelegramCard />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_1fr]">
        <ModuleGate module="telephony" card><TelephonyCard /></ModuleGate>
        <ModuleGate module="ai" card><AiStatusCard /></ModuleGate>
      </div>
      <AdapterCards />

      <div className="mt-4">
        <ModuleGate module="whatsapp" card><WhatsAppCard /></ModuleGate>
      </div>

      <div className="mt-4">
        <ModuleGate module="olx" card><OlxCard /></ModuleGate>
      </div>
      <NotifyCards />

      <div className="mt-4">
        <ApiAndSiteCard />
      </div>

      <SystemCards />
      <MatchingCards />

      <div className="mt-4">
        <CatalogEditor />
      </div>

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Новый сотрудник"
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAdding(false)}>
              Отмена
            </Button>
            <Button icon={Plus} disabled={busy} onClick={() => void addStaff()}>
              {busy ? "Создаём…" : "Добавить"}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <FormRow label="Имя и фамилия" required>
            {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Мадина Ергалиева" />}
          </FormRow>
          <FormRow label="Логин" required hint="Рабочий email или телефон — им сотрудник будет входить">
            {(id) => <Input id={id} value={login} onChange={(e) => setLogin(e.target.value)} placeholder="madina@homemax.kz" />}
          </FormRow>
          <div>
            <div className="mb-2 text-[14px] font-semibold text-ink">Роль</div>
            <Segmented
              options={[
                { value: "operator", label: "Оператор" },
                { value: "manager", label: "Руководитель" },
                { value: "owner", label: "Владелец" },
              ]}
              value={role}
              onChange={setRole}
            />
          </div>
          {role === "manager" && (
            <div>
              <div className="mb-2 text-[14px] font-semibold text-ink">Направления</div>
              <div className="flex flex-wrap gap-2">
                {CATEGORIES.filter((c) => c.active !== false).map((c) => {
                  const on = cats.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setCats((xs) => (on ? xs.filter((x) => x !== c.id) : [...xs, c.id]))}
                      className={on ? "rounded-[10px] border border-brand bg-brand-soft px-3 py-2 text-[13.5px] font-medium text-brand-ink" : "rounded-[10px] border border-line-strong px-3 py-2 text-[13.5px] font-medium text-ink-2 hover:border-brand-line"}
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

      <AccessModal user={accessOf} onClose={() => setAccessOf(null)} />

      <Modal open={!!creds} onClose={() => setCreds(null)} title={creds?.title ?? ""} width={520}>
        {creds && (
          <div>
            <p className="text-[14px] text-muted">Пароли показываются один раз — скопируйте и передайте людям лично. Пароль временный: при первом входе система попросит придумать свой.</p>
            <div className="scroll-thin mt-3 max-h-[320px] space-y-2 overflow-y-auto">
              {creds.rows.map((r) => (
                <div key={r.login} className="rounded-[12px] border border-line px-3.5 py-2.5 text-[14px]">
                  <div className="font-semibold text-ink">{r.name}</div>
                  <div className="mt-0.5 flex flex-wrap justify-between gap-x-4 text-ink-2">
                    <span>
                      Логин: <b>{r.login.includes("@") ? r.login : phone(r.login)}</b>
                    </span>
                    <span>
                      Пароль: <b className="font-mono tracking-wide">{r.password}</b>
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <Button
              variant="secondary"
              size="sm"
              icon={Copy}
              className="mt-4"
              onClick={() => {
                void navigator.clipboard?.writeText(credsText(creds));
                toast("Скопировано", "info");
              }}
            >
              Скопировать всё
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}
