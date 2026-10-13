// «API и сайт» в настройках владельца (ТЗ п.6 «Сайт», п.26 «API-first»): форма заявки для сайта (ссылка и iframe),
// сайты компании, которым можно слать заявки напрямую, и ключи публичного API с примерами запросов.
// «WhatsApp» — официальный WhatsApp Cloud API: что настроено, доходят ли вебхуки, как подключить.
import { useQuery } from "convex/react";
import { Ban, Code2, Copy, ExternalLink, Globe, KeyRound, MessageCircle, Plus, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { Badge, Button, Card, FormRow, Input, Loading, Modal, Textarea } from "../components/ui";
import { useNow } from "../data/hooks";
import { createApiKey, revokeApiKey, saveSiteOrigins, siteUrl } from "../data/publicApi";
import { report } from "../data/store";
import type { ApiKeyInfo, WhatsAppSettings } from "../data/types";
import { dateTime, phone } from "../lib/format";
import { copy, CopyRow } from "./Integrations";

/** Встраивание формы: iframe + скрипт, который передаёт рекламные метки страницы и подгоняет высоту. */
const embedCode = (formUrl: string, origin: string) => `<iframe id="hms-form" src="${formUrl}?embed=1" title="Заявка" loading="lazy"
  style="width:100%;max-width:560px;height:780px;border:0"></iframe>
<script>
(function () {
  var f = document.getElementById("hms-form");
  if (location.search.length > 1) f.src += "&" + location.search.slice(1);
  window.addEventListener("message", function (e) {
    if (e.origin === "${origin}" && e.data && e.data.type === "hms:height") f.style.height = e.data.height + "px";
  });
})();
</script>`;

const curlCreate = (base: string) => `curl -X POST ${base}/api/v1/leads \\
  -H "Authorization: Bearer hms_ВАШ_КЛЮЧ" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Айгерим","phone":"+77011234567","serviceId":"ac-clean","city":"Алматы","description":"Почистить два кондиционера","externalId":"site-1024"}'

# 201 → {"number":1024,"id":"…"}   повтор с тем же externalId → 200 и тот же номер`;

const curlGet = (base: string) => `curl ${base}/api/v1/leads/1024 -H "Authorization: Bearer hms_ВАШ_КЛЮЧ"

# 200 → {"number":1024,"status":"converted","statusLabel":"Заказ создан","createdAt":"…",
#        "orderNumber":1024,"orderStatus":"in_progress","orderStatusLabel":"В работе"}`;

function CodeBlock({ code, label }: { code: string; label: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-[12.5px] font-medium text-muted">{label}</span>
        <Button size="sm" variant="ghost" icon={Copy} onClick={() => copy(code)} aria-label={`Скопировать: ${label}`}>
          Скопировать
        </Button>
      </div>
      <pre className="scroll-thin overflow-x-auto rounded-[10px] bg-side p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre text-[#e9e6dd]">{code}</pre>
    </div>
  );
}

export function ApiAndSiteCard() {
  const site = useQuery(api.site.settings);
  const keys = useQuery(api.apiKeys.list);
  const origin = window.location.origin;
  const formUrl = `${origin}/zayavka`;
  const base = keys?.baseUrl ?? siteUrl() ?? "https://<адрес>.convex.site";

  return (
    <Card icon={Code2} title="API и сайт">
      <p className="text-[13.5px] text-muted">
        Заявки с сайта, из рекламы и от партнёров сразу появляются в «Заявках» и в «Сообщениях». Защита от спама включена: ловушка для ботов, проверка казахстанского номера, не больше 3 заявок с одного номера в час.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section className="min-w-0 space-y-3">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
            <Globe size={17} className="text-brand-ink" aria-hidden /> Форма заявки для сайта
          </h3>
          <CopyRow label="Ссылка на форму — для рекламы, Instagram, 2ГИС" value={formUrl}>
            <a href={formUrl} target="_blank" rel="noopener noreferrer" aria-label="Открыть форму" className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] text-muted hover:bg-[#f4f2ec] hover:text-ink">
              <ExternalLink size={18} aria-hidden />
            </a>
          </CopyRow>
          <p className="text-[12.5px] text-muted">
            Метки рекламы попадут в заявку: <code>?utm_source=instagram</code>. Сразу выбрать услугу: <code>?service=ac-clean</code>.
          </p>
          {site?.appUrl && site.appUrl !== origin && (
            <div className="flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                На сервере указан другой адрес приложения ({site.appUrl}). Форма с этого адреса заявку не отправит — обновите переменную APP_URL в Convex.
              </span>
            </div>
          )}
          {site && !site.appUrl && site.origins.length > 0 && (
            <div className="flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>На сервере не задан адрес приложения (APP_URL). Пока в списке есть сайты компании, форма по ссылке выше заявки не отправит — задайте APP_URL в Convex.</span>
            </div>
          )}
          <CodeBlock code={embedCode(formUrl, origin)} label="Встроить форму на сайт — вставьте в HTML страницы" />
          <SiteOrigins origins={site?.origins} endpoint={site?.endpoint ?? null} />
        </section>

        <section className="min-w-0 space-y-3">
          <ApiKeys keys={keys?.keys} />
          <details className="group rounded-[12px] border border-line">
            <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">Примеры запросов к API</summary>
            <div className="space-y-3 border-t border-line px-3.5 py-3 text-[13px] text-ink-2">
              <p>
                Ключ — в заголовке <code>Authorization: Bearer …</code>. Не больше 120 запросов в минуту на ключ. Ошибки — JSON <code>{'{"error": "…"}'}</code> с кодом 400, 401, 404 или 429. Повтор запроса с тем же{" "}
                <code>externalId</code> (или заголовком <code>Idempotency-Key</code>) не создаёт дубль.
              </p>
              <CodeBlock code={curlCreate(base)} label="Создать заявку" />
              <p>Статус заявки — только заявок, созданных этим ключом, и без персональных данных:</p>
              <CodeBlock code={curlGet(base)} label="Статус заявки" />
              <p className="text-[12.5px] text-muted">
                Поля: <code>name</code>, <code>phone</code> (казахстанский номер), <code>description</code> — обязательные; <code>serviceId</code>, <code>city</code>, <code>source</code> (olx, phone, whatsapp, telegram, site,
                instagram, referral; по умолчанию site), <code>externalId</code> — по желанию.
              </p>
            </div>
          </details>
        </section>
      </div>
    </Card>
  );
}

function SiteOrigins({ origins, endpoint }: { origins: string[] | undefined; endpoint: string | null }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (origins) setText(origins.join("\n"));
  }, [origins]);
  const dirty = !!origins && text.split("\n").map((x) => x.trim()).filter(Boolean).join("\n") !== origins.join("\n");
  const save = async () => {
    setBusy(true);
    const r = await saveSiteOrigins(text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean));
    setBusy(false);
    if (report(r, "Сайты сохранены")) setText(r.value.join("\n"));
  };
  return (
    <details className="group rounded-[12px] border border-line">
      <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">Своя форма на сайте компании</summary>
      <div className="space-y-3 border-t border-line px-3.5 py-3">
        <p className="text-[13px] text-ink-2">
          Если у сайта своя форма, она может отправлять заявки прямо сюда — JSON с полями <code>name</code>, <code>phone</code>, <code>description</code>, <code>consent: true</code> и <code>startedAt</code> (время открытия
          формы, мс). Укажите адрес сайта — с других сайтов браузер заявки не отправит. Встроенной форме (iframe) это не нужно.
        </p>
        {endpoint && <CopyRow label="Адрес для отправки (POST)" value={endpoint} />}
        {origins === undefined ? (
          <Loading className="py-4" />
        ) : (
          <FormRow label="Сайты компании" hint="По одному в строке, например homemax.kz">
            {(id) => <Textarea id={id} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={"homemax.kz\nwww.homemax.kz"} />}
          </FormRow>
        )}
        <div className="flex justify-end">
          <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      </div>
    </details>
  );
}

