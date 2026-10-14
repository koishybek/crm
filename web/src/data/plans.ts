// Тарифы и платные модули компании (ТЗ §24.3–§24.5): одни правила для сервера и интерфейса.
// Оплату тарифа платформа ведёт вне системы: тариф и модули ставит администратор платформы (экран «Платформа»).

export const MODULES = ["ai", "telephony", "whatsapp", "olx", "online_payments", "documents", "analytics_pro", "api"] as const;
export type TenantModule = (typeof MODULES)[number];

export const MODULE_LABEL: Record<TenantModule, string> = {
  ai: "AI-помощник",
  telephony: "Телефония (АТС)",
  whatsapp: "WhatsApp",
  olx: "OLX",
  online_payments: "Онлайн-оплата",
  documents: "Счета и акты",
  analytics_pro: "Расширенная аналитика",
  api: "API и вебхуки",
};

export const PLANS = ["free", "standard", "pro"] as const;
export type Plan = (typeof PLANS)[number];

export interface PlanInfo {
  label: string;
  /** Лимиты; null — без ограничения. */
  users: number | null;
  executors: number | null;
  ordersPerMonth: number | null;
  /** Модули, которые включаются с тарифом (администратор платформы может добавить или убрать отдельные). */
  modules: readonly TenantModule[];
}

export const PLAN_INFO: Record<Plan, PlanInfo> = {
  free: { label: "Бесплатный", users: 3, executors: 5, ordersPerMonth: 50, modules: [] },
  standard: { label: "Стандарт", users: 15, executors: 50, ordersPerMonth: 1000, modules: ["telephony", "whatsapp", "olx", "online_payments", "documents"] },
  pro: { label: "Про", users: null, executors: null, ordersPerMonth: null, modules: MODULES },
};

/** Самый дешёвый тариф, в который модуль входит, — для подписи «Доступно на тарифе …». */
export function planFor(module: TenantModule): Plan {
  return PLANS.find((p) => PLAN_INFO[p].modules.includes(module)) ?? "pro";
}

export const lockText = (module: TenantModule): string => `${MODULE_LABEL[module]} — доступно на тарифе «${PLAN_INFO[planFor(module)].label}»`;

/** Ограничения тарифа, которые проверяются при создании. */
export type LimitKind = "users" | "executors" | "ordersPerMonth";
export const LIMIT_TEXT: Record<LimitKind, string> = {
  users: "сотрудников",
  executors: "исполнителей",
  ordersPerMonth: "заказов в месяц",
};
export const limitText = (plan: Plan, kind: LimitKind): string =>
  `На тарифе «${PLAN_INFO[plan].label}» — не больше ${PLAN_INFO[plan][kind]} ${LIMIT_TEXT[kind]}. Обратитесь к администратору платформы, чтобы сменить тариф.`;

/** Адрес компании в ссылках (/zayavka?c=…): латиница, цифры и дефис. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu",
  я: "ya", ә: "a", ғ: "g", қ: "k", ң: "n", ө: "o", ұ: "u", ү: "u", һ: "h", і: "i",
};

/** Адрес из названия: «Мастер на час» → «master-na-chas». */
export function slugify(name: string): string {
  const latin = [...name.toLowerCase()].map((c) => TRANSLIT[c] ?? c).join("");
  const slug = latin.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32).replace(/-+$/, "");
  return slug.length >= 3 ? slug : `company-${slug || "x"}`;
}

/** Комиссия платформы (ТЗ §24.2): процент от цены клиента или фиксированная сумма с выполненного заказа. */
export interface PlatformFee {
  mode: "percent" | "fixed";
  value: number;
}
export const platformFeeFor = (fee: PlatformFee | undefined, clientPrice: number): number => {
  if (!fee || fee.value <= 0) return 0;
  return fee.mode === "fixed" ? Math.round(fee.value) : Math.round((clientPrice * fee.value) / 100);
};

/** Шаги «С чего начать» для владельца новой компании. */
export const ONBOARDING_STEPS = ["catalog", "staff", "executors", "channels"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export const ONBOARDING_INFO: Record<OnboardingStep, { label: string; hint: string; link: string }> = {
  catalog: { label: "Проверьте справочник услуг", hint: "Направления, услуги, цены и доля исполнителя", link: "/catalog" },
  staff: { label: "Добавьте сотрудников", hint: "Операторы и руководители направлений", link: "/settings" },
  executors: { label: "Добавьте исполнителей", hint: "Мастера получат свои логины", link: "/executors" },
  channels: { label: "Подключите каналы заявок", hint: "Форма на сайте, телефония, OLX, мессенджеры", link: "/settings" },
};

/** Компания вошедшего пользователя — для замков модулей, карточки «Компания» и «С чего начать». */
export interface TenantInfo {
  slug: string;
  name: string;
  plan: Plan;
  modules: TenantModule[];
  status: "active" | "suspended";
  /** Администратор платформы (PLATFORM_ADMINS) — экран «Платформа». */
  platformAdmin: boolean;
  /** Только владельцу: лимиты тарифа и сколько уже занято, комиссия платформы, шаги «С чего начать» (null — скрыты). */
  owner?: {
    usage: Record<LimitKind, { used: number; cap: number | null }>;
    platformFee: PlatformFee | null;
    onboarding: { step: OnboardingStep; done: boolean }[] | null;
  };
}

/** Строка экрана «Платформа». */
export interface PlatformTenantRow {
  slug: string;
  name: string;
  plan: Plan;
  modules: TenantModule[];
  status: "active" | "suspended";
  createdAt: string;
  platformFee: PlatformFee | null;
  usage: Record<LimitKind, number>;
  owner: string | null;
}
