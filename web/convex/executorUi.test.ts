/// <reference types="vite/client" />
// Правила интерфейса кабинета мастера (src/data/worker*.ts): ссылки наружу, статусы глазами мастера,
// лента без прыжков и разбор отказов сервера. Отказы проверяем на настоящих мутациях worker.*:
// если сервер поменяет текст ошибки, экран мастера не должен молча показать «что-то пошло не так».
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import type { WorkerOrder } from "../src/data/types";
import { money } from "../src/lib/format";
import { SUPPORT_TEL, mapAddress, telHref, twoGisUrl, yandexMapsUrl } from "../src/data/workerLinks";
import { clientShortName } from "../src/data/workerNames";
import { needsAction, payoutChip, refusalOf, sortActive, statusView, stepsOf } from "../src/data/workerStatus";
import {
  chipCounts,
  countUnseen,
  dueOn,
  feedRows,
  freshIds,
  isFresh,
  matchesFilter,
  readFeedParams,
  sortFeed,
  withExtras,
  writeFeedParams,
  type FeedItem,
} from "../src/data/workerFeed";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const NOW = Date.parse("2026-10-12T04:00:00.000Z"); // понедельник, 09:00 по Алматы
const H = 3600_000;

const order = (x: Partial<WorkerOrder> = {}): WorkerOrder => ({
  id: "o1",
  number: 1001,
  serviceId: "ac-repair",
  category: "ac",
  description: "",
  city: "Алматы",
  deadline: new Date(NOW + 5 * H).toISOString(),
  priority: "normal",
  status: "accepted",
  createdAt: "2026-10-01T05:00:00.000Z",
  payout: 10000,
  payoutPaid: false,
  files: [],
  ...x,
});

const item = (x: Partial<FeedItem> = {}): FeedItem => ({ ...order({ status: "awaiting_executor" }), publishedAt: new Date(NOW - 2 * H).toISOString(), photos: 0, ...x });

describe("ссылки наружу", () => {
  test("tel: из любого написания казахстанского номера", () => {
    expect(telHref("8 701 123 45 67")).toBe("tel:+77011234567");
    expect(telHref("+7 (701) 123-45-67")).toBe("tel:+77011234567");
    expect(telHref("7011234567")).toBe("tel:+77011234567");
    expect(telHref("77011234567")).toBe("tel:+77011234567");
    expect(telHref("103")).toBe("tel:103");
    expect(SUPPORT_TEL).toBe("tel:+77273450000");
  });

  test("адрес для карт без квартиры, подъезда, этажа и города в начале", () => {
    expect(mapAddress("Алматы", "мкр. Самал-2, д. 58, кв. 14, подъезд 2")).toBe("мкр. Самал-2, д. 58");
    expect(mapAddress("Алматы", "алматы, ул. Абая 10, офис 5")).toBe("ул. Абая 10");
    expect(mapAddress("Алматы", "ул. Сатпаева 30, этаж 5, домофон 14")).toBe("ул. Сатпаева 30");
    // «квартал» — часть адреса, а не квартира.
    expect(mapAddress("Алматы", "мкр. Аксай-4, квартал 3")).toBe("мкр. Аксай-4, квартал 3");
  });

  test("2ГИС открывает поиск в городе, неизвестный город — общим запросом; Яндекс — по тексту", () => {
    expect(twoGisUrl("Алматы", "Абая 10, кв. 3")).toBe("https://2gis.kz/almaty/search/%D0%90%D0%B1%D0%B0%D1%8F%2010");
    expect(twoGisUrl("Астана", "Кенесары 40")).toBe(`https://2gis.kz/astana/search/${encodeURIComponent("Кенесары 40")}`);
    expect(twoGisUrl("Талдыкорган", "Абая 10")).toBe(`https://2gis.kz/search/${encodeURIComponent("Талдыкорган, Абая 10")}`);
    expect(yandexMapsUrl("Алматы", "проспект Абая 10, кв. 3")).toBe(`https://yandex.kz/maps/?text=${encodeURIComponent("Алматы, проспект Абая 10")}`);
  });
});

