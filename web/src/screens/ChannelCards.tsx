// «API и сайт» в настройках владельца (ТЗ п.6 «Сайт», п.26 «API-first»): форма заявки для сайта (ссылка и iframe),
// сайты компании, которым можно слать заявки напрямую, и ключи публичного API с примерами запросов.
// «WhatsApp» — официальный WhatsApp Cloud API: что настроено, доходят ли вебхуки, как подключить.
// «OLX» — Partner API OLX.kz: ключи приложения, подключение аккаунта компании, синхронизация чатов.
import { useQuery } from "convex/react";
import { Ban, BellRing, Code2, Copy, ExternalLink, Globe, KeyRound, LogIn, Mail, MessageCircle, Plus, RefreshCw, Send, Store, TriangleAlert, Unplug } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../convex/_generated/api";
import { Badge, Button, Card, FormRow, Input, Loading, Modal, Textarea, Toggle } from "../components/ui";
import { APP_NAME } from "../data/catalog";
import { useNow } from "../data/hooks";
import { sendTestEmail, setClientNotify } from "../data/notifyActions";
import { EMAIL_KINDS, type EmailSettings } from "../data/notifyRules";
import { disconnectOlx, olxReturnMessage, startOlxConnect, syncOlxNow } from "../data/olx";
import { createApiKey, revokeApiKey, saveSiteOrigins, setApiServicePrices, siteUrl } from "../data/publicApi";
import { API_SCOPE_LABEL, API_SCOPES, LEGACY_SCOPES, type ApiScope } from "../data/apiScopes";
import { report, toast } from "../data/store";
import type { ApiKeyInfo, OlxSettings, WhatsAppSettings } from "../data/types";
import { dateTime, phone } from "../lib/format";
import { copy, CopyRow } from "./Integrations";
import { CheckOptions, WebhooksSection } from "./WebhooksSection";

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

