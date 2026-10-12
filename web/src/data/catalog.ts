import type { CategoryId, LeadStatus, OrderStatus, PaymentMethod, Role, SourceId, Urgency } from "./types";

export type Tone = "blue" | "sky" | "violet" | "amber" | "green" | "red" | "orange" | "gray" | "yellow";

/** Название продукта — в интерфейсе, сообщениях бота и выгрузках. Меняется здесь. */
export const APP_NAME = "Home Max Service";

export const CITIES = ["Алматы", "Астана", "Шымкент", "Караганда"] as const;

export const SOURCES: Record<SourceId, { label: string }> = {
  olx: { label: "OLX" },
  whatsapp: { label: "WhatsApp" },
  telegram: { label: "Telegram" },
  site: { label: "Сайт" },
  phone: { label: "Телефон" },
  instagram: { label: "Instagram" },
  referral: { label: "Рекомендация" },
};
export const SOURCE_IDS = Object.keys(SOURCES) as SourceId[];

export interface Category {
  id: CategoryId;
  label: string;
  tone: Tone;
  /** false — направление скрыто из форм (старые заказы показываются как раньше). */
  active?: boolean;
  /** Навыки направления: мастер отмечает свои, оператор — требуемые в заказе. */
  skills?: string[];
}

/** Справочник по умолчанию — им заполняется пустая база. Рабочий справочник владелец правит в «Настройках». */
export const DEFAULT_CATEGORIES: Category[] = [
  { id: "ac", label: "Кондиционеры", tone: "blue", skills: ["Монтаж сплит-систем", "Ремонт кондиционеров", "Чистка кондиционеров", "Заправка фреоном", "Мульти-сплит системы", "Промышленный климат"] },
  { id: "appliances", label: "Бытовая техника", tone: "green", skills: ["Стиральные машины", "Холодильники", "Посудомоечные машины", "Духовые шкафы и плиты", "Встраиваемая техника", "Диагностика"] },
  { id: "plumbing", label: "Сантехника", tone: "sky", skills: ["Разводка труб", "Устранение протечек", "Смесители и краны", "Унитазы и раковины", "Прочистка засоров", "Счётчики воды"] },
  { id: "electric", label: "Электрика", tone: "amber", skills: ["Электромонтаж", "Щиты и автоматы", "Розетки и выключатели", "Освещение и люстры", "Поиск неисправностей", "Заземление и УЗО"] },
  { id: "heating", label: "Отопление и котлы", tone: "orange", skills: ["Газовые котлы", "Электрокотлы", "Бойлеры", "Тёплый пол", "Радиаторы отопления"] },
  { id: "furniture", label: "Сборка мебели", tone: "orange", skills: ["Корпусная мебель", "Кухни", "ИКЕА", "Шкафы-купе", "Навеска полок и карнизов"] },
  { id: "cleaning", label: "Уборка", tone: "violet", skills: ["Генеральная уборка", "После ремонта", "Мытьё окон", "Химчистка мебели", "Химчистка ковров", "Уборка офисов"] },
  { id: "it", label: "Компьютеры и IT", tone: "blue", skills: ["Ремонт ПК и ноутбуков", "Сети и Wi‑Fi", "Windows и программы", "Принтеры и оргтехника", "Серверы", "Разработка сайтов"] },
  { id: "intercom", label: "Домофоны и видеонаблюдение", tone: "gray", skills: ["Домофоны", "Видеонаблюдение", "Слаботочные сети", "Шлагбаумы и ворота", "СКУД и замки"] },
  { id: "other", label: "Другое", tone: "gray", skills: ["Мастер на час", "Мелкий ремонт", "Монтаж ТВ на стену", "Двери и замки"] },
];
export let CATEGORIES: Category[] = DEFAULT_CATEGORIES;
export const categoryById = (id: CategoryId): Category => CATEGORIES.find((c) => c.id === id) ?? DEFAULT_CATEGORIES.find((c) => c.id === id) ?? { id, label: id, tone: "gray" };

