// Демо-данные: 90 дней истории, построенные от «сейчас», чтобы прототип всегда выглядел живым.
// Генератор детерминированный (mulberry32) — у всех один и тот же набор.

import { SERVICES, serviceById } from "./catalog";
import type {
  Actor,
  AiSummary,
  CategoryId,
  Client,
  DB,
  Executor,
  HistoryEvent,
  HistoryKind,
  Interaction,
  Lead,
  LeadStatus,
  Message,
  Notification,
  Order,
  OrderStatus,
  Payment,
  PaymentMethod,
  SourceId,
  Urgency,
  User,
} from "./types";
import { money, shortName } from "../lib/format";

export const TENANT = "t-komfort";

/** Заявка/заказ до подстановки копий имени и телефона клиента — их проставляем в конце. */
type SeedLead = Omit<Lead, "clientName" | "clientPhone">;
type SeedOrder = Omit<Order, "clientName" | "clientPhone" | "category">;
export const DB_VERSION = 6;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(a: number, b: number) {
    return a + Math.floor(this.next() * (b - a + 1));
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  weighted<T>(xs: readonly [T, number][]): T {
    const total = xs.reduce((s, [, w]) => s + w, 0);
    let x = this.next() * total;
    for (const [v, w] of xs) {
      x -= w;
      if (x <= 0) return v;
    }
    return xs[xs.length - 1]![0];
  }
}

const iso = (ms: number) => new Date(ms).toISOString();

// ── Справочники для генерации ───────────────────────────────────────────────

const F_FIRST = ["Айсулу", "Айым", "Айнур", "Мадина", "Салтанат", "Гульнар", "Алия", "Асем", "Дана", "Айгерим", "Жанна", "Камила", "Динара", "Аружан", "Томирис", "Сабина", "Ольга", "Наталья", "Елена", "Зарина", "Карлыгаш", "Меруерт"];
const F_LAST = ["Нурланова", "Саттарова", "Ерланкызы", "Тулегенова", "Ибраимова", "Жумабекова", "Касымова", "Смирнова", "Ахметова", "Омарова", "Сейткали", "Мукашева", "Абдрахманова", "Кенжебаева", "Волкова", "Бекова"];
const M_FIRST = ["Руслан", "Тимур", "Нурлан", "Ерлан", "Еркин", "Данияр", "Айбек", "Асхат", "Бауыржан", "Серик", "Ильяс", "Дамир", "Арман", "Максим", "Сергей", "Дмитрий", "Алексей", "Ербол", "Азамат", "Олжас", "Мирас", "Канат"];
const M_LAST = ["Толеубеков", "Кожахметов", "Сапарбаев", "Ахметов", "Сериков", "Байжанов", "Исмаилов", "Козлов", "Иванов", "Мусин", "Абенов", "Оспанов", "Сагинтаев", "Жаксылыков", "Нургалиев", "Ким"];
const COMPANIES = ["ТОО Global KG", "ТОО АзияСтрой", "ЖК Nomad", "ЖК Тенгри", "ТОО Алма Ресторантс", "ТОО Медикал Плюс", "ОСИ «Достык»", "ТОО Smart Office", "ИП Касымов", "ТОО Kazakh Coffee", "ТОО Береке Фуд", "ЖК Esentai City"];

const STREETS: Record<string, string[]> = {
  Алматы: ["ул. Абая", "пр. Достык", "ул. Толе би", "ул. Жандосова", "мкр. Самал-2", "ул. Розыбакиева", "пр. Аль-Фараби", "ул. Сатпаева", "мкр. Аксай-4", "ул. Тимирязева", "ул. Байзакова", "мкр. Орбита-3"],
  Астана: ["пр. Мангилик Ел", "ул. Сыганак", "пр. Кабанбай батыра", "ул. Кенесары", "пр. Туран", "ул. Достык"],
  Шымкент: ["пр. Тауке хана", "ул. Байтурсынова", "мкр. Нурсат", "ул. Рыскулова"],
  Караганда: ["пр. Бухар-жырау", "ул. Ерубаева", "мкр. Восток-5", "ул. Гоголя"],
};

const TR: Record<string, string> = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ы: "y", э: "e", ю: "yu", я: "ya", ь: "", ъ: "" };
const translit = (s: string) =>
  s
    .toLowerCase()
    .split("")
    .map((c) => TR[c] ?? c)
    .join("");

// ── Пользователи и исполнители ──────────────────────────────────────────────