const curlMore = (base: string) => `curl ${base}/api/v1/orders/1024 -H "Authorization: Bearer hms_ВАШ_КЛЮЧ"
# 200 → {"number":1024,"status":"in_progress","statusLabel":"В работе","service":"…","deadline":"…"}

curl ${base}/api/v1/services -H "Authorization: Bearer hms_ВАШ_КЛЮЧ"
# 200 → {"categories":[…],"services":[{"id":"ac-clean","label":"…","category":"ac"}]}`;

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
          {keys && (
            <Toggle checked={keys.servicePrices} onChange={(v) => void setApiServicePrices(v).then((r) => report(r, v ? "Справочник в API — с ценами" : "Справочник в API — без цен"))} label="Цены услуг в /api/v1/services" />
          )}
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
              <p>Статус заказа (право «Статус заказов») и справочник услуг (право «Справочник услуг») — без контактов клиента и денег:</p>
              <CodeBlock code={curlMore(base)} label="Заказ и справочник" />
              <p className="text-[12.5px] text-muted">
                Поля: <code>name</code>, <code>phone</code> (казахстанский номер), <code>description</code> — обязательные; <code>serviceId</code>, <code>city</code>, <code>source</code> (olx, phone, whatsapp, telegram, site,
                instagram, referral; по умолчанию site), <code>externalId</code>, метки рекламы <code>utm</code> (<code>{'{"source":"instagram","campaign":"ac-oct"}'}</code>) и <code>campaign</code> — по желанию.
              </p>
              <CopyRow label="Описание API (OpenAPI 3.1) — для разработчиков" value={`${base}/api/v1/openapi.json`} />
            </div>
          </details>
          <WebhooksSection />
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
  const [scopes, setScopes] = useState<ApiScope[]>([...LEGACY_SCOPES]);
  const [confirm, setConfirm] = useState<string | null>(null);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(null), 5000);
    return () => clearTimeout(t);
  }, [confirm]);

  const create = async () => {
    setBusy(true);
    const r = await createApiKey(name, scopes);
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
    setScopes([...LEGACY_SCOPES]);
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
                <div className="mt-0.5 flex flex-wrap gap-1">
                  {k.scopes.map((x) => (
                    <Badge key={x} tone="gray" size="sm">
                      {API_SCOPE_LABEL[x].label}
                    </Badge>
                  ))}
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
              <Button icon={KeyRound} disabled={busy || !name.trim() || !scopes.length} onClick={() => void create()}>
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
          <div className="space-y-3">
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
            <div>
              <div className="mb-1 text-[12.5px] font-medium text-muted">Что может ключ</div>
              <CheckOptions options={API_SCOPES.map((x) => ({ value: x, label: API_SCOPE_LABEL[x].label, hint: API_SCOPE_LABEL[x].hint }))} value={scopes} onChange={setScopes} />
            </div>
          </div>
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

// ── OLX ──────────────────────────────────────────────────────────────────────

const OLX_DEV = "https://developer.olx.kz";

const OLX_NOTES = [
  "Каждую минуту забираем новые сообщения покупателей по объявлениям компании — они появляются в «Сообщениях» с названием объявления, оттуда же отвечаем.",
  "Телефон покупателя OLX не показывает: заявка создаётся сама, только если клиент написал номер в сообщении. Иначе — «Создать заявку» прямо в чате.",
  "Написать покупателю первым через OLX нельзя — только ответить в его диалоге.",
];

function olxBadge(s: OlxSettings): { tone: "green" | "amber" | "red" | "gray"; label: string } {
  if (!s.configured) return { tone: "gray", label: "Ждём ключи OLX" };
  if (s.status === "error") return { tone: "red", label: "Нужно подключить заново" };
  if (s.status !== "connected") return { tone: "gray", label: "Не подключён" };
  if (s.pausedUntil || s.lastError) return { tone: "amber", label: "Есть ошибка" };
  return s.lastSyncAt ? { tone: "green", label: "Работает" } : { tone: "amber", label: "Первая синхронизация" };
}

/** Возврат с OLX (/settings?olx=connected|error&reason=…) — тост с итогом и чистый адрес. */
function useOlxReturn() {
  const [params, setParams] = useSearchParams();
  const result = params.get("olx");
  const reason = params.get("reason");
  const shown = useRef(false);
  useEffect(() => {
    if (!result || shown.current) return;
    shown.current = true;
    const msg = olxReturnMessage(result, reason);
    if (msg) toast(msg.text, msg.tone);
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("olx");
        next.delete("reason");
        return next;
      },
      { replace: true },
    );
  }, [result, reason, setParams]);
}