describe("подписи", () => {
  test("клиент-человек — имя и инициал, компания — целиком (в том числе с кавычками-ёлочками)", () => {
    expect(clientShortName("Айсулу Нурланова")).toBe("Айсулу Н.");
    expect(clientShortName("ТОО «Ромашка»")).toBe("ТОО «Ромашка»");
    expect(clientShortName("ИП  Ахметов")).toBe("ИП Ахметов");
    expect(clientShortName("Ерлан")).toBe("Ерлан");
    // Имя, которое начинается с тех же букв, — не форма собственности.
    expect(clientShortName("Ипатий Петров")).toBe("Ипатий П.");
    expect(clientShortName("ТООшка Петров")).toBe("ТООшка П.");
  });
});

describe("статусы глазами мастера", () => {
  test("бейдж и подсказка; просрочка важнее статуса", () => {
    expect(statusView(order({ status: "assigned" }), NOW)).toMatchObject({ label: "Ждёт подтверждения", tone: "warn" });
    expect(statusView(order({ status: "awaiting_client" }), NOW)).toMatchObject({ label: "На паузе", tone: "orange" });
    expect(statusView(order({ status: "in_progress", deadline: new Date(NOW - H).toISOString() }), NOW)).toMatchObject({ label: "Просрочен", tone: "bad" });
    // У завершённого просрочки нет.
    expect(statusView(order({ status: "done", deadline: new Date(NOW - H).toISOString() }), NOW).label).toBe("Сдан");
    expect(statusView(order({ status: "paid", payout: 21000 }), NOW)).toMatchObject({ label: "Клиент оплатил", hint: `Клиент оплатил. Выплата ${money(21000)} — скоро.` });
    expect(statusView(order({ status: "closed", payoutPaid: true }), NOW).label).toBe("Выплачено");
  });

  test("шаги «Принят → В работе → Сдан → Выплачено»", () => {
    const states = (o: WorkerOrder) => stepsOf(o)?.map((s) => `${s.label}:${s.state}`);
    expect(states(order({ status: "assigned" }))).toEqual(["Подтвердите:current", "В работе:todo", "Сдан:todo", "Выплачено:todo"]);
    expect(states(order({ status: "in_progress" }))).toEqual(["Принят:done", "В работе:current", "Сдан:todo", "Выплачено:todo"]);
    expect(states(order({ status: "awaiting_client" }))).toEqual(["Принят:done", "Пауза:current", "Сдан:todo", "Выплачено:todo"]);
    expect(states(order({ status: "awaiting_payment" }))).toEqual(["Принят:done", "В работе:done", "Сдан:done", "Выплачено:current"]);
    expect(states(order({ status: "closed", payoutPaid: true }))).toEqual(["Принят:done", "В работе:done", "Сдан:done", "Выплачено:done"]);
    expect(stepsOf(order({ status: "cancelled" }))).toBeNull();
  });

  test("чип выплаты только у завершённых", () => {
    expect(payoutChip(order({ status: "in_progress" }))).toBeNull();
    expect(payoutChip(order({ status: "done" }))?.label).toBe("Ждёт оплаты клиента");
    expect(payoutChip(order({ status: "paid" }))?.label).toBe("К выплате");
    expect(payoutChip(order({ status: "closed", payoutPaid: true }))?.label).toBe("Выплачено");
    expect(payoutChip(order({ status: "cancelled" }))?.label).toBe("Отменён");
    expect(payoutChip(order({ status: "refund" }))?.label).toBe("Возврат");
  });

  test("«Активные»: ждёт подтверждения → просрочен → в работе → на паузе → принят; счётчик вкладки", () => {
    const list = [
      order({ id: "accepted", status: "accepted", deadline: new Date(NOW + H).toISOString() }),
      order({ id: "pause", status: "awaiting_client" }),
      order({ id: "work", status: "in_progress" }),
      order({ id: "late", status: "accepted", deadline: new Date(NOW - H).toISOString() }),
      order({ id: "assigned", status: "assigned", deadline: new Date(NOW + 9 * H).toISOString() }),
    ];
    expect(sortActive(list, NOW).map((o) => o.id)).toEqual(["assigned", "late", "work", "pause", "accepted"]);
    expect(needsAction(list, NOW)).toBe(2);
  });
});