const EXECUTORS: Omit<Executor, "tenantId" | "joinedAt">[] = [
  { id: "ex-azamat-n", name: "Азамат Нуралиев", phone: "77011234567", city: "Алматы", categories: ["ac"], skills: ["Монтаж сплит-систем", "Заправка фреоном", "Промышленный климат"], available: true, rating: 4.9, reviews: 132, cooperation: "staff" },
  { id: "ex-bekzat", name: "Бекзат Иманов", phone: "77019876543", city: "Алматы", categories: ["ac", "appliances"], skills: ["Ремонт кондиционеров", "Стиральные машины", "Диагностика"], available: true, rating: 4.9, reviews: 128, cooperation: "freelance" },
  { id: "ex-nurlan", name: "Нурлан Жумабаев", phone: "77784445678", city: "Алматы", categories: ["ac", "appliances"], skills: ["Чистка кондиционеров", "Холодильники", "Стиральные машины"], available: true, rating: 4.9, reviews: 96, cooperation: "freelance" },
  { id: "ex-marat", name: "Марат Султанов", phone: "77013332211", city: "Алматы", categories: ["plumbing"], skills: ["Устранение протечек", "Разводка труб", "Смесители и краны"], available: true, rating: 4.7, reviews: 77, cooperation: "freelance" },
  { id: "ex-erkebulan", name: "Еркебулан Сарсенов", phone: "77075553311", city: "Алматы", categories: ["electric", "intercom"], skills: ["Электромонтаж", "Щиты и автоматы", "Домофоны"], available: true, rating: 4.7, reviews: 58, cooperation: "freelance" },
  { id: "ex-timur", name: "Тимур Ахметов", phone: "77471239090", city: "Алматы", categories: ["furniture"], skills: ["Корпусная мебель", "Кухни", "ИКЕА"], available: true, rating: 4.8, reviews: 87, cooperation: "freelance" },
  { id: "ex-gaukhar", name: "Гаухар Бекова", phone: "77085557788", city: "Алматы", categories: ["cleaning"], skills: ["Генеральная уборка", "После ремонта", "Химчистка мебели"], available: true, rating: 4.9, reviews: 112, cooperation: "freelance" },
  { id: "ex-samat", name: "Самат Абенов", phone: "77772225566", city: "Алматы", categories: ["heating", "plumbing"], skills: ["Газовые котлы", "Бойлеры", "Тёплый пол"], available: true, rating: 4.6, reviews: 40, cooperation: "freelance" },
  { id: "ex-almas", name: "Алмас Кенжебаев", phone: "77053334455", city: "Алматы", categories: ["intercom", "it"], skills: ["Видеонаблюдение", "Слаботочные сети", "Сети и Wi‑Fi"], available: true, rating: 4.5, reviews: 23, cooperation: "freelance" },
  { id: "ex-erbol", name: "Ербол Омирбек", phone: "77021113322", city: "Алматы", categories: ["it"], skills: ["Ремонт ПК и ноутбуков", "Сети и Wi‑Fi", "Разработка сайтов"], available: false, rating: 4.5, reviews: 31, cooperation: "freelance" },
  { id: "ex-daniyar", name: "Данияр Касенов", phone: "77005551234", city: "Астана", categories: ["electric"], skills: ["Электромонтаж", "Щиты и автоматы", "Поиск неисправностей"], available: true, rating: 4.6, reviews: 54, cooperation: "staff" },
  { id: "ex-ruslan", name: "Руслан Толеубеков", phone: "77019990011", city: "Астана", categories: ["ac"], skills: ["Монтаж сплит-систем", "Чистка кондиционеров", "Заправка фреоном"], available: true, rating: 4.8, reviews: 69, cooperation: "freelance" },
  { id: "ex-arman", name: "Арман Серикбаев", phone: "77074441122", city: "Астана", categories: ["appliances", "plumbing"], skills: ["Стиральные машины", "Холодильники", "Устранение протечек"], available: true, rating: 4.7, reviews: 61, cooperation: "freelance" },
  { id: "ex-zhanar", name: "Жанар Ермекова", phone: "77476667788", city: "Астана", categories: ["cleaning"], skills: ["Генеральная уборка", "Мытьё окон"], available: false, rating: 4.8, reviews: 49, cooperation: "freelance" },
  { id: "ex-dias", name: "Диас Оразов", phone: "77753338899", city: "Астана", categories: ["furniture", "heating", "intercom"], skills: ["Корпусная мебель", "Бойлеры", "Домофоны"], available: true, rating: 4.5, reviews: 19, cooperation: "freelance" },
  { id: "ex-azamat-t", name: "Азамат Тлеуов", phone: "77007778899", city: "Шымкент", categories: ["appliances", "ac"], skills: ["Стиральные машины", "Ремонт кондиционеров", "Чистка кондиционеров"], available: true, rating: 4.6, reviews: 44, cooperation: "freelance" },
  { id: "ex-ilyas", name: "Ильяс Байжанов", phone: "77712224433", city: "Шымкент", categories: ["plumbing", "furniture", "heating"], skills: ["Смесители и краны", "Корпусная мебель", "Бойлеры"], available: true, rating: 4.6, reviews: 28, cooperation: "freelance" },
  { id: "ex-kanat", name: "Канат Мусин", phone: "77017776655", city: "Караганда", categories: ["heating", "plumbing", "appliances"], skills: ["Газовые котлы", "Разводка труб", "Стиральные машины"], available: true, rating: 4.7, reviews: 35, cooperation: "freelance" },
];

const STAFF: User[] = [
  { id: "u-owner", tenantId: TENANT, name: "Алихан Сейтказы", role: "owner", email: "alikhan@homemax.kz", phone: "77010001122" },
  { id: "u-madina", tenantId: TENANT, name: "Мадина Ергалиева", role: "operator", email: "madina@homemax.kz", phone: "77010003344" },
  { id: "u-erzhan", tenantId: TENANT, name: "Ержан Абдрахманов", role: "operator", email: "erzhan@homemax.kz", phone: "77010005566" },
  { id: "u-erlan", tenantId: TENANT, name: "Ерлан Касымов", role: "manager", email: "erlan@homemax.kz", phone: "77010007788", categories: ["ac", "appliances"] },
];

const SERVICE_WEIGHTS: Record<string, number> = {
  "ac-repair": 10, "ac-clean": 10, "ac-install": 7, "ac-refill": 4,
  "wm-repair": 9, "fridge-repair": 7, "oven-repair": 3, "dw-repair": 3,
  "leak-fix": 5, plumbing: 4, faucet: 3,
  "el-diag": 4, "el-install": 2, "el-sockets": 3,
  boiler: 4, "boiler-service": 3,
  furniture: 6, cleaning: 5, "sofa-clean": 3,
  "pc-repair": 3, network: 2, "web-dev": 0,
  intercom: 2, cctv: 1.5,
};

const SOURCE_WEIGHTS: [SourceId, number][] = [
  ["olx", 30], ["whatsapp", 22], ["phone", 14], ["telegram", 12], ["site", 12], ["instagram", 6], ["referral", 4],
];
const CITY_WEIGHTS: [string, number][] = [["Алматы", 60], ["Астана", 25], ["Шымкент", 8], ["Караганда", 7]];

const CLIENT_MSG = ["Здравствуйте! Во сколько мастер подъедет?", "Добрый день, подтверждаю время.", "Можно перенести на час позже?", "Спасибо, всё работает!", "Код домофона 45, 3 этаж."];
const EXEC_MSG = ["Добрый день! Буду у вас примерно через час.", "Выехал, ориентировочно буду через 40 минут.", "Работы выполнены, проверили вместе с клиентом.", "Нужна деталь, привезу завтра утром."];
const OP_MSG = ["Клиент просил позвонить за 30 минут до приезда.", "Оплата на месте через Kaspi.", "Клиент постоянный, сделать скидку не обещали.", "Заказ передан исполнителю."];
const CALL_NOTES = ["Уточнил стоимость и сроки", "Обсудили удобное время приезда", "Спросил про гарантию на работы", "Перезвонил после пропущенного"];