function Notice({ tone, children }: { tone: "warn" | "bad"; children: ReactNode }) {
  return (
    <div className={tone === "bad" ? "flex items-start gap-2 rounded-[10px] bg-bad-bg px-3 py-2.5 text-[13px] text-bad-ink" : "flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-[13px] text-warn-ink"}>
      <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

export function OlxCard() {
  const s = useQuery(api.channels.olx.settings);
  useOlxReturn();
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(t);
  }, [confirm]);

  if (s === undefined) {
    return (
      <Card icon={Store} title="OLX">
        <Loading className="py-6" />
      </Card>
    );
  }

  const connect = async () => {
    setBusy("connect");
    // Успех — браузер уходит на страницу входа OLX.
    if (!report(await startOlxConnect())) setBusy(null);
  };
  const sync = async () => {
    setBusy("sync");
    report(await syncOlxNow(), "Синхронизация запущена — новые сообщения появятся в течение минуты");
    setBusy(null);
  };
  const disconnect = async () => {
    if (!confirm) return setConfirm(true);
    setConfirm(false);
    setBusy("disconnect");
    report(await disconnectOlx(), "OLX отключён");
    setBusy(null);
  };
  const badge = olxBadge(s);

  return (
    <Card icon={Store} title="OLX">
      <p className="text-[13.5px] text-muted">Чаты покупателей OLX.kz по объявлениям компании — в «Сообщениях»: новые сообщения приходят сами, отвечаем отсюда же.</p>

      <div className="mt-4 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {s.status === "connected" && s.accountName && <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{s.accountName}</span>}
          </div>
          {s.keyIssue && <Notice tone="bad">{s.keyIssue}</Notice>}

          {!s.configured ? (
            <>
              <p className="text-[13.5px] text-ink-2">
                Ключи придут с developer.olx.kz после одобрения заявки. Адрес возврата уже указан: <code className="break-all">{s.callbackUrl ?? "…/olx/callback"}</code>
              </p>
              {s.missing.length > 0 && (
                <Notice tone="warn">
                  Когда ключи придут, задайте переменные окружения Convex: <code>{s.missing.join(", ")}</code>.
                </Notice>
              )}
            </>
          ) : s.status === "connected" ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13.5px]">
                <dt className="text-muted">Аккаунт OLX</dt>
                <dd className="min-w-0 font-medium break-words text-ink">
                  {s.accountName ?? "—"}
                  {s.accountId ? ` · ID ${s.accountId}` : ""}
                </dd>
                <dt className="text-muted">Подключил</dt>
                <dd className="text-ink-2">
                  {s.connectedBy ?? "—"}
                  {s.connectedAt ? ` · ${dateTime(s.connectedAt)}` : ""}
                </dd>
                <dt className="text-muted">Синхронизация</dt>
                <dd className="font-medium text-ink">{s.lastSyncAt ? dateTime(s.lastSyncAt) : "ещё не было"}</dd>
              </dl>
              {s.pausedUntil && <Notice tone="warn">Запросы к OLX на паузе до {dateTime(s.pausedUntil)} — синхронизация продолжится сама.</Notice>}
              {s.lastError && <Notice tone="bad">{s.lastError}</Notice>}
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" icon={RefreshCw} disabled={busy !== null || !!s.pausedUntil} onClick={() => void sync()}>
                  {busy === "sync" ? "Запускаем…" : "Синхронизировать сейчас"}
                </Button>
                <Button size="sm" variant={confirm ? "danger" : "ghost"} icon={Unplug} disabled={busy !== null} onClick={() => void disconnect()}>
                  {confirm ? "Точно отключить?" : "Отключить"}
                </Button>
              </div>
              <p className="text-[12.5px] text-muted">
                Проверьте, что подключён аккаунт компании, а не личный. «Отключить» стирает доступ здесь; отозвать его и на стороне OLX можно в настройках аккаунта OLX.
              </p>
            </>
          ) : (
            <>
              {s.status === "error" && (
                <Notice tone="bad">{s.lastError ?? "Нужно заново подключить OLX"}: доступ к аккаунту истёк или отозван. Пока OLX не подключён заново, сообщения с OLX не приходят.</Notice>
              )}
              <p className="text-[13px] text-ink-2">
                Откроется OLX: войдите в аккаунт компании и нажмите «Разрешить». Если в браузере открыт личный аккаунт OLX, сначала выйдите из него — иначе подключится он.
              </p>
              <div>
                <Button icon={LogIn} disabled={busy !== null || !!s.keyIssue} onClick={() => void connect()}>
                  {busy === "connect" ? "Открываем OLX…" : s.status === "error" ? "Подключить заново" : "Подключить OLX"}
                </Button>
              </div>
            </>
          )}
        </section>

        <section className="min-w-0 space-y-3">
          <div className="rounded-[12px] bg-[#f8f6f1] px-3.5 py-3 text-[13px] text-ink-2">
            <div className="mb-1 font-semibold text-ink">Как это работает</div>
            <ul className="list-disc space-y-1 pl-4">
              {OLX_NOTES.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </div>
          {s.callbackUrl ? (
            <CopyRow label="Адрес возврата (Redirect URI) в приложении OLX" value={s.callbackUrl} />
          ) : (
            <p className="text-[13.5px] text-bad-ink">Адрес сервера не определён — проверьте настройки деплоя Convex.</p>
          )}
          <a href={OLX_DEV} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13.5px] font-semibold text-brand-ink hover:underline">
            Кабинет разработчика OLX <ExternalLink size={14} aria-hidden />
          </a>
        </section>
      </div>
    </Card>
  );
}