describe("лента: фильтры, сортировка, метки", () => {
  test("«Сегодня» и «Завтра» — по Алматы, а не по UTC", () => {
    // 18:59 UTC 12 октября — ещё 23:59 12-го по Алматы; 19:00 UTC — уже 13-е.
    expect(dueOn("2026-10-12T18:59:00.000Z", "today", NOW)).toBe(true);
    expect(dueOn("2026-10-12T19:00:00.000Z", "today", NOW)).toBe(false);
    expect(dueOn("2026-10-12T19:00:00.000Z", "tomorrow", NOW)).toBe(true);
  });

  test("фильтры складываются, числа в чипах — по всей ленте", () => {
    const items = [
      item({ id: "a", priority: "urgent", deadline: "2026-10-12T10:00:00.000Z" }),
      item({ id: "b", category: "plumbing", deadline: "2026-10-13T10:00:00.000Z" }),
      item({ id: "c", priority: "urgent", category: "plumbing", deadline: "2026-10-13T05:00:00.000Z" }),
    ];
    const pick = (f: Parameters<typeof matchesFilter>[1]) => items.filter((o) => matchesFilter(o, f, NOW)).map((o) => o.id);
    expect(pick({ urgent: true, when: null, cat: null })).toEqual(["a", "c"]);
    expect(pick({ urgent: true, when: "tomorrow", cat: null })).toEqual(["c"]);
    expect(pick({ urgent: false, when: null, cat: "plumbing" })).toEqual(["b", "c"]);
    expect(chipCounts(items, NOW)).toEqual({ urgent: 2, today: 1, tomorrow: 2, byCat: { ac: 1, plumbing: 2 } });
  });

  test("сортировки: срочные, новые, дороже; при равенстве — по номеру", () => {
    const items = [
      item({ id: "n1", number: 3, priority: "normal", payout: 30000, deadline: "2026-10-12T08:00:00.000Z", publishedAt: "2026-10-12T03:00:00.000Z" }),
      item({ id: "u1", number: 2, priority: "urgent", payout: 10000, deadline: "2026-10-13T08:00:00.000Z", publishedAt: "2026-10-11T03:00:00.000Z" }),
      item({ id: "h1", number: 1, priority: "high", payout: 30000, deadline: "2026-10-12T07:00:00.000Z", publishedAt: "2026-10-12T03:30:00.000Z" }),
    ];
    expect(sortFeed(items, "urgent").map((o) => o.id)).toEqual(["u1", "h1", "n1"]);
    expect(sortFeed(items, "new").map((o) => o.id)).toEqual(["h1", "n1", "u1"]);
    expect(sortFeed(items, "pay").map((o) => o.id)).toEqual(["h1", "n1", "u1"]);
  });

  test("фильтры живут в адресе: туда и обратно, мусор — по умолчанию", () => {
    const f = { urgent: true, when: "today" as const, cat: "ac" };
    expect(readFeedParams(writeFeedParams(f, "pay"))).toEqual({ filter: f, sort: "pay" });
    expect(writeFeedParams({ urgent: false, when: null, cat: null }, "urgent").toString()).toBe("");
    expect(readFeedParams(new URLSearchParams("when=yesterday&sort=cheap&urgent=yes"))).toEqual({ filter: { urgent: false, when: null, cat: null }, sort: "urgent" });
  });

  test("«Новый» — меньше часа; счётчик вкладки — после последнего просмотра", () => {
    expect(isFresh(new Date(NOW - 59 * 60_000).toISOString(), NOW)).toBe(true);
    expect(isFresh(new Date(NOW - 61 * 60_000).toISOString(), NOW)).toBe(false);
    const published = [{ publishedAt: new Date(NOW - 10 * 60_000).toISOString() }, { publishedAt: new Date(NOW - 3 * H).toISOString() }];
    expect(countUnseen(published, null, NOW)).toBe(1);
    expect(countUnseen(published, NOW - 4 * H, NOW)).toBe(2);
    expect(countUnseen(published, NOW, NOW)).toBe(0);
  });

  test("список без прыжков: пропавший заказ — «надгробие» на своём месте, новые — за пилюлей", () => {
    const a = item({ id: "a", number: 1 });
    const c = item({ id: "c", number: 3 });
    const all = new Map([
      ["a", a],
      ["c", c],
    ]);
    const rows = feedRows(["a", "b", "c"], all, new Map([["b", 2]]));
    expect(rows).toEqual([
      { kind: "order", item: a },
      { kind: "gone", id: "b", number: 2 },
      { kind: "order", item: c },
    ]);
    expect(freshIds(["a", "b"], [{ id: "c" }, { id: "a" }, { id: "b" }])).toEqual(["c"]);
  });

  test("нет данных о публикации — считаем от создания заказа", () => {
    const [x] = withExtras([order({ id: "z", createdAt: "2026-10-10T00:00:00.000Z" })], [{ id: "other", publishedAt: "2026-10-11T00:00:00.000Z", photos: 1 }]);
    expect(x).toMatchObject({ id: "z", publishedAt: "2026-10-10T00:00:00.000Z", photos: 0 });
    expect(x!.thumbUrl).toBeUndefined();
  });
});

