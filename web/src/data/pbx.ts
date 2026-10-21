// Облачные АТС (ТЗ п.19.1, п.22.1, п.5.7): какие поддерживаем, что владелец вводит при подключении и как настроить АТС.
// Общие для сервера (convex/pbx.ts, convex/lib/pbx/*) и карточки «Телефония → Провайдер АТС».
import type { SourceId } from "./types";

export const PBX_PROVIDERS = ["kcell", "binotel", "zadarma", "onlinepbx"] as const;
export type PbxProvider = (typeof PBX_PROVIDERS)[number];

/** Поле подключения: secret — хранится зашифрованным и обратно не показывается. */
export interface PbxField {
  key: string;
  label: string;
  secret: boolean;
  optional?: boolean;
  placeholder?: string;
  hint?: string;
}

export interface PbxProviderInfo {
  label: string;
  /** Где взять ключи и куда вставить адрес — шаги для владельца. */
  steps: string[];
  fields: PbxField[];
  /** Ссылка на документацию провайдера. */
  docs: string;
}

export const PBX_INFO: Record<PbxProvider, PbxProviderInfo> = {
  kcell: {
    label: "Kcell ВАТС",
    docs: "https://manual.kcell.kz/rest_api",
    fields: [
      { key: "domain", label: "Адрес АТС", secret: false, placeholder: "company.vpbx.kcell.kz", hint: "Адрес вашего личного кабинета ВАТС, без https://" },
      { key: "apiKey", label: "Ключ для авторизации в АТС", secret: true, hint: "ВАТС → Интеграции → «Другая CRM (REST API)»" },
      { key: "crmToken", label: "Ключ CRM (token)", secret: true, hint: "Задаётся там же — АТС присылает его в каждом событии" },
    ],
    steps: [
      "Личный кабинет ВАТС Kcell → Интеграции → «Другая CRM (REST API)»: включите интеграцию (опция «Интеграция с CRM»).",
      "В поле адреса CRM вставьте «Адрес для АТС» ниже; ключ CRM (token) и «Ключ для авторизации в АТС» из этой интеграции впишите здесь.",
      "Включите запись звонков и укажите сотрудникам их короткие номера ВАТС — тогда работает «Позвонить через АТС», а входящие привязываются к оператору.",
    ],
  },
  binotel: {
    label: "Binotel",
    docs: "https://developers.binotel.ua/",
    fields: [
      { key: "key", label: "Ключ API (key)", secret: true },
      { key: "secret", label: "Секрет API (secret)", secret: true },
      { key: "companyId", label: "Номер компании (companyID)", secret: false, optional: true, hint: "Если указан — события другой компании отклоняются" },
    ],
    steps: [
      "Попросите поддержку Binotel (support@binotel.ua) включить доступ к API и выдать key и secret.",
      "Попросите отправлять события API CALL SETTINGS и API CALL COMPLETED (и PUSH о приёме звонка) на «Адрес для АТС» ниже.",
      "Укажите у сотрудников их внутренние номера Binotel — тогда работает «Позвонить через АТС», а входящие привязываются к оператору.",
    ],
  },
  zadarma: {
    label: "Zadarma",
    docs: "https://zadarma.com/ru/support/api/",
    fields: [
      { key: "key", label: "Ключ API (Key)", secret: true },
      { key: "secret", label: "Секрет API (Secret)", secret: true },
    ],
    steps: [
      "Личный кабинет Zadarma → Настройки → Интеграции и API → Ключи для API: скопируйте Key и Secret.",
      "Там же, «Уведомления в CRM / Webhooks»: вставьте «Адрес для АТС» ниже в поля для звонков (NOTIFY_START, NOTIFY_INTERNAL, NOTIFY_ANSWER, NOTIFY_END, NOTIFY_OUT_START, NOTIFY_OUT_END) и записи разговоров (NOTIFY_RECORD).",
      "Включите запись разговоров на АТС и укажите сотрудникам внутренние номера АТС (100, 101…).",
    ],
  },
  onlinepbx: {
    label: "OnlinePBX",
    docs: "https://api.onlinepbx.ru/",
    fields: [
      { key: "domain", label: "Домен АТС", secret: false, placeholder: "company.onpbx.ru" },
      { key: "apiKey", label: "Ключ API", secret: true, hint: "Панель OnlinePBX → Интеграция → API" },
    ],
    steps: [
      "Панель OnlinePBX → Интеграция → API: создайте ключ и скопируйте его вместе с доменом АТС.",
      "Панель OnlinePBX → Интеграция → Вебхуки: добавьте «Адрес для АТС» ниже на события начала, ответа и завершения звонка.",
      "Укажите сотрудникам их внутренние номера OnlinePBX.",
    ],
  },
};

export const isPbxProvider = (x: string): x is PbxProvider => (PBX_PROVIDERS as readonly string[]).includes(x);

/** Путь вебхука провайдера на сервере: https://<deployment>.convex.site/pbx/<provider>?key=<ключ АТС>. */
export const pbxWebhookPath = (p: PbxProvider): string => `/pbx/${p}`;

/** Внутренний номер сотрудника: 1–8 цифр (у Zadarma и OnlinePBX — 100, 101…, у Binotel — 901…). Пусто — номера нет. */
export function cleanExtension(raw: string): string | null | "invalid" {
  const s = raw.trim();
  if (!s) return null;
  return /^\d{1,8}$/.test(s) ? s : "invalid";
}

/** Адрес ВАТС Kcell: поддомен kcell.kz («company.vpbx.kcell.kz») — без схемы и пути. */
export const KCELL_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}(\.[a-z0-9][a-z0-9-]{0,62})*\.kcell\.kz$/;

/** Адрес АТС, как его вставили: без https:// и пути, строчными. */
export const cleanPbxDomain = (raw: string): string => raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");

/** Домен OnlinePBX: «company.onpbx.ru» — без схемы и пути. */
export const ONLINEPBX_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.onpbx\.ru$/;

/** Что показать в карточке и на кнопке звонка. */
export interface PbxSettingsView {
  provider: PbxProvider | null;
  /** Несекретные поля подключения (домен, companyID) — секретные не отдаются. */
  config: Record<string, string>;
  /** Секреты сохранены (сами значения не показываем). */
  hasSecrets: boolean;
  /** Ключ шифрования INTEGRATIONS_KEY в порядке; иначе — причина. */
  keyIssue: string | null;
  /** База адреса вебхука (без ключа): ключ подставляет «Скопировать адрес» после показа (каждый показ — в журнале). */
  siteUrl: string | null;
  /** Ключ АТС создан. */
  hasPbxSecret: boolean;
  staff: { id: string; name: string; role: string; extension: string | null }[];
  /** Источник по номеру линии: звонки на номер из объявлений OLX — заявки «OLX» (колл-трекинг). */
  lines: { number: string; source: SourceId }[];
}

/** Звонок через АТС из карточки: можно ли (АТС подключена и у сотрудника есть внутренний номер). */
export interface PbxDialState {
  enabled: boolean;
  provider: PbxProvider | null;
  /** Почему нельзя — подсказка на кнопке. */
  reason?: string;
}

export type DialResult = { mode: "pbx"; provider: PbxProvider } | { mode: "tel"; href: string; reason: string };