function ApiKeys({ keys }: { keys: ApiKeyInfo[] | undefined }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ key: string; name: string } | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 5000);
    return () => clearTimeout(t);
  }, [confirm]);

  const create = async () => {
    setBusy(true);
    const r = await createApiKey(name);
    setBusy(false);
    if (!report(r)) return;
    setCreated({ key: r.value.key, name: name.trim() });
    setName("");
  };
  const revoke = async (k: ApiKeyInfo) => {
    if (confirm !== k.id) return setConfirm(k.id);
    setConfirm(null);
    report(await revokeApiKey(k.id), `Ключ «${k.name}» отозван`);
  };
  const close = () => {
    setCreating(false);
    setCreated(null);
    setName("");
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <KeyRound size={17} className="text-brand-ink" aria-hidden /> Ключи API
        </h3>
        <Button size="sm" icon={Plus} onClick={() => setCreating(true)}>
          Создать ключ
        </Button>
      </div>
      {keys === undefined ? (
        <Loading className="py-6" />
      ) : keys.length === 0 ? (
        <p className="rounded-[12px] bg-[#f8f6f1] px-3.5 py-3 text-[13.5px] text-ink-2">Ключей пока нет. Ключ нужен, чтобы сайт, рекламный сервис или партнёр создавали заявки через API.</p>
      ) : (
        <ul className="divide-y divide-line rounded-[12px] border border-line">
          {keys.map((k) => (
            <li key={k.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-[14px] font-semibold text-ink">{k.name}</span>
                  <code className="rounded-[6px] bg-field px-1.5 py-0.5 font-mono text-[12px] text-ink-2">{k.prefix}…</code>
                  {k.revokedAt && (
                    <Badge tone="gray" size="sm">
                      отозван
                    </Badge>
                  )}
                </div>
                <div className="text-[12.5px] text-muted">
                  создан {dateTime(k.createdAt)}
                  {k.createdBy ? ` · ${k.createdBy}` : ""} · {k.lastUsedAt ? `последний запрос ${dateTime(k.lastUsedAt)}` : "ещё не использовался"}
                </div>
              </div>
              {!k.revokedAt && (
                <Button size="sm" variant={confirm === k.id ? "danger" : "ghost"} icon={Ban} onClick={() => void revoke(k)}>
                  {confirm === k.id ? "Точно отозвать?" : "Отозвать"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={creating}
        onClose={close}
        title={created ? "Ключ создан" : "Новый ключ API"}
        width={520}
        footer={
          created ? (
            <Button onClick={close}>Готово, ключ сохранён</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={close}>
                Отмена
              </Button>
              <Button icon={KeyRound} disabled={busy || !name.trim()} onClick={() => void create()}>
                {busy ? "Создаём…" : "Создать"}
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>Скопируйте ключ «{created.name}» сейчас — он показывается один раз. Потеряли — создайте новый, а старый отзовите. Не публикуйте ключ на сайте и в чатах.</span>
            </div>
            <CopyRow label="Ключ API" value={created.key} />
          </div>
        ) : (
          <FormRow label="Название" required hint="Чтобы потом понять, где используется ключ">
            {(id) => (
              <Input
                id={id}
                autoFocus
                maxLength={60}
                placeholder="Сайт, рекламный кабинет, партнёр…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && name.trim() && !busy && void create()}
              />
            )}
          </FormRow>
        )}
      </Modal>
    </>
  );
}

// ── WhatsApp ─────────────────────────────────────────────────────────────────

const WA_DOCS = "https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started";

/** Подключение по шагам — значения потом задаются в окружении Convex. */
const WA_STEPS = [
  <>
    В <b>business.facebook.com</b> — бизнес-портфолио компании. Пройдите верификацию бизнеса: лимит сообщений вне 24-часового окна вырастет с 250 до 2 000 клиентов в сутки.
  </>,
  <>
    <b>developers.facebook.com/apps</b> → Create App → сценарий «Connect with customers through WhatsApp».
  </>,
  <>
    Use cases → Customize → <b>API Setup</b>: добавьте номер компании (+7…, не зарегистрированный в обычном WhatsApp или WhatsApp Business), подтвердите его кодом, зарегистрируйте в Cloud API (PIN из 6 цифр
    сохраните) и скопируйте <b>Phone number ID</b>.
  </>,
  <>
    Business settings → <b>System users</b> → пользователь с ролью Admin, дайте ему приложение и WhatsApp-аккаунт → Generate token: срок «Никогда», права <code>whatsapp_business_messaging</code>,{" "}
    <code>whatsapp_business_management</code>, <code>business_management</code>. Это постоянный токен.
  </>,
  <>
    App settings → Basic → <b>App secret</b> — им Meta подписывает каждый вебхук.
  </>,
  <>
    В Convex (Settings → Environment Variables) задайте <code>WHATSAPP_TOKEN</code>, <code>WHATSAPP_PHONE_NUMBER_ID</code>, <code>WHATSAPP_APP_SECRET</code> и <code>WHATSAPP_VERIFY_TOKEN</code> — свою случайную
    строку от 32 символов (например, <code>openssl rand -hex 32</code>).
  </>,
  <>
    В приложении Meta: Configuration → <b>Webhook</b> — Callback URL и Verify token отсюда → Verify and save. Подпишитесь на поля <code>messages</code> и <code>user_id_update</code>.
  </>,
  <>Переведите приложение в режим Live и добавьте способ оплаты в WhatsApp Manager.</>,
];

const verifyHint = (t: WhatsAppSettings["verifyToken"]): string =>
  t.state === "ok"
    ? `Verify token — значение WHATSAPP_VERIFY_TOKEN (заканчивается на «…${t.end ?? ""}»). Его же введите в Meta рядом с Callback URL.`
    : t.state === "short"
      ? "Verify token короче 16 символов — замените WHATSAPP_VERIFY_TOKEN на случайную строку от 32 символов."
      : "Verify token не задан — придумайте случайную строку от 32 символов и задайте её в WHATSAPP_VERIFY_TOKEN.";

/** Ошибку недельной давности ещё показываем: вебхуки идут и при сломанном токене, а отметка «работает» у них общая. */
const ERROR_SHOWN_MS = 7 * 86400_000;

/** Последняя ошибка за неделю; fresh — после неё ничего успешного не было. */
function lastError(h: WhatsAppSettings["health"], now: number): { at: string; text: string; fresh: boolean } | undefined {
  if (!h?.errorAt || now - Date.parse(h.errorAt) > ERROR_SHOWN_MS) return undefined;
  return { at: h.errorAt, text: h.error ?? "Ошибка", fresh: !h.okAt || h.errorAt > h.okAt };
}

function waStatus(s: WhatsAppSettings, error: ReturnType<typeof lastError>): { tone: "green" | "amber" | "red" | "gray"; label: string } {
  if (!s.configured) return { tone: "gray", label: "Не подключён" };
  if (error?.fresh) return { tone: "red", label: "Есть ошибка" };
  return s.lastWebhookAt ? { tone: "green", label: "Работает" } : { tone: "amber", label: "Ждём первый вебхук" };
}

export function WhatsAppCard() {
  const s = useQuery(api.channels.whatsapp.settings);
  const now = useNow(60_000);
  if (s === undefined) {
    return (
      <Card icon={MessageCircle} title="WhatsApp">
        <Loading className="py-6" />
      </Card>
    );
  }
  const error = lastError(s.health, now);
  const status = waStatus(s, error);
  return (
    <Card icon={MessageCircle} title="WhatsApp">
      <p className="text-[13.5px] text-muted">
        Клиенты пишут на номер компании в WhatsApp — текст, фото, документы, голосовые (с расшифровкой) и геопозиция появляются в «Сообщениях», оттуда же отвечаем. Свободным текстом WhatsApp разрешает отвечать
        24 часа после последнего сообщения клиента — дальше звоним.
      </p>

      <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            {s.businessPhone && <span className="text-[14px] font-semibold text-ink">{phone(s.businessPhone)}</span>}
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13.5px]">
            <dt className="text-muted">Последний вебхук</dt>
            <dd className="font-medium text-ink">{s.lastWebhookAt ? dateTime(s.lastWebhookAt) : "ещё не приходил"}</dd>
            <dt className="text-muted">Версия Graph API</dt>
            <dd className="text-ink-2">{s.graphVersion}</dd>
          </dl>
          {s.missing.length > 0 && (
            <div className="flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink">
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                Не заданы переменные окружения Convex: <code>{s.missing.join(", ")}</code>.
              </span>
            </div>
          )}
          {error && (
            <div className={error.fresh ? "flex items-start gap-2 rounded-[10px] bg-bad-bg px-3 py-2.5 text-[13px] text-bad-ink" : "flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink"}>
              <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
              <span>
                {error.fresh ? "" : "Последняя ошибка: "}
                {error.text} · {dateTime(error.at)}
              </span>
            </div>
          )}
          {s.webhookUrl ? (
            <CopyRow label="Callback URL — вставьте в Meta (Configuration → Webhook)" value={s.webhookUrl} />
          ) : (
            <p className="text-[13.5px] text-bad-ink">Адрес сервера не определён — проверьте настройки деплоя Convex.</p>
          )}
          <p className={s.verifyToken.state === "ok" ? "text-[13px] text-ink-2" : "text-[13px] text-warn-ink"}>{verifyHint(s.verifyToken)}</p>
        </section>

        <section className="min-w-0 space-y-3">
          <details className="group rounded-[12px] border border-line" open={!s.configured}>
            <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">Как подключить</summary>
            <ol className="list-decimal space-y-1.5 border-t border-line py-3 pr-3.5 pl-8 text-[13px] text-ink-2">
              {WA_STEPS.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </details>
          <div className="rounded-[12px] bg-[#f8f6f1] px-3.5 py-3 text-[13px] text-ink-2">
            <div className="mb-1 font-semibold text-ink">Цены Meta для Казахстана с 1 октября 2026</div>
            Входящие — бесплатно. Ответ в течение 24 часов — $0,018 за доставленное сообщение. Шаблоны: utility — $0,018, marketing — $0,0604. После рекламы Click-to-WhatsApp — 72 часа бесплатно. Meta
            списывает в долларах; расход — в WhatsApp Manager → Insights.
          </div>
          <a href={WA_DOCS} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-brand-ink hover:underline">
            Документация WhatsApp Cloud API <ExternalLink size={14} aria-hidden />
          </a>
        </section>
      </div>
    </Card>
  );
}