describe("отказы сервера понятны экрану мастера", () => {
  test("тексты worker.take / worker.act разбираются верно", async () => {
    const t = convexTest(schema, modules);
    const at = new Date().toISOString();
    const ids = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Владелец", email: "owner@test.kz", role: "owner", tenantId: "t", active: true });
      const mk = async (phone: string, available: boolean) => {
        const ex = await ctx.db.insert("executors", { tenantId: "t", name: `Мастер ${phone}`, phone, city: "Алматы", categories: ["ac"], skills: [], available, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
        const user = await ctx.db.insert("users", { name: `Мастер ${phone}`, email: phone, phone, role: "executor", executorId: ex, tenantId: "t", active: true });
        return { ex, user };
      };
      const a = await mk("77000000011", true);
      const b = await mk("77000000012", true);
      const off = await mk("77000000013", false);
      const client = await ctx.db.insert("clients", { tenantId: "t", name: "Клиент", kind: "person", phone: "77070000000", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
      const base = {
        tenantId: "t",
        clientId: client,
        clientName: "Клиент",
        clientPhone: "77070000000",
        source: "olx" as const,
        serviceId: "ac-repair",
        category: "ac",
        description: "",
        city: "Алматы",
        address: "Абая 1",
        deadline: new Date(Date.now() + 86400_000).toISOString(),
        priority: "normal" as const,
        status: "awaiting_executor" as const,
        clientPrice: 30000,
        payoutMode: "fixed" as const,
        payoutValue: 20000,
        payments: [],
        payoutPaid: false,
        createdAt: at,
        createdBy: owner,
        files: [],
      };
      const open = await ctx.db.insert("orders", { ...base, number: 1 });
      const other = await ctx.db.insert("orders", { ...base, number: 2 });
      const plumbing = await ctx.db.insert("orders", { ...base, number: 3, category: "plumbing", serviceId: "leak-fix" });
      return { a, b, off, open, other, plumbing };
    });
    const as = (userId: Id<"users">) => t.withIdentity({ subject: `${userId}|s` });
    const refusal = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        return refusalOf(e instanceof ConvexError && typeof e.data === "string" ? e.data : String(e));
      }
      throw new Error("ожидали отказ сервера");
    };

    expect(await refusal(as(ids.off.user).mutation(api.worker.take, { id: ids.open }))).toBe("off_shift");
    expect(await refusal(as(ids.a.user).mutation(api.worker.take, { id: ids.plumbing }))).toBe("not_fit");
    await as(ids.a.user).mutation(api.worker.take, { id: ids.open });
    expect(await refusal(as(ids.b.user).mutation(api.worker.take, { id: ids.open }))).toBe("taken");
    // Шаг не по порядку: «Продолжить» у принятого заказа.
    expect(await refusal(as(ids.a.user).mutation(api.worker.act, { id: ids.open, action: "resume" }))).toBe("changed");
    expect(await refusal(as(ids.b.user).mutation(api.worker.act, { id: ids.open, action: "start" }))).toBe("not_yours");
    // Мастер может написать оператору в свой заказ и не может — в чужой.
    await as(ids.a.user).mutation(api.orders.addMessage, { orderId: ids.open, text: "Буду через 15 минут", channel: "internal", files: [] });
    expect(await refusal(as(ids.a.user).mutation(api.orders.addMessage, { orderId: ids.other, text: "Привет", channel: "internal", files: [] }))).toBe("not_yours");
  });

  test("прочие тексты", () => {
    expect(refusalOf("Этот заказ уже ваш")).toBe("mine");
    expect(refusalOf("Заказ уже снят с ленты")).toBe("taken");
    expect(refusalOf("Сначала включите приём заказов в профиле")).toBe("off_shift");
    expect(refusalOf("Этот заказ вам не подходит (нет навыка: Чистка)")).toBe("not_fit");
    expect(refusalOf("Нет связи с сервером — проверьте интернет")).toBe("network");
    expect(refusalOf("Что-то пошло не так. Попробуйте ещё раз")).toBe("other");
  });
});