export function buildSeed(nowDate = new Date()): DB {
  const now = nowDate.getTime();
  const r = new Rng(20261011);
  let n = 0;
  const id = (p: string) => `${p}-${(++n).toString(36)}`;

  const executors: Executor[] = EXECUTORS.map((e, i) => ({ ...e, tenantId: TENANT, joinedAt: iso(now - (400 - i * 17) * DAY) }));
  const users: User[] = [
    ...STAFF,
    ...executors.map<User>((e) => ({
      id: `u-${e.id}`,
      tenantId: TENANT,
      name: e.name,
      role: "executor",
      email: `${translit(e.name.split(" ")[0]!)}@homemax.kz`,
      phone: e.phone,
      executorId: e.id,
    })),
  ];
  const execUser = (exId: string) => `u-${exId}`;
  const operators = ["u-madina", "u-erzhan", "u-madina", "u-erzhan", "u-owner"];

  const clients: Client[] = [];
  const leads: SeedLead[] = [];
  const orders: SeedOrder[] = [];
  const messages: Message[] = [];
  const history: HistoryEvent[] = [];
  const interactions: Interaction[] = [];
  const clientNotes: DB["clientNotes"] = [];
  const notifications: Notification[] = [];

  const usedPhones = new Set<string>(executors.map((e) => e.phone));
  const newPhone = () => {
    for (;;) {
      const p = `7${r.pick(["701", "702", "705", "707", "708", "747", "771", "775", "777", "778", "700"])}${String(r.int(1000000, 9999999))}`;
      if (!usedPhones.has(p)) {
        usedPhones.add(p);
        return p;
      }
    }
  };
  const address = (city: string) => `${r.pick(STREETS[city] ?? STREETS["Алматы"]!)}, ${r.int(2, 180)}${r.chance(0.7) ? `, кв. ${r.int(1, 220)}` : ""}`;

  const makeClient = (at: number, opts: Partial<Client> = {}): Client => {
    const isCompany = opts.kind === "company" || (!opts.name && r.chance(0.08));
    const female = r.chance(0.55);
    const name =
      opts.name ?? (isCompany ? r.pick(COMPANIES) : female ? `${r.pick(F_FIRST)} ${r.pick(F_LAST)}` : `${r.pick(M_FIRST)} ${r.pick(M_LAST)}`);
    const city = opts.city ?? r.weighted(CITY_WEIGHTS);
    const c: Client = {
      id: id("c"),
      tenantId: TENANT,
      name,
      kind: isCompany ? "company" : "person",
      phone: opts.phone ?? newPhone(),
      email: opts.email ?? (r.chance(0.35) && !isCompany ? `${translit(name.split(" ")[0]!)}.${translit((name.split(" ")[1] ?? "k")[0]!)}@mail.kz` : undefined),
      city,
      address: opts.address ?? address(city),
      source: opts.source ?? r.weighted(SOURCE_WEIGHTS),
      preferredChannel: opts.preferredChannel ?? r.pick<SourceId>(["whatsapp", "whatsapp", "phone", "telegram"]),
      tags: opts.tags ?? [],
      notes: opts.notes,
      createdAt: iso(at),
    };
    clients.push(c);
    return c;
  };

  const executorsFor = (category: CategoryId, city: string, onlyAvailable: boolean) =>
    executors.filter((e) => e.city === city && e.categories.includes(category) && (!onlyAvailable || e.available));

  const servicesIn = (city: string) => SERVICES.filter((s) => executorsFor(s.category, city, false).length > 0);
  const pickService = (city: string) => {
    const list = servicesIn(city);
    return r.weighted(list.map((s) => [s, SERVICE_WEIGHTS[s.id] ?? 1] as [typeof s, number]));
  };
  const priceFor = (serviceId: string) => {
    const s = serviceById(serviceId);
    const raw = r.int(s.price[0], s.price[1]);
    const step = raw > 100000 ? 10000 : 1000;
    return Math.round(raw / step) * step;
  };

  const addHistory = (orderId: string, kind: HistoryKind, text: string, actor: Actor, at: number) =>
    history.push({ id: id("h"), orderId, kind, text, actor, at: iso(at) });

  const addInteractionsForLead = (lead: SeedLead, client: Client) => {
    const at = new Date(lead.createdAt).getTime();
    const svc = serviceById(lead.serviceId).label;
    if (lead.source === "phone") {
      interactions.push({ id: id("i"), clientId: client.id, kind: "call", channel: "phone", title: "Входящий звонок", text: lead.ai ? lead.ai.summary.split(".")[0]! + "." : r.pick(CALL_NOTES), at: iso(at - 2 * MIN) });
    }
    if (lead.source === "whatsapp" || lead.source === "telegram") {
      interactions.push({ id: id("i"), clientId: client.id, kind: "message", channel: lead.source, title: `Сообщение в ${lead.source === "whatsapp" ? "WhatsApp" : "Telegram"}`, text: lead.description, at: iso(at - 4 * MIN) });
    }
    interactions.push({ id: id("i"), clientId: client.id, kind: "lead", channel: lead.source, title: "Новая заявка", text: svc, at: iso(at), leadId: lead.id });
  };

  // ── Жизненный цикл заказа: список шагов, применяем только прошедшие ────────
  type Step = {
    at: number;
    kind: HistoryKind;
    text: string;
    actor: Actor;
    status?: OrderStatus;
    executorId?: string;
    payment?: Payment;
  };

  const applySteps = (o: SeedOrder, steps: Step[]) => {
    for (const s of steps.sort((a, b) => a.at - b.at)) {
      if (s.at > now) break;
      if (s.executorId) {
        o.executorId = s.executorId;
        o.assignedAt = iso(s.at);
      }
      if (s.payment) o.payments.push(s.payment);
      if (s.status) {
        o.status = s.status;
        if (s.status === "done") o.doneAt = iso(s.at);
        if (s.status === "paid") o.paidAt = iso(s.at);
        if (s.status === "closed") {
          o.closedAt = iso(s.at);
          o.payoutPaid = true;
        }
      }
      addHistory(o.id, s.kind, s.text, s.actor, s.at);
    }
  };

  const statusText = (st: OrderStatus) => {
    const map: Partial<Record<OrderStatus, string>> = {
      in_progress: "Статус изменён на «В работе»",
      awaiting_client: "Статус изменён на «Ожидает клиента»",
      done: "Работа выполнена",
      awaiting_payment: "Выставлен счёт клиенту",
      closed: "Заказ закрыт",
    };
    return map[st] ?? `Статус изменён`;
  };

  interface OrderSpec {
    lead?: SeedLead;
    client: Client;
    serviceId: string;
    city: string;
    address: string;
    description: string;
    source: SourceId;
    priority: Urgency;
    createdAt: number;
    deadline: number;
    operatorId: string;
    clientPrice: number;
    payoutPct?: number;
    payoutFixed?: number;
  }

  const baseOrder = (s: OrderSpec, number: number): SeedOrder => {
    const pctVal = s.payoutPct ?? serviceById(s.serviceId).payoutPct;
    const percentMode = s.payoutFixed === undefined && r.chance(0.15);
    return {
      id: id("o"),
      tenantId: TENANT,
      number,
      clientId: s.client.id,
      leadId: s.lead?.id,
      source: s.source,
      serviceId: s.serviceId,
      description: s.description,
      city: s.city,
      address: s.address,
      deadline: iso(s.deadline),
      priority: s.priority,
      status: "new",
      clientPrice: s.clientPrice,
      payoutMode: percentMode ? "percent" : "fixed",
      payoutValue: percentMode ? pctVal : (s.payoutFixed ?? Math.round((s.clientPrice * pctVal) / 100 / 500) * 500),
      payments: [],
      payoutPaid: false,
      createdAt: iso(s.createdAt),
      createdBy: s.operatorId,
      files: [],
    };
  };

  /** Обычный заказ из истории: время каждого шага разыгрывается, статус определяется «сейчас». */
  const simulateOrder = (s: OrderSpec, number: number, opts: { forceStuck?: boolean } = {}) => {
    const o = baseOrder(s, number);
    orders.push(o);
    const svc = serviceById(s.serviceId);
    const op: Actor = { type: "user", id: s.operatorId };
    const steps: Step[] = [{ at: s.createdAt, kind: "created", text: "Заказ создан", actor: op, status: "new" }];

    const t1 = s.createdAt + r.int(5, 60) * MIN;
    steps.push({ at: t1, kind: "published", text: "Опубликован в ленту исполнителей", actor: op, status: "awaiting_executor" });

    const recent = s.createdAt > now - 3 * DAY;
    const pool = executorsFor(svc.category, s.city, recent);
    const ex = r.weighted((pool.length ? pool : executorsFor(svc.category, s.city, false)).map((e) => [e, e.rating * e.rating] as [Executor, number]));
    const exActor: Actor = { type: "user", id: execUser(ex.id) };

    let t2: number;
    if (r.chance(0.7)) {
      t2 = t1 + r.int(15, 240) * MIN;
      steps.push({ at: t2, kind: "taken", text: "Исполнитель взял заказ из ленты", actor: exActor, status: "accepted", executorId: ex.id });
    } else {
      const ta = t1 + r.int(10, 120) * MIN;
      steps.push({ at: ta, kind: "assigned", text: `Назначен исполнитель: ${shortName(ex.name)}`, actor: op, status: "assigned", executorId: ex.id });
      t2 = ta + r.int(5, 60) * MIN;
      steps.push({ at: t2, kind: "status", text: "Исполнитель подтвердил заказ", actor: exActor, status: "accepted" });
    }

    const cancelled = r.chance(0.06);
    if (cancelled) {
      const tc = t2 + r.int(30, 600) * MIN;
      const reason = r.pick(["Клиент передумал", "Клиент нашёл другого мастера", "Не договорились по цене", "Неисправность устранилась сама"]);
      steps.push({ at: tc, kind: "status", text: `Заказ отменён: ${reason}`, actor: op, status: "cancelled" });
      o.cancelReason = reason;
      applySteps(o, steps);
      return o;
    }

    let t3 = Math.max(t2 + 30 * MIN, s.deadline - r.int(1, 6) * HOUR);
    steps.push({ at: t3, kind: "status", text: statusText("in_progress"), actor: exActor, status: "in_progress" });
    if (r.chance(0.12)) {
      const ta = t3 + r.int(30, 120) * MIN;
      steps.push({ at: ta, kind: "status", text: statusText("awaiting_client"), actor: exActor, status: "awaiting_client" });
      t3 = ta + r.int(2, 20) * HOUR;
      steps.push({ at: t3, kind: "status", text: statusText("in_progress"), actor: exActor, status: "in_progress" });
    }

    const stuck = opts.forceStuck || (s.deadline < now && s.deadline > now - 2 * DAY && r.chance(0.18));
    if (stuck) {
      applySteps(o, steps);
      return o;
    }

    const late = r.chance(0.1);
    const t4 = late ? s.deadline + r.int(1, 20) * HOUR : t3 + r.int(1, 4) * HOUR;
    steps.push({ at: t4, kind: "status", text: statusText("done"), actor: exActor, status: "done" });

    const method: PaymentMethod = r.weighted([["kaspi", 60], ["cash", 20], ["transfer", 12], ["card", 8]]);
    let t5: number;
    if (r.chance(0.6)) {
      t5 = t4 + r.int(10, 90) * MIN;
    } else {
      steps.push({ at: t4 + 2 * HOUR, kind: "status", text: statusText("awaiting_payment"), actor: op, status: "awaiting_payment" });
      t5 = t4 + r.int(12, 72) * HOUR;
    }
    steps.push({
      at: t5,
      kind: "payment",
      text: `Оплата ${money(o.clientPrice)} · ${method === "kaspi" ? "Kaspi" : method === "cash" ? "наличные" : method === "card" ? "карта" : "перевод"}`,
      actor: op,
      status: "paid",
      payment: { id: id("p"), amount: o.clientPrice, method, at: iso(t5) },
    });
    const t6 = t5 + r.int(6, 72) * HOUR;
    steps.push({ at: t6, kind: "status", text: statusText("closed"), actor: op, status: "closed" });
    if (r.chance(0.012)) {
      steps.push({ at: t6 + r.int(1, 4) * DAY, kind: "status", text: "Оформлен возврат: клиент недоволен качеством", actor: op, status: "refund" });
    }
    applySteps(o, steps);

    // Немного переписки на свежих заказах.
    if (s.createdAt > now - 6 * DAY && o.executorId) {
      const at0 = new Date(o.assignedAt!).getTime();
      const msgs: [Actor, "client" | "internal", string][] = [
        [{ type: "client", id: s.client.id }, "client", r.pick(CLIENT_MSG)],
        [exActor, "client", r.pick(EXEC_MSG)],
      ];
      if (r.chance(0.5)) msgs.push([op, "internal", r.pick(OP_MSG)]);
      msgs.forEach(([author, channel, text], i) => {
        const at = at0 + (i + 1) * r.int(10, 50) * MIN;
        if (at > now) return;
        messages.push({ id: id("m"), orderId: o.id, author, channel, text, files: [], at: iso(at) });
        addHistory(o.id, "comment", "Добавлен комментарий", author, at);
      });
    }
    return o;
  };

  /** Свежий заказ с заданным текущим статусом (для «сегодня» — как на макетах). */
  const stagedOrder = (
    s: OrderSpec,
    number: number,
    stage: OrderStatus,
    opts: { executorId?: string; via?: "feed" | "manual"; marks?: number[] } = {},
  ) => {
    const o = baseOrder(s, number);
    orders.push(o);
    const op: Actor = { type: "user", id: s.operatorId };
    const steps: Step[] = [{ at: s.createdAt, kind: "created", text: "Заказ создан", actor: op, status: "new" }];
    const span = Math.max(now - s.createdAt, 20 * MIN);
    const m = opts.marks ?? [0.15, 0.4, 0.7, 0.9];
    const at = (k: number) => s.createdAt + span * m[Math.min(k, m.length - 1)]!;
    if (stage === "new") {
      applySteps(o, steps);
      return o;
    }
    steps.push({ at: at(0), kind: "published", text: "Опубликован в ленту исполнителей", actor: op, status: "awaiting_executor" });
    if (stage === "awaiting_executor" || !opts.executorId) {
      applySteps(o, steps);
      return o;
    }
    const ex = executors.find((e) => e.id === opts.executorId)!;
    const exActor: Actor = { type: "user", id: execUser(ex.id) };
    if (opts.via === "manual" || stage === "assigned") {
      steps.push({ at: at(1), kind: "assigned", text: `Назначен исполнитель: ${shortName(ex.name)}`, actor: op, status: "assigned", executorId: ex.id });
      if (stage !== "assigned") steps.push({ at: at(1) + 5 * MIN, kind: "status", text: "Исполнитель подтвердил заказ", actor: exActor, status: "accepted" });
    } else {
      steps.push({ at: at(1), kind: "taken", text: "Исполнитель взял заказ из ленты", actor: exActor, status: "accepted", executorId: ex.id });
    }
    if (stage === "in_progress" || stage === "awaiting_client") {
      steps.push({ at: at(2), kind: "status", text: statusText("in_progress"), actor: exActor, status: "in_progress" });
      if (stage === "awaiting_client") steps.push({ at: at(3), kind: "status", text: statusText("awaiting_client"), actor: exActor, status: "awaiting_client" });
    }
    applySteps(o, steps);
    return o;
  };

  // ── История: 90 дней заявок и заказов ──────────────────────────────────────
  type Draft = { at: number; build: (number: number) => void };
  const drafts: Draft[] = [];
  const startOfToday = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()).getTime();

  for (let ago = 90; ago >= 1; ago--) {
    const dayStart = startOfToday - ago * DAY;
    const dow = new Date(dayStart).getDay();
    const growth = 0.55 + 0.8 * (1 - ago / 90);
    const base = dow === 0 || dow === 6 ? 5 : 8;
    const full = Math.max(1, Math.round(base * growth + r.int(-1, 2)));
    // Последние двое суток наполовину заняты ручными «свежими» заказами ниже — иначе на графике пик в конце.
    const count = ago <= 2 ? Math.ceil(full / 2) : full;
    for (let k = 0; k < count; k++) {
      const at = dayStart + r.int(8 * 60, 21 * 60) * MIN;
      drafts.push({
        at,
        build: (number) => {
          const repeat = clients.length > 20 && r.chance(0.3);
          const client = repeat ? r.pick(clients.filter((c) => new Date(c.createdAt).getTime() < at)) : makeClient(at);
          const city = client.city;
          const svc = pickService(city);
          const source = repeat ? r.weighted<SourceId>([[client.source, 3], ["whatsapp", 2], ["phone", 1]]) : client.source;
          const ageDays = (now - at) / DAY;
          const status: LeadStatus =
            ageDays > 3
              ? r.weighted<LeadStatus>([["converted", 66], ["rejected", 34]])
              : r.weighted<LeadStatus>([["converted", 55], ["rejected", 15], ["waiting", 15], ["qualifying", 15]]);
          const lead: SeedLead = {
            id: id("l"),
            tenantId: TENANT,
            number,
            clientId: client.id,
            source,
            serviceId: svc.id,
            city,
            description: r.pick(svc.examples),
            urgency: r.weighted<Urgency>([["normal", 70], ["high", 20], ["urgent", 10]]),
            status,
            operatorId: r.pick(operators),
            createdAt: iso(at),
            rejectReason: status === "rejected" ? r.pick(["Дорого", "Передумал", "Не дозвонились", "Не наш профиль", "Дубль заявки"]) : undefined,
          };
          leads.push(lead);
          addInteractionsForLead(lead, client);
          if (status !== "converted") return;
          const created = at + r.int(10, 180) * MIN;
          const deadlineDay = new Date(created + (svc.id === "web-dev" ? r.int(10, 25) : r.int(0, 3)) * DAY);
          deadlineDay.setHours(r.int(10, 18), 0, 0, 0);
          const deadline = Math.max(deadlineDay.getTime(), created + 3 * HOUR);
          const o = simulateOrder(
            {
              lead,
              client,
              serviceId: svc.id,
              city,
              address: client.address ?? address(city),
              description: lead.description,
              source,
              priority: lead.urgency,
              createdAt: created,
              deadline,
              operatorId: lead.operatorId,
              clientPrice: priceFor(svc.id),
            },
            number,
          );
          lead.orderId = o.id;
        },
      });
    }
  }

  // ── Витринные записи «сегодня» — повторяют макеты ─────────────────────────
  const ago = (min: number) => now - min * MIN;
  const at = (dayOffset: number, h: number, m = 0) => {
    const d = new Date(startOfToday + dayOffset * DAY);
    d.setHours(h, m, 0, 0);
    return d.getTime();
  };
  /** Ближайший «круглый» час не раньше чем через minH часов. */
  const soon = (minH: number) => {
    const d = new Date(now + minH * HOUR);
    d.setMinutes(0, 0, 0);
    return d.getTime() + HOUR;
  };

  // Клиентка с богатой историей (макет «Карточка клиента»).
  const aiym = makeClient(now - 214 * DAY, {
    name: "Айым Саттарова",
    phone: "77015556677",
    email: "aiym.sattarova@mail.kz",
    city: "Алматы",
    address: "ул. Толе би, 123, кв. 45",
    source: "whatsapp",
    preferredChannel: "whatsapp",
    tags: ["Постоянный клиент", "VIP", "Кондиционеры"],
    notes: "Удобно связываться после 18:00. Постоянный клиент, аккуратная и пунктуальная.",
  });
  usedPhones.add("77015556677");

  type Showcase = { at: number; build: (number: number) => void };
  const showcase: Showcase[] = [];

  // Её прошлые заказы — идут в общую ленту истории.
  const aiymPast: [number, string, number, string][] = [
    [212, "ac-clean", 18000, "Сезонная чистка двух сплит-систем"],
    [154, "ac-install", 75000, "Установка сплит-системы в спальне и гостиной"],
    [61, "wm-repair", 32000, "Не крутит барабан, ошибка E21"],
  ];
  aiymPast.forEach(([d, svcId, price, desc]) => {
    const t = now - d * DAY + 3 * HOUR;
    drafts.push({
      at: t,
      build: (number) => {
        const lead: SeedLead = { id: id("l"), tenantId: TENANT, number, clientId: aiym.id, source: "whatsapp", serviceId: svcId, city: "Алматы", description: desc, urgency: "normal", status: "converted", operatorId: "u-madina", createdAt: iso(t) };
        leads.push(lead);
        addInteractionsForLead(lead, aiym);
        const dl = new Date(t + 2 * DAY);
        dl.setHours(12, 0, 0, 0);
        const o = simulateOrder({ lead, client: aiym, serviceId: svcId, city: "Алматы", address: aiym.address!, description: desc, source: "whatsapp", priority: "normal", createdAt: t + 20 * MIN, deadline: dl.getTime(), operatorId: "u-madina", clientPrice: price }, number);
        lead.orderId = o.id;
      },
    });
  });
  interactions.push(
    { id: id("i"), clientId: aiym.id, kind: "call", channel: "phone", title: "Звонок", text: "Уточнила стоимость обслуживания", at: iso(now - 68 * DAY) },
    { id: id("i"), clientId: aiym.id, kind: "message", channel: "whatsapp", title: "Сообщение в WhatsApp", text: "Запросила выезд на выходные", at: iso(now - 90 * DAY) },
    { id: id("i"), clientId: aiym.id, kind: "call", channel: "phone", title: "Звонок", text: "Обсудили удобное время приезда", at: iso(now - 155 * DAY) },
  );
  clientNotes.push(
    { id: id("n"), clientId: aiym.id, authorId: "u-ex-bekzat", text: "Клиент довольна работой мастера. Просила напоминать о ТО раз в 6 месяцев.", at: iso(now - 61 * DAY + 5 * HOUR) },
    { id: id("n"), clientId: aiym.id, authorId: "u-madina", text: "Постоянный клиент, всегда на связи. Предпочитает утреннее время.", at: iso(now - 154 * DAY + 2 * HOUR) },
  );

  // Сегодняшние/вчерашние заявки (макет «Заявки»).
  const aiFridge: AiSummary = {
    summary: "Клиентка сообщает, что холодильник Samsung перестал охлаждать нижнюю камеру два дня назад, морозилка работает. Просит мастера завтра после 18:00. Бюджет не обсуждали.",
    extracted: [
      { label: "Услуга", value: "Ремонт холодильника" },
      { label: "Город", value: "Алматы" },
      { label: "Адрес", value: "мкр. Самал-2, 58" },
      { label: "Когда", value: "Завтра после 18:00" },
      { label: "Срочность", value: "Высокая" },
      { label: "Бюджет", value: "Не назван" },
    ],
    questions: ["Модель и возраст холодильника?", "Есть ли гарантия магазина?", "Подъезд, этаж и код домофона?"],
  };
  const aiBoiler: AiSummary = {
    summary: "Клиентка хочет заменить старый бойлер на 80 литров, новый уже купила. Нужен монтаж на этой неделе, желательно в субботу. Спрашивала, вывозим ли старый бойлер.",
    extracted: [
      { label: "Услуга", value: "Установка бойлера" },
      { label: "Город", value: "Караганда" },
      { label: "Когда", value: "Суббота" },
      { label: "Бюджет", value: "До 25 000 ₸" },
      { label: "Срочность", value: "Обычная" },
    ],
    questions: ["Где будет висеть бойлер, есть ли крепёж?", "Нужен ли вывоз старого бойлера?"],
  };

  type TodayLead = { name: string; phone?: string; src: SourceId; svc: string; city: string; st: LeadStatus; min: number; urgency?: Urgency; ai?: AiSummary; desc?: string; stage?: OrderStatus; ex?: string; op?: string };
  const today: TodayLead[] = [
    { name: "Айнур Нурпеисова", phone: "77011239876", src: "whatsapp", svc: "ac-repair", city: "Алматы", st: "new", min: 22, urgency: "high", desc: "Кондиционер не включается, мигает индикатор" },
    { name: "Руслан Толеген", phone: "77772345678", src: "olx", svc: "ac-clean", city: "Алматы", st: "qualifying", min: 58 },
    { name: "Мадина Ерланкызы", phone: "77019871122", src: "telegram", svc: "wm-repair", city: "Астана", st: "converted", min: 140, stage: "in_progress", ex: "ex-arman" },
    { name: "Еркин Алиев", phone: "77053456789", src: "site", svc: "boiler", city: "Алматы", st: "new", min: 175 },
    { name: "Салтанат Касымова", phone: "77028765432", src: "phone", svc: "fridge-repair", city: "Алматы", st: "waiting", min: 205, urgency: "high", ai: aiFridge, desc: "Не охлаждает нижняя камера, морозилка работает" },
    { name: "Тимур Сериков", phone: "77781112233", src: "olx", svc: "ac-install", city: "Шымкент", st: "converted", min: 236, stage: "accepted", ex: "ex-azamat-t" },
    { name: "Гульнар Жумабекова", phone: "77016667788", src: "site", svc: "ac-clean", city: "Алматы", st: "qualifying", min: 268 },
    { name: "Нурлан Мусабаев", phone: "77754443322", src: "whatsapp", svc: "wm-repair", city: "Алматы", st: "new", min: 312 },
    { name: "Алия Бекова", phone: "77023331122", src: "phone", svc: "boiler", city: "Караганда", st: "waiting", min: 1060, ai: aiBoiler, desc: "Заменить старый бойлер на новый, 80 литров" },
    { name: "Данияр Сагинтаев", phone: "77779990011", src: "telegram", svc: "ac-repair", city: "Астана", st: "converted", min: 1135, stage: "in_progress", ex: "ex-ruslan" },
  ];
  today.forEach((t) => {
    const createdAt = ago(t.min);
    showcase.push({
      at: createdAt,
      build: (number) => {
        const client = makeClient(createdAt - 2 * MIN, { name: t.name, phone: t.phone, city: t.city, source: t.src });
        const svc = serviceById(t.svc);
        const lead: SeedLead = {
          id: id("l"),
          tenantId: TENANT,
          number,
          clientId: client.id,
          source: t.src,
          serviceId: t.svc,
          city: t.city,
          description: t.desc ?? r.pick(svc.examples),
          urgency: t.urgency ?? "normal",
          status: t.st,
          operatorId: t.op ?? r.pick(["u-madina", "u-erzhan"]),
          createdAt: iso(createdAt),
          ai: t.ai,
        };
        leads.push(lead);
        addInteractionsForLead(lead, client);
        if (t.st === "converted" && t.stage) {
          const created = createdAt + 12 * MIN;
          const o = stagedOrder(
            { lead, client, serviceId: t.svc, city: t.city, address: client.address!, description: lead.description, source: t.src, priority: lead.urgency, createdAt: created, deadline: soon(5), operatorId: lead.operatorId, clientPrice: priceFor(t.svc) },
            number,
            t.stage,
            { executorId: t.ex, via: "feed" },
          );
          lead.orderId = o.id;
        }
      },
    });
  });

  // Главный витринный заказ (макет «Карточка заказа»).
  const aisuluAt = ago(200);
  showcase.push({
    at: aisuluAt,
    build: (number) => {
      const client = makeClient(aisuluAt - 5 * MIN, { name: "Айсулу Нурланова", phone: "77014443322", city: "Алматы", address: "ул. Абая, 125, кв. 45", source: "site", preferredChannel: "whatsapp" });
      const lead: SeedLead = { id: id("l"), tenantId: TENANT, number, clientId: client.id, source: "site", serviceId: "ac-repair", city: "Алматы", description: "Кондиционер плохо охлаждает, из внутреннего блока капает вода. Модель Gree 12 BTU, 4 года.", urgency: "high", status: "converted", operatorId: "u-owner", createdAt: iso(aisuluAt - 4 * MIN) };
      leads.push(lead);
      addInteractionsForLead(lead, client);
      const dl = new Date(startOfToday + 3 * DAY);
      dl.setHours(14, 0, 0, 0);
      const o = baseOrder(
        { lead, client, serviceId: "ac-repair", city: "Алматы", address: client.address!, description: lead.description, source: "site", priority: "high", createdAt: aisuluAt, deadline: dl.getTime(), operatorId: "u-owner", clientPrice: 28000, payoutFixed: 20000 },
        number,
      );
      orders.push(o);
      lead.orderId = o.id;
      const owner: Actor = { type: "user", id: "u-owner" };
      const bek: Actor = { type: "user", id: "u-ex-bekzat" };
      const cl: Actor = { type: "client", id: client.id };
      applySteps(o, [
        { at: aisuluAt, kind: "created", text: "Заказ создан", actor: owner, status: "new" },
        { at: ago(185), kind: "published", text: "Опубликован в ленту исполнителей", actor: owner, status: "awaiting_executor" },
        { at: ago(137), kind: "taken", text: "Исполнитель взял заказ из ленты", actor: bek, status: "accepted", executorId: "ex-bekzat" },
        { at: ago(77), kind: "status", text: "Статус изменён на «В работе»", actor: owner, status: "in_progress" },
      ]);
      const photos = ["Внутренний блок.jpg", "Решётка.jpg", "Пульт и модель.jpg"].map((name) => ({ id: id("f"), name, kind: "image" as const }));
      messages.push(
        { id: id("m"), orderId: o.id, author: cl, channel: "client", text: "Добрый день! Кондиционер плохо охлаждает, прилагаю фото.", files: photos, at: iso(ago(128)) },
        { id: id("m"), orderId: o.id, author: bek, channel: "client", text: "Здравствуйте! Уже выехал по адресу. Ориентировочное время прибытия — через 40 минут.", files: [], at: iso(ago(90)) },
        { id: id("m"), orderId: o.id, author: owner, channel: "internal", text: "Заказ передан исполнителю Бекзат И. Клиент просит позвонить за 15 минут.", files: [], at: iso(ago(77)) },
      );
      o.files.push(...photos);
      addHistory(o.id, "comment", "Добавлен комментарий", cl, ago(128));
      addHistory(o.id, "file", "Добавлено 3 файла", cl, ago(127));
      addHistory(o.id, "comment", "Добавлен комментарий", bek, ago(90));
      addHistory(o.id, "comment", "Добавлен комментарий", owner, ago(77));
    },
  });

  // Айым: новая заявка сегодня + два активных заказа.
  showcase.push({
    at: ago(95),
    build: (number) => {
      const lead: SeedLead = { id: id("l"), tenantId: TENANT, number, clientId: aiym.id, source: "whatsapp", serviceId: "ac-clean", city: "Алматы", description: "Плановая чистка кондиционеров в спальне и гостиной", urgency: "normal", status: "new", operatorId: "u-madina", createdAt: iso(ago(95)) };
      leads.push(lead);
      addInteractionsForLead(lead, aiym);
    },
  });
  showcase.push({
    at: now - 2 * DAY - 3 * HOUR,
    build: (number) => {
      const t = now - 2 * DAY - 3 * HOUR;
      const lead: SeedLead = { id: id("l"), tenantId: TENANT, number, clientId: aiym.id, source: "whatsapp", serviceId: "ac-clean", city: "Алматы", description: "Неприятный запах при включении кондиционера на кухне", urgency: "normal", status: "converted", operatorId: "u-madina", createdAt: iso(t) };
      leads.push(lead);
      addInteractionsForLead(lead, aiym);
      const o = stagedOrder({ lead, client: aiym, serviceId: "ac-clean", city: "Алматы", address: aiym.address!, description: lead.description, source: "whatsapp", priority: "normal", createdAt: t + 15 * MIN, deadline: soon(6), operatorId: "u-madina", clientPrice: 18000 }, number, "in_progress", { executorId: "ex-azamat-n", via: "feed", marks: [0.05, 0.2, 0.96] });
      lead.orderId = o.id;
    },
  });
  showcase.push({
    at: now - 5 * DAY,
    build: (number) => {
      const t = now - 5 * DAY;
      const lead: SeedLead = { id: id("l"), tenantId: TENANT, number, clientId: aiym.id, source: "phone", serviceId: "ac-repair", city: "Алматы", description: "Обслуживание кондиционера в офисе, ждём запчасть (дренажная помпа)", urgency: "normal", status: "converted", operatorId: "u-erzhan", createdAt: iso(t) };
      leads.push(lead);
      addInteractionsForLead(lead, aiym);
      const o = stagedOrder({ lead, client: aiym, serviceId: "ac-repair", city: "Алматы", address: "пр. Достык, 97, офис 12", description: lead.description, source: "phone", priority: "normal", createdAt: t + 30 * MIN, deadline: soon(30), operatorId: "u-erzhan", clientPrice: 25000 }, number, "awaiting_client", { executorId: "ex-nurlan", via: "manual", marks: [0.02, 0.05, 0.2, 0.6] });
      lead.orderId = o.id;
    },
  });

  // Новые заказы (ещё не опубликованы) и лента «Ожидает исполнителя».
  type Fresh = { name: string; kind?: "company"; city: string; svc: string; price: number; payout?: number; desc: string; min: number; deadline: number; stage: OrderStatus; ex?: string; via?: "feed" | "manual"; src: SourceId; prio?: Urgency };
  const fresh: Fresh[] = [
    { name: "Айлин Саттарова", city: "Алматы", svc: "ac-repair", price: 21000, desc: "Течёт вода с внутреннего блока", min: 35, deadline: at(1, 14), stage: "new", src: "olx" },
    { name: "Нурлан Кожахметов", city: "Алматы", svc: "boiler", price: 26000, desc: "Установка бойлера на 80 литров", min: 70, deadline: at(1, 10), stage: "new", src: "olx" },
    { name: "Мадина Ерланова", city: "Алматы", svc: "wm-repair", price: 17000, desc: "Не отжимает, стучит барабан", min: 110, deadline: at(2, 16), stage: "new", src: "telegram" },
    { name: "Динара Ахметова", city: "Алматы", svc: "ac-install", price: 35000, payout: 25000, desc: "Монтаж сплит-системы в квартире", min: 150, deadline: soon(3), stage: "awaiting_executor", src: "olx", prio: "high" },
    { name: "Ерлан Оспанов", city: "Алматы", svc: "wm-repair", price: 25000, payout: 18000, desc: "Не сливает воду, нужна диагностика и ремонт", min: 260, deadline: at(1, 10), stage: "awaiting_executor", src: "whatsapp" },
    { name: "Жанна Омарова", city: "Алматы", svc: "fridge-repair", price: 30000, payout: 22000, desc: "Не охлаждает, проверить компрессор", min: 330, deadline: at(2, 11), stage: "awaiting_executor", src: "site" },
    { name: "ЖК Esentai City", kind: "company", city: "Алматы", svc: "ac-clean", price: 15000, payout: 10000, desc: "Сезонная чистка двух сплит-систем в офисе УК", min: 2450, deadline: at(2, 15), stage: "awaiting_executor", src: "referral" },
    { name: "Камила Ким", city: "Алматы", svc: "oven-repair", price: 20000, payout: 14000, desc: "Не греет нижний ТЭН", min: 3300, deadline: at(3, 12), stage: "awaiting_executor", src: "instagram" },
    { name: "ТОО Global KG", kind: "company", city: "Астана", svc: "el-diag", price: 18000, desc: "Выбивает автомат в серверной, найти причину", min: 2900, deadline: at(1, 18), stage: "awaiting_executor", src: "site", prio: "high" },
    { name: "Руслан Жаксылыков", city: "Алматы", svc: "furniture", price: 20000, payout: 15000, desc: "Собрать шкаф (ИКЕА), 3 секции", min: 3900, deadline: at(3, 12), stage: "awaiting_executor", src: "olx" },
    { name: "Салтанат Кенжебаева", city: "Алматы", svc: "leak-fix", price: 14000, desc: "Течёт под раковиной на кухне", min: 1700, deadline: at(1, 9), stage: "awaiting_executor", src: "whatsapp", prio: "urgent" },
    // Мои заказы Нурлана: один в работе, один назначен оператором и ждёт подтверждения.
    { name: "Асем Тулегенова", city: "Алматы", svc: "wm-repair", price: 25000, payout: 18000, desc: "Диагностика и замена насоса", min: 3000, deadline: soon(2), stage: "in_progress", ex: "ex-nurlan", via: "feed", src: "olx" },
    { name: "Олжас Нургалиев", city: "Алматы", svc: "ac-install", price: 36000, payout: 25000, desc: "Квартира, сплит-система 12 BTU", min: 90, deadline: at(1, 14), stage: "assigned", ex: "ex-nurlan", via: "manual", src: "phone" },
  ];
  fresh.forEach((f) => {
    const createdAt = ago(f.min);
    showcase.push({
      at: createdAt - 6 * MIN,
      build: (number) => {
        const client = makeClient(createdAt - 10 * MIN, { name: f.name, kind: f.kind, city: f.city, source: f.src });
        const lead: SeedLead = { id: id("l"), tenantId: TENANT, number, clientId: client.id, source: f.src, serviceId: f.svc, city: f.city, description: f.desc, urgency: f.prio ?? "normal", status: "converted", operatorId: r.pick(["u-madina", "u-erzhan"]), createdAt: iso(createdAt - 6 * MIN) };
        leads.push(lead);
        addInteractionsForLead(lead, client);
        const o = stagedOrder(
          { lead, client, serviceId: f.svc, city: f.city, address: client.address!, description: f.desc, source: f.src, priority: lead.urgency, createdAt, deadline: f.deadline, operatorId: lead.operatorId, clientPrice: f.price, payoutFixed: f.payout ?? Math.round((f.price * serviceById(f.svc).payoutPct) / 100 / 500) * 500 },
          number,
          f.stage,
          { executorId: f.ex, via: f.via },
        );
        lead.orderId = o.id;
      },
    });
  });

  // Нумерация сквозная и по времени: последний номер ≈ 1036, как на макетах.
  const all = [...drafts, ...showcase].sort((a, b) => a.at - b.at);
  const first = 1037 - all.length;
  all.forEach((d, i) => d.build(first + i));

  // Одна гарантированная просрочка — чтобы виджет «Требуют внимания» не пустовал.
  if (!orders.some((o) => ["in_progress", "awaiting_client", "accepted"].includes(o.status) && new Date(o.deadline).getTime() < now)) {
    const client = makeClient(now - 3 * DAY, { city: "Алматы" });
    const t = now - 2 * DAY;
    const dl = new Date(now - DAY + 2 * HOUR);
    const o = simulateOrder({ client, serviceId: "plumbing", city: "Алматы", address: client.address!, description: "Замена унитаза и смесителя", source: "olx", priority: "normal", createdAt: t, deadline: dl.getTime(), operatorId: "u-erzhan", clientPrice: 24000 }, 1037, { forceStuck: true });
    o.number = 1037;
  }

  // Уведомления.
  const lastLead = leads[leads.length - 1]!;
  const showcaseOrder = orders.find((o) => o.payoutValue === 20000 && o.clientPrice === 28000 && o.executorId === "ex-bekzat");
  const push = (userId: string, text: string, minAgo: number, tone: Notification["tone"], link?: string, read = false) =>
    notifications.push({ id: id("nt"), userId, text, link, at: iso(ago(minAgo)), read, tone });
  for (const uid of ["u-owner", "u-madina", "u-erzhan"]) {
    push(uid, `Новая заявка №${lastLead.number} из WhatsApp`, 22, "info", "/leads");
    if (showcaseOrder) push(uid, `Бекзат И. взял заказ №${showcaseOrder.number}`, 137, "ok", `/orders/${showcaseOrder.id}`);
    push(uid, "Салтанат К. ждёт обратного звонка", 200, "warn", "/leads", true);
  }
  orders
    .filter((o) => o.status === "awaiting_executor")
    .forEach((o) => {
      const svc = serviceById(o.serviceId);
      for (const e of executors) {
        if (e.city === o.city && e.categories.includes(svc.category)) {
          notifications.push({ id: id("nt"), userId: execUser(e.id), text: `Новый подходящий заказ №${o.number}: ${svc.label}`, link: "/w", at: o.createdAt, read: false, tone: "info" });
        }
      }
    });
  const nurlanAssigned = orders.find((o) => o.executorId === "ex-nurlan" && o.status === "assigned");
  if (nurlanAssigned) push("u-ex-nurlan", `Вам назначен заказ №${nurlanAssigned.number} — подтвердите`, 80, "warn", `/w/orders/${nurlanAssigned.id}`);

  history.sort((a, b) => a.at.localeCompare(b.at));
  messages.sort((a, b) => a.at.localeCompare(b.at));

  const clientById = new Map(clients.map((c) => [c.id, c]));
  const withClient = <T extends { clientId: string }>(x: T) => ({ ...x, clientName: clientById.get(x.clientId)!.name, clientPhone: clientById.get(x.clientId)!.phone });

  return {
    version: DB_VERSION,
    anchor: nowDate.toISOString(),
    seq: 1038,
    users,
    clients,
    leads: leads.map(withClient),
    orders: orders.map((o) => ({ ...withClient(o), category: serviceById(o.serviceId).category })),
    messages,
    history,
    executors,
    interactions,
    clientNotes,
    notifications,
  };
}