export type ServiceIcon =
  | "snowflake"
  | "airvent"
  | "washer"
  | "fridge"
  | "oven"
  | "dishwasher"
  | "droplets"
  | "wrench"
  | "faucet"
  | "zap"
  | "plug"
  | "flame"
  | "boiler"
  | "hammer"
  | "sofa"
  | "sparkles"
  | "brush"
  | "monitor"
  | "wifi"
  | "code"
  | "intercom"
  | "camera";

export interface Service {
  id: string;
  category: CategoryId;
  label: string;
  icon: ServiceIcon;
  /** Типичная цена для клиента, ₸ — для подсказки оператору и сида. */
  price: [number, number];
  /** Типичная доля исполнителя, %. */
  payoutPct: number;
  examples: string[];
  active?: boolean;
}

export const DEFAULT_SERVICES: Service[] = [
  { id: "ac-install", category: "ac", label: "Установка кондиционера", icon: "airvent", price: [30000, 45000], payoutPct: 70, examples: ["Монтаж сплит-системы в квартире", "Установка сплит-системы 12 BTU, 3 этаж", "Перенос кондиционера в другую комнату"] },
  { id: "ac-repair", category: "ac", label: "Ремонт кондиционера", icon: "snowflake", price: [20000, 35000], payoutPct: 70, examples: ["Плохо охлаждает, течёт вода с внутреннего блока", "Не включается, мигает индикатор", "Шумит внешний блок"] },
  { id: "ac-clean", category: "ac", label: "Чистка кондиционера", icon: "snowflake", price: [10000, 16000], payoutPct: 65, examples: ["Сезонная чистка двух сплит-систем", "Неприятный запах при включении", "Профилактика перед летом"] },
  { id: "ac-refill", category: "ac", label: "Заправка кондиционера", icon: "airvent", price: [13000, 20000], payoutPct: 65, examples: ["Дозаправка фреоном R410", "Не холодит после зимы"] },
  { id: "wm-repair", category: "appliances", label: "Ремонт стиральной машины", icon: "washer", price: [12000, 32000], payoutPct: 70, examples: ["Не сливает воду, нужна диагностика и ремонт", "Диагностика и замена насоса", "Не крутит барабан, ошибка E21"] },
  { id: "fridge-repair", category: "appliances", label: "Ремонт холодильника", icon: "fridge", price: [15000, 30000], payoutPct: 70, examples: ["Не охлаждает, проверить компрессор", "Течёт вода под холодильником", "Сильно шумит морозильная камера"] },
  { id: "oven-repair", category: "appliances", label: "Ремонт духового шкафа", icon: "oven", price: [14000, 24000], payoutPct: 70, examples: ["Не греет нижний ТЭН", "Не работает конвекция"] },
  { id: "dw-repair", category: "appliances", label: "Ремонт посудомоечной машины", icon: "dishwasher", price: [14000, 26000], payoutPct: 70, examples: ["Не набирает воду", "Плохо отмывает посуду"] },
  { id: "leak-fix", category: "plumbing", label: "Устранение протечки", icon: "droplets", price: [10000, 18000], payoutPct: 70, examples: ["Течёт под раковиной на кухне", "Капает с потолка в ванной, срочно"] },
  { id: "plumbing", category: "plumbing", label: "Сантехнические работы", icon: "wrench", price: [12000, 30000], payoutPct: 70, examples: ["Замена унитаза и смесителя", "Разводка труб в ванной"] },
  { id: "faucet", category: "plumbing", label: "Установка смесителя", icon: "faucet", price: [8000, 12000], payoutPct: 70, examples: ["Установить смеситель на кухне", "Замена смесителя в ванной"] },
  { id: "el-diag", category: "electric", label: "Диагностика электрики", icon: "zap", price: [10000, 18000], payoutPct: 70, examples: ["Выбивает автомат, найти причину", "Проверка проводки в офисе"] },
  { id: "el-install", category: "electric", label: "Электромонтаж", icon: "plug", price: [25000, 90000], payoutPct: 72, examples: ["Электромонтаж в новой квартире 2 комнаты", "Замена щитка и автоматов"] },
  { id: "el-sockets", category: "electric", label: "Замена розеток и выключателей", icon: "plug", price: [8000, 14000], payoutPct: 70, examples: ["Заменить 6 розеток и 3 выключателя"] },
  { id: "boiler", category: "heating", label: "Установка бойлера", icon: "boiler", price: [18000, 28000], payoutPct: 70, examples: ["Установка бойлера на 80 литров", "Заменить старый бойлер на новый"] },
  { id: "boiler-service", category: "heating", label: "Техобслуживание котла", icon: "flame", price: [18000, 30000], payoutPct: 68, examples: ["Ежегодное ТО газового котла", "Котёл тухнет, ошибка давления"] },
  { id: "furniture", category: "furniture", label: "Сборка мебели", icon: "hammer", price: [12000, 25000], payoutPct: 75, examples: ["Собрать шкаф (ИКЕА), 3 секции", "Сборка кухонного гарнитура", "Собрать кровать и комод"] },
  { id: "cleaning", category: "cleaning", label: "Генеральная уборка", icon: "sparkles", price: [20000, 45000], payoutPct: 65, examples: ["Квартира 2 комнаты, ~60 м²", "Уборка после ремонта, 3 комнаты"] },
  { id: "sofa-clean", category: "cleaning", label: "Химчистка дивана", icon: "brush", price: [12000, 20000], payoutPct: 65, examples: ["Угловой диван, пятна от кофе", "Химчистка дивана и двух кресел"] },
  { id: "pc-repair", category: "it", label: "Ремонт компьютеров", icon: "monitor", price: [8000, 20000], payoutPct: 70, examples: ["Ноутбук греется и выключается", "Переустановка Windows и программ"] },
  { id: "network", category: "it", label: "Настройка сети и Wi‑Fi", icon: "wifi", price: [10000, 35000], payoutPct: 70, examples: ["Настроить Wi‑Fi в офисе на 15 человек", "Слабый сигнал в дальней комнате"] },
  { id: "web-dev", category: "it", label: "Разработка сайта", icon: "code", price: [350000, 450000], payoutPct: 62, examples: ["Сайт-визитка для клиники, 5 страниц", "Лендинг с формой заявки и интеграцией WhatsApp"] },
  { id: "intercom", category: "intercom", label: "Обслуживание домофона", icon: "intercom", price: [15000, 30000], payoutPct: 70, examples: ["Не открывается дверь подъезда по ключу", "Плановое обслуживание домофонов ЖК"] },
  { id: "cctv", category: "intercom", label: "Установка видеонаблюдения", icon: "camera", price: [40000, 120000], payoutPct: 70, examples: ["4 камеры во дворе частного дома", "Видеонаблюдение для магазина"] },
  // Запасная услуга: заявка из Telegram или звонка, где AI не узнал услугу — оператор уточнит.
  { id: "other", category: "other", label: "Другое — уточнить", icon: "wrench", price: [0, 0], payoutPct: 70, examples: [] },
];
export let SERVICES: Service[] = DEFAULT_SERVICES;
/** Неизвестная (удалённая) услуга не роняет экран — показываем её ключ. */
export const serviceById = (id: string): Service =>
  SERVICES.find((s) => s.id === id) ?? DEFAULT_SERVICES.find((s) => s.id === id) ?? { id, category: "other", label: id, icon: "wrench", price: [0, 0], payoutPct: 70, examples: [] };