// ── Email ────────────────────────────────────────────────────────────────────

/** Подключение Resend по шагам — значения потом задаются в окружении Convex. */
const EMAIL_STEPS = [
  <>
    <b>resend.com</b> → Domains → Add domain: поддомен только для писем, например <code>notify.ваш-домен.kz</code>, регион <b>eu-west-1</b>.
  </>,
  <>
    Перенесите в DNS записи из вкладки Records: MX и TXT (SPF) для <code>send.notify</code>, TXT (DKIM) для <code>resend._domainkey.notify</code> и DMARC — TXT для <code>_dmarc</code>:{" "}
    <code>v=DMARC1; p=none</code>. В Cloudflare — без оранжевого облака.
  </>,
  <>
    Нажмите <b>Verify</b>: обычно до 15 минут, бывает до 72 часов.
  </>,
  <>
    API Keys → Create API key: права <b>Sending access</b>, только этот домен.
  </>,
  <>
    В Convex (Settings → Environment Variables): <code>EMAIL_API_KEY</code> — ключ, <code>EMAIL_FROM</code> — <code>Home Max Service &lt;noreply@notify.ваш-домен.kz&gt;</code>, по желанию{" "}
    <code>EMAIL_REPLY_TO</code> — ящик офиса. На тестовом деплойменте добавьте <code>EMAIL_REDIRECT_TO</code> — все письма уйдут на этот адрес.
  </>,
  <>Нажмите «Отправить проверочное письмо» — оно придёт на ваш email из логина.</>,
];

function emailBadge(s: EmailSettings, error: ReturnType<typeof lastError>): { tone: "green" | "amber" | "red" | "gray"; label: string } {
  if (!s.configured) return { tone: "gray", label: "Не настроен" };
  if (error?.fresh) return { tone: "red", label: "Есть ошибка" };
  return s.health?.okAt ? { tone: "green", label: "Работает" } : { tone: "amber", label: "Писем ещё не было" };
}

