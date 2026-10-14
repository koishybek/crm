// @vitest-environment node
// Service worker (public/sw.js, ТЗ п.23.6): офлайн-оболочка и показ уведомлений. Запускаем сам файл с заглушками
// self/caches/fetch: страницы — из сети, без сети — «Нет связи»; файлы сборки — из кеша; данные не перехватываются;
// уведомление открывает только путь внутри приложения.
import { beforeEach, describe, expect, test, vi } from "vitest";
import swSource from "../../public/sw.js?raw";
import { pushMessage, PUSH_BODY_MAX } from "./push";
import { ignoredError, scrubErrorPath } from "./clientErrors";
import { retentionLabel, retentionProblem } from "./retention";

type Handler = (e: Record<string, unknown>) => void;

function loadSw(fetchImpl: (req: Request | string) => Promise<Response>) {
  const handlers: Record<string, Handler> = {};
  const store = new Map<string, Map<string, Response>>();
  const key = (r: Request | string) => (typeof r === "string" ? new URL(r, "https://app.test").href : r.url);
  const cacheOf = (name: string) => {
    if (!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      put: async (r: Request | string, res: Response) => void m.set(key(r), res),
      match: async (r: Request | string) => m.get(key(r))?.clone(),
      keys: async () => [...m.keys()].map((u) => new Request(u)),
      delete: async (r: Request | string) => m.delete(key(r)),
      addAll: async () => undefined,
    };
  };
  const caches = {
    open: async (name: string) => cacheOf(name),
    match: async (r: Request | string, o?: { cacheName?: string }) => (o?.cacheName ? store.get(o.cacheName)?.get(key(r))?.clone() : undefined),
    keys: async () => [...store.keys()],
    delete: async (n: string) => store.delete(n),
  };
  const shown: { title: string; options: { body: string; data: { link: string } } }[] = [];
  const opened: string[] = [];
  const self = {
    location: new URL("https://app.test/"),
    addEventListener: (type: string, fn: Handler) => void (handlers[type] = fn),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined, matchAll: async () => [], openWindow: async (u: string) => void opened.push(u) },
    registration: { showNotification: async (title: string, options: (typeof shown)[number]["options"]) => void shown.push({ title, options }) },
  };
  new Function("self", "caches", "fetch", swSource)(self, caches, fetchImpl);
  /** Отправить событие; вернуть то, что передали в respondWith/waitUntil (или undefined — не перехвачено). */
  const fire = async (type: string, extra: Record<string, unknown>): Promise<unknown> => {
    let result: Promise<unknown> | undefined;
    handlers[type]!({ ...extra, respondWith: (p: Promise<unknown>) => void (result = p), waitUntil: (p: Promise<unknown>) => void (result = p) });
    return result ? await result : undefined;
  };
  return { fire, store, shown, opened };
}

/** Переход по странице: у Request из конструктора mode не «navigate» — подставляем как браузер. */
const nav = (path: string) => ({ request: { method: "GET", url: `https://app.test${path}`, mode: "navigate" } });

describe("офлайн-оболочка", () => {
  let online: boolean;
  const fetchStub = vi.fn(async (req: Request | string) => {
    if (!online) throw new TypeError("Failed to fetch");
    const url = typeof req === "string" ? req : req.url;
    return url.includes("/assets/") ? new Response("js", { headers: { "Content-Type": "text/javascript" } }) : new Response("<html>app</html>", { headers: { "Content-Type": "text/html" } });
  });
  beforeEach(() => {
    online = true;
    fetchStub.mockClear();
  });

  test("страница — из сети и сохраняется; без сети — экран «Нет связи»", async () => {
    const sw = loadSw(fetchStub);
    const res = (await sw.fire("fetch", nav("/orders"))) as Response;
    expect(await res.text()).toBe("<html>app</html>");
    expect(sw.store.get("hms-shell-v1")?.has("https://app.test/index.html")).toBe(true);
    online = false;
    const off = (await sw.fire("fetch", nav("/orders"))) as Response;
    expect(off.status).toBe(503);
    expect(await off.text()).toContain("Нет связи");
  });

  test("файлы сборки — из кеша после первой загрузки; запросы к данным не перехватываются", async () => {
    const sw = loadSw(fetchStub);
    const req = { request: new Request("https://app.test/assets/index-abc.js") };
    await sw.fire("fetch", req);
    online = false;
    expect(await ((await sw.fire("fetch", req)) as Response).text()).toBe("js");
    expect(await sw.fire("fetch", { request: new Request("https://fleet-weasel-433.convex.cloud/api/query") })).toBeUndefined();
    expect(await sw.fire("fetch", { request: new Request("https://app.test/api/v1/leads", { method: "POST" }) })).toBeUndefined();
  });
});

describe("уведомления", () => {
  test("push показывает текст; нажатие открывает путь внутри приложения, внешний адрес — нет", async () => {
    const sw = loadSw(async () => new Response(""));
    await sw.fire("push", { data: { json: () => ({ title: "Home Max Service", body: "Новый заказ", link: "/w/orders/1" }), text: () => "" } });
    expect(sw.shown[0]).toMatchObject({ title: "Home Max Service", options: { body: "Новый заказ", data: { link: "/w/orders/1" } } });
    await sw.fire("push", { data: { json: () => ({ body: "x", link: "https://evil.test" }), text: () => "" } });
    expect(sw.shown[1]?.options.data.link).toBe("/");
    await sw.fire("notificationclick", { notification: { close: () => undefined, data: { link: "//evil.test/x" } } });
    expect(sw.opened).toEqual(["/"]);
  });

  test("сообщение для push: длинный текст обрезается, ссылка — только относительная", () => {
    expect(pushMessage("a".repeat(1000), "/orders/1").body).toHaveLength(PUSH_BODY_MAX);
    expect(pushMessage("Заказ", "https://evil.test")).not.toHaveProperty("link");
    expect(pushMessage("Заказ", "//evil.test")).not.toHaveProperty("link");
  });
});

describe("правила надёжности", () => {
  test("ошибки расширений и кросс-доменные «Script error.» не отправляются; путь — без параметров", () => {
    expect(ignoredError("Script error.")).toBe(true);
    expect(ignoredError("Error", "chrome-extension://abc/x.js")).toBe(true);
    expect(ignoredError("ResizeObserver loop completed with undelivered notifications.")).toBe(true);
    expect(ignoredError("TypeError: x is undefined", "https://app.test/assets/index.js")).toBe(false);
    expect(scrubErrorPath("/clients/abc?phone=7701#x")).toBe("/clients/abc");
    expect(scrubErrorPath("javascript:alert(1)")).toBe("/");
  });

  test("срок хранения: 0 — бессрочно, от 0 до 3650 целым", () => {
    expect(retentionLabel(0)).toBe("бессрочно");
    expect(retentionLabel(365)).toBe("365 дней");
    expect(retentionLabel(31)).toBe("31 день");
    expect(retentionLabel(22)).toBe("22 дня");
    expect(retentionProblem(3650)).toBeNull();
    expect(retentionProblem(3651)).not.toBeNull();
    expect(retentionProblem(1.5)).not.toBeNull();
  });
});
