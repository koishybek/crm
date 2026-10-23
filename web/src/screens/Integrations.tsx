// Карточки интеграций в настройках: Telegram-бот, телефония (АТС), AI.
import { useAction, useQuery } from "convex/react";
import { Copy, ExternalLink, KeyRound, PhoneCall, Send, Sparkles } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { Badge, Button, Card, IconButton, Loading } from "../components/ui";
import { APP_NAME } from "../data/catalog";
import { run } from "../data/convex";
import { revealPbxSecret } from "../data/securityActions";
import { regeneratePbxSecret, report, toast } from "../data/store";

export const copy = (text: string) => {
  void navigator.clipboard?.writeText(text);
  toast("Скопировано", "info");
};

/** onCopy — своё копирование (например, значение сначала нужно получить с сервера). */
export function CopyRow({ label, value, shown, onCopy, children }: { label: string; value: string; shown?: string; onCopy?: () => void; children?: ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[12.5px] font-medium text-muted">{label}</div>
      <div className="flex items-center gap-1.5">
        <code className="min-w-0 flex-1 truncate rounded-[9px] bg-field px-3 py-2 font-mono text-[12.5px] text-ink-2">{shown ?? value}</code>
        <IconButton icon={Copy} label={`Скопировать: ${label}`} onClick={() => (onCopy ? onCopy() : copy(value))} className="h-9 w-9" />
        {children}
      </div>
    </div>
  );
}

export function TelegramCard() {
  const tg = useQuery(api.telegram.status);
  const setupWebhook = useAction(api.telegram.setupWebhook);
  const link = tg?.bot ? `https://t.me/${tg.bot}` : null;
  return (
    <Card icon={Send} title="Telegram-бот">
      {tg === undefined ? (
        <Loading className="py-6" />
      ) : tg?.enabled && link ? (
        <div className="space-y-3 text-[14px] text-ink-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="green">Работает</Badge>
            <a href={link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-semibold text-brand-ink hover:underline">
              @{tg.bot} <ExternalLink size={14} aria-hidden />
            </a>
          </div>
          <p>
            <b className="text-ink">Команда.</b> Каждый подключает уведомления сам: меню профиля → «Подключить Telegram». Исполнители берут новые заказы и ведут их кнопками прямо в чате, в 9:00 всем приходит сводка.
          </p>
          <p>
            <b className="text-ink">Клиенты.</b> Пишут боту текстом или голосом и делятся номером — заявка сразу появляется у операторов с AI-разбором. Ссылку на бота можно поставить в объявления OLX, Instagram и на сайт.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={Copy} onClick={() => copy(link)}>
              Ссылка для клиентов
            </Button>
            <Button size="sm" variant="ghost" onClick={async () => void report(await run(setupWebhook({})), "Вебхук обновлён")}>
              Переподключить вебхук
            </Button>
          </div>
        </div>
      ) : (
        <ol className="list-decimal space-y-1.5 pl-5 text-[14px] text-ink-2">
          <li>
            В Telegram откройте <b>@BotFather</b> → <code>/newbot</code>, назовите бота (например, «{APP_NAME} — заказы»).
          </li>
          <li>Пришлите разработчику токен бота и его имя (@…). Токен — как пароль, в общий чат не выкладывайте.</li>
          <li>После подключения здесь появится кнопка, а у всех в меню профиля — «Подключить Telegram».</li>
        </ol>
      )}
    </Card>
  );
}

const EVENTS = `{"event": "ringing",  "callId": "abc-123", "direction": "in", "from": "+77011234567", "to": "+77273450000"}
{"event": "answered", "callId": "abc-123", "operator": "madina@homemax.kz"}
{"event": "ended",    "callId": "abc-123", "duration": 184, "recordingUrl": "https://pbx.example/rec/abc-123.mp3"}`;

export function TelephonyCard() {
  const s = useQuery(api.calls.pbxSettings);
  // Ключ целиком сервер отдаёт только по «Показать» / «Скопировать» (каждый показ — в журнале) или сразу после выпуска.
  const [secret, setSecret] = useState<string | null>(null);
  const [show, setShow] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const t = setTimeout(() => setConfirming(false), 5000);
    return () => clearTimeout(t);
  }, [confirming]);
  // Ключ сменили (здесь или в другой вкладке) — прежний из памяти больше не годится.
  const tail = s?.tail ?? null;
  useEffect(() => {
    setSecret((k) => (k && tail && k.endsWith(tail) ? k : null));
  }, [tail]);

  const regenerate = async () => {
    setBusy(true);
    const r = await regeneratePbxSecret();
    setBusy(false);
    setConfirming(false);
    if (report(r, "Новый ключ создан")) {
      setSecret(r.value);
      setShow(true);
    }
  };
  /** Ключ целиком: уже открытый — из памяти, иначе с сервера. */
  const fullSecret = async (): Promise<string | null> => {
    if (secret) return secret;
    setBusy(true);
    const r = await revealPbxSecret();
    setBusy(false);
    if (!report(r)) return null;
    setSecret(r.value);
    return r.value;
  };
  const toggleShow = async () => {
    if (show) return setShow(false);
    if (await fullSecret()) setShow(true);
  };
  const copyWith = async (make: (key: string) => string) => {
    const key = await fullSecret();
    if (key) copy(make(key));
  };

  return (
    <Card icon={PhoneCall} title="Телефония (АТС)">
      <p className="text-[13.5px] text-muted">
        Облачная АТС (Binotel, Mango Office, Zadarma, OnlinePBX, Asterisk) присылает события звонков: система находит клиента по номеру, показывает оператору карточку звонящего, а запись разговора разбирает AI и
        создаёт заявку.
      </p>
      {s === undefined ? (
        <Loading className="py-6" />
      ) : !s.url ? (
        <p className="mt-3 text-[14px] text-bad-ink">Адрес сервера не определён — проверьте настройки деплоя.</p>
      ) : !s.configured ? (
        <Button className="mt-3" icon={KeyRound} disabled={busy} onClick={() => void regenerate()}>
          Создать ключ подключения
        </Button>
      ) : (
        <div className="mt-3 space-y-3">
          <CopyRow label="Адрес для событий (webhook)" value={s.url} />
          {/* Телефон оператора на Android (Tasker) после звонка шлёт сюда сам аудиофайл, ключ — тот же. */}
          <CopyRow label="Адрес для записей файлом (телефон на Android)" value={s.url.replace(/\/pbx\/events$/, "/pbx/recording")} />
          <CopyRow
            label="Ключ — заголовок X-PBX-Secret"
            value={secret ?? ""}
            shown={show && secret ? secret : `${"•".repeat(16)}${s.tail ?? ""}`}
            onCopy={() => void copyWith((key) => key)}
          >
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void toggleShow()}>
              {show ? "Скрыть" : "Показать"}
            </Button>
          </CopyRow>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" icon={Copy} disabled={busy} onClick={() => void copyWith((key) => `${s.url}?secret=${key}`)}>
              Адрес с ключом
            </Button>
            <Button size="sm" variant={confirming ? "danger" : "ghost"} icon={KeyRound} disabled={busy} onClick={() => (confirming ? void regenerate() : setConfirming(true))}>
              {confirming ? "Старый ключ перестанет работать — сменить?" : "Сменить ключ"}
            </Button>
          </div>
          <p className="text-[12.5px] text-muted">
            Надёжнее передавать ключ заголовком X-PBX-Secret. «Адрес с ключом» — только для АТС, которые не умеют добавлять заголовки: ключ в адресе может осесть в журналах АТС и прокси. Каждый показ ключа
            записывается в журнал.
          </p>
          <details className="group rounded-[12px] border border-line">
            <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">Формат событий — для настройки АТС</summary>
            <div className="border-t border-line px-3.5 py-3 text-[13px] text-ink-2">
              <p>
                <code>POST</code> на адрес выше, JSON или form-data. Один и тот же <code>callId</code> связывает события звонка:
              </p>
              <pre className="scroll-thin mt-2 overflow-x-auto rounded-[9px] bg-side p-3 font-mono text-[11.5px] leading-relaxed text-[#e9e6dd]">{EVENTS}</pre>
              <p className="mt-2">
                Понимаем и другие названия полей: <code>caller</code>, <code>callee</code>, <code>call_id</code>, <code>billsec</code>, <code>record_url</code>… В <code>operator</code> — логин сотрудника
                (email или телефон). Запись по ссылке система скачает сама.
              </p>
            </div>
          </details>
        </div>
      )}
    </Card>
  );
}