/** Подменить справочник тем, что пришёл с сервера (вызывается один раз при загрузке и при изменениях). */
export function setCatalog(categories: Category[], services: Service[]) {
  CATEGORIES = categories.length ? categories : DEFAULT_CATEGORIES;
  SERVICES = services.length ? services : DEFAULT_SERVICES;
}

export const URGENCY: Record<Urgency, { label: string; tone: Tone }> = {
  normal: { label: "Обычный", tone: "gray" },
  high: { label: "Высокий", tone: "amber" },
  urgent: { label: "Срочный", tone: "red" },
};

export const PAYMENT_METHODS: Record<PaymentMethod, string> = {
  kaspi: "Kaspi",
  cash: "Наличные",
  card: "Карта",
  transfer: "Перевод на счёт",
};

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Владелец",
  operator: "Оператор",
  manager: "Руководитель направления",
  executor: "Исполнитель",
};

// ── Заказ: статусы и переходы ────────────────────────────────────────────────

export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone }> = {
  new: { label: "Новый", tone: "amber" },
  awaiting_executor: { label: "Ожидает исполнителя", tone: "orange" },
  assigned: { label: "Исполнитель назначен", tone: "sky" },
  accepted: { label: "Принят исполнителем", tone: "sky" },
  in_progress: { label: "В работе", tone: "amber" },
  awaiting_client: { label: "Ожидает клиента", tone: "orange" },
  done: { label: "Выполнен", tone: "green" },
  awaiting_payment: { label: "Ожидает оплаты", tone: "amber" },
  paid: { label: "Оплачен", tone: "green" },
  closed: { label: "Закрыт", tone: "gray" },
  cancelled: { label: "Отменён", tone: "gray" },
  refund: { label: "Возврат", tone: "red" },
};