export function EmailCard() {
  const s = useQuery(api.email.settings);
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  if (s === undefined) {
    return (
      <Card icon={Mail} title="Email">
        <Loading className="py-6" />
      </Card>
    );
  }
  const error = lastError(s.health, now);
  const badge = emailBadge(s, error);
  const test = async () => {
    setBusy(true);
    report(await sendTestEmail(), "Проверочное письмо отправлено — проверьте почту");
    setBusy(false);
  };
  return (
    <Card icon={Mail} title="Email">
      <p className="text-[13.5px] text-muted">
        Копии важных уведомлений сотрудникам — через Resend. Каждый включает их сам: меню профиля → «Дублировать на email». В письмах нет данных клиентов — номер, услуга и ссылка в кабинет.
      </p>
      <div className="mt-4 space-y-3">
        <div>
          <Badge tone={badge.tone}>{badge.label}</Badge>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[13.5px]">
          <dt className="text-muted">Отправитель</dt>
          <dd className="min-w-0 font-medium break-words text-ink">{s.from ?? "не задан"}</dd>
          {s.replyTo && (
            <>
              <dt className="text-muted">Ответы</dt>
              <dd className="min-w-0 break-words text-ink-2">{s.replyTo}</dd>
            </>
          )}
          <dt className="text-muted">Получают</dt>
          <dd className="min-w-0 text-ink-2">{s.subscribers.length ? s.subscribers.join(", ") : "пока никто не включил"}</dd>
        </dl>
        {s.redirectTo && <Notice tone="warn">Тестовый режим: все письма уходят на {s.redirectTo} (EMAIL_REDIRECT_TO).</Notice>}
        {s.missing.length > 0 && (
          <Notice tone="warn">
            Задайте переменные окружения Convex: <code>{s.missing.join(", ")}</code>.
          </Notice>
        )}
        {error && (
          <Notice tone={error.fresh ? "bad" : "warn"}>
            {error.fresh ? "" : "Последняя ошибка: "}
            {error.text} · {dateTime(error.at)}
          </Notice>
        )}
        <div className="rounded-[12px] bg-[#f8f6f1] px-3.5 py-3 text-[13px] text-ink-2">
          <div className="mb-1 font-semibold text-ink">Что приходит на email</div>
          <ul className="list-disc space-y-1 pl-4">
            {Object.values(EMAIL_KINDS).map((k) => (
              <li key={k.label}>
                <b>{k.label}</b> — {k.to}
              </li>
            ))}
          </ul>
        </div>
        {s.configured && (
          <Button size="sm" variant="secondary" icon={Send} disabled={busy} onClick={() => void test()}>
            {busy ? "Отправляем…" : "Отправить проверочное письмо"}
          </Button>
        )}
        <details className="rounded-[12px] border border-line" open={!s.configured}>
          <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">Как подключить</summary>
          <ol className="list-decimal space-y-1.5 border-t border-line py-3 pr-3.5 pl-8 text-[13px] text-ink-2">
            {EMAIL_STEPS.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </details>
      </div>
    </Card>
  );
}

// ── Уведомления клиентам ─────────────────────────────────────────────────────

const CLIENT_EXAMPLES = [
  { when: "Мастер взял заказ", text: "«Заказ №1024: мастер Асет приедет завтра до 14:00»" },
  { when: "Работа выполнена", text: `«Заказ №1024 выполнен — спасибо, что выбрали ${APP_NAME}!» и просьба оценить мастера: звёзды в Telegram, ссылка в WhatsApp` },
  { when: "Заказ отменён", text: "«Заказ №1024 отменён. Если это ошибка — напишите нам сюда»" },
];

export function ClientNotifyCard() {
  const s = useQuery(api.clientNotify.settings);
  const [busy, setBusy] = useState(false);
  if (s === undefined) {
    return (
      <Card icon={BellRing} title="Уведомления клиентам">
        <Loading className="py-6" />
      </Card>
    );
  }
  const channels = [s.channels.telegram ? "Telegram" : "", s.channels.whatsapp ? "WhatsApp" : "", s.channels.olx ? "OLX" : ""].filter(Boolean);
  const toggle = async (on: boolean) => {
    setBusy(true);
    report(await setClientNotify(on), on ? "Клиенты будут получать сообщения о заказах" : "Сообщения клиентам выключены");
    setBusy(false);
  };
  return (
    <Card icon={BellRing} title="Уведомления клиентам">
      <p className="text-[13.5px] text-muted">
        Клиент получает короткое сообщение о своём заказе там, где писал нам последним: в Telegram, WhatsApp (только 24 часа после его сообщения) или на OLX. Клиенту с сайта или по телефону не пишем — звоним.
      </p>
      <div className="mt-4 space-y-3">
        <Toggle
          checked={s.enabled}
          onChange={(on) => {
            if (!busy) void toggle(on);
          }}
          label="Уведомлять клиентов"
        />
        <p className="text-[13px] text-ink-2">{channels.length ? `Сейчас можно писать: ${channels.join(", ")}.` : "Каналы для сообщений клиентам пока не подключены."}</p>
        <div className="rounded-[12px] bg-[#f8f6f1] px-3.5 py-3 text-[13px] text-ink-2">
          <div className="mb-1 font-semibold text-ink">Что получает клиент</div>
          <ul className="list-disc space-y-1 pl-4">
            {CLIENT_EXAMPLES.map((x) => (
              <li key={x.when}>
                <b>{x.when}</b> — {x.text}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] text-muted">Каждое событие — один раз. Только имя мастера и время: без цен, выплат и его телефона. Отправленное видно в «Сообщениях» и в истории заказа.</p>
        </div>
      </div>
    </Card>
  );
}

/** Email сотрудникам и сообщения клиентам — рядом, одной строкой в «Настройках». */
export function NotifyCards() {
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
      <EmailCard />
      <ClientNotifyCard />
    </div>
  );
}