export function AiStatusCard() {
  const s = useQuery(api.ai.status);
  return (
    <Card icon={Sparkles} title="AI-помощник">
      {s === undefined ? (
        <Loading className="py-6" />
      ) : !s ? null : (
        <>
          <Badge tone={s.enabled ? "green" : "gray"}>{s.enabled ? "Работает" : "Не подключён"}</Badge>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13.5px]">
            <dt className="text-muted">Разбор обращений</dt>
            <dd className="font-medium text-ink">{s.llm ?? "—"}</dd>
            {s.fallback && (
              <>
                <dt className="text-muted">Если недоступен</dt>
                <dd className="text-ink-2">{s.fallback}</dd>
              </>
            )}
            <dt className="text-muted">Расшифровка</dt>
            <dd className="font-medium text-ink">{s.stt ?? "—"}</dd>
          </dl>
          <ul className="mt-3 space-y-1.5 text-[14px] text-ink-2">
            {[
              "Расшифровывает записи звонков и голосовые из Telegram и WhatsApp",
              "Раскладывает обращение по полям заявки: услуга, город, адрес, срочность, бюджет",
              "Подсказывает оператору, что уточнить у клиента",
              "Если услуга понятна — сам создаёт заявку из звонка",
            ].map((t) => (
              <li key={t} className="flex items-start gap-2">
                <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-violet" />
                {t}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12.5px] text-muted">AI только предлагает: цены, статусы заказов и деньги он не меняет. Провайдера можно сменить без доработок.</p>
        </>
      )}
    </Card>
  );
}