/** Порядок основного пути — для степпера. */
export const ORDER_FLOW: OrderStatus[] = [
  "new",
  "awaiting_executor",
  "assigned",
  "accepted",
  "in_progress",
  "awaiting_client",
  "done",
  "awaiting_payment",
  "paid",
  "closed",
];

export const ACTIVE_STATUSES: OrderStatus[] = ["new", "awaiting_executor", "assigned", "accepted", "in_progress", "awaiting_client"];
export const WORK_STATUSES: OrderStatus[] = ["assigned", "accepted", "in_progress", "awaiting_client"];
export const FINISHED_STATUSES: OrderStatus[] = ["done", "awaiting_payment", "paid", "closed"];

/** Колонки канбана — как на макете: 4 группы, точный статус виден на карточке. */
export const KANBAN: { id: string; label: string; tone: Tone; statuses: OrderStatus[] }[] = [
  { id: "new", label: "Новые", tone: "yellow", statuses: ["new"] },
  { id: "awaiting", label: "Ожидает исполнителя", tone: "yellow", statuses: ["awaiting_executor"] },
  { id: "work", label: "В работе", tone: "yellow", statuses: WORK_STATUSES },
  { id: "done", label: "Завершено", tone: "green", statuses: FINISHED_STATUSES },
];

/** Какие переходы доступны сотруднику (владелец/оператор). Исполнитель ходит по своим кнопкам. */
export const STAFF_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  new: ["awaiting_executor", "cancelled"],
  awaiting_executor: ["new", "cancelled"],
  assigned: ["awaiting_executor", "accepted", "cancelled"],
  accepted: ["in_progress", "awaiting_executor", "cancelled"],
  in_progress: ["awaiting_client", "done", "cancelled"],
  awaiting_client: ["in_progress", "done", "cancelled"],
  done: ["awaiting_payment", "paid", "in_progress"],
  awaiting_payment: ["paid"],
  paid: ["closed", "refund"],
  closed: ["refund"],
  cancelled: ["new"],
  refund: [],
};

/** Подписи действий в меню «Изменить статус». */
export const TRANSITION_LABEL: Partial<Record<OrderStatus, string>> = {
  new: "Вернуть в «Новый»",
  awaiting_executor: "Опубликовать в ленту исполнителей",
  accepted: "Отметить «Принят исполнителем»",
  in_progress: "В работе",
  awaiting_client: "Ожидает клиента",
  done: "Выполнен",
  awaiting_payment: "Ожидает оплаты",
  paid: "Оплачен",
  closed: "Закрыть заказ",
  cancelled: "Отменить заказ",
  refund: "Оформить возврат",
};

// ── Заявка ──────────────────────────────────────────────────────────────────

export const LEAD_STATUS: Record<LeadStatus, { label: string; tone: Tone }> = {
  new: { label: "Новая", tone: "blue" },
  qualifying: { label: "Квалификация", tone: "violet" },
  waiting: { label: "Ожидает", tone: "sky" },
  converted: { label: "Заказ создан", tone: "green" },
  rejected: { label: "Отказ", tone: "gray" },
};

export const REJECT_REASONS = ["Дорого", "Передумал", "Не наш профиль", "Не дозвонились", "Дубль заявки"];
