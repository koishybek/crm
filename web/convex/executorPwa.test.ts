/// <reference types="vite/client" />
// Установка кабинета мастера на телефон (PWA) и полировка: кому и когда предлагаем установку (один раз,
// не во встроенном браузере Telegram), как ведёт себя системное окно, какая подсказка стоит над лентой
// и почему она не сдвигает список, что считается изменением выплаты, срока и адреса, и что манифест
// с иконками и index.html годятся для установки на Android и iPhone.
import { afterEach, describe, expect, test, vi } from "vitest";
import indexHtml from "../index.html?raw";
import manifestRaw from "../public/manifest.webmanifest?raw";
import {
  INSTALL_CARD_FROM_VISIT,
  installPlatform,
  installWay,
  isInAppBrowser,
  promptInstall,
  showInstallCard,
  useInstall,
  type InstallCardState,
  type InstallState,
} from "../src/data/workerInstall";
import { pickFeedHint, shownFeedHint, type FeedHintFlags } from "../src/data/workerFeed";
import { changeOf, parseSeen, pruneSeen, readSeen, SEEN_LIMIT, seenBase, seenOf, writeSeen, type SeenOrder, type SeenStore } from "../src/data/workerSeen";

const ICONS = import.meta.glob<string>("../public/icons/*.png", { query: "?inline", import: "default", eager: true });

const UA = {
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  iphoneChrome: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
  // Встроенный браузер приложения на iPhone (WKWebView): без «Safari/» в конце.
  iphoneWebView: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  instagram: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 390.0.0.27.80 (iPhone15,2; iOS 18_5; ru_RU; ru)",
  ipadDesktop: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 14; SM-A546B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  telegramAndroid:
    "Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 Telegram-Android/12.0.1 (Samsung SM-A546B; Android 14; SDK 34; AVERAGE)",
  windows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
};

const state = (x: Partial<InstallState> = {}): InstallState => ({ standalone: false, installed: false, canPrompt: false, platform: "android", ...x });

function memoryStorage(init: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(init));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

type Outcome = { outcome: "accepted" | "dismissed" };

/** Поддельный beforeinstallprompt: ответ пользователя приходит, когда тест вызовет answer(). */
function fakePrompt(fail = false) {
  let answer: (o: Outcome) => void = () => undefined;
  const userChoice = new Promise<Outcome>((resolve) => (answer = resolve));
  const prompt = vi.fn(async () => {
    if (fail) throw new Error("InvalidStateError");
  });
  return { event: Object.assign(new Event("beforeinstallprompt"), { prompt, userChoice }), prompt, answer: (o: Outcome["outcome"]) => answer({ outcome: o }) };
}

describe("установка на телефон: кому и как предлагаем", () => {
  test("платформа по userAgent: iPhone, iPad в режиме компьютера, Android, компьютер", () => {
    expect(installPlatform(UA.iphone, 5)).toBe("ios");
    expect(installPlatform(UA.ipadDesktop, 5)).toBe("ios");
    expect(installPlatform(UA.ipadDesktop, 0)).toBe("other"); // настоящий Mac без сенсорного экрана
    expect(installPlatform(UA.android, 5)).toBe("android");
    expect(installPlatform(UA.windows)).toBe("other");
  });

  test("уже установлено или открыто с иконки — не предлагаем нигде", () => {
    expect(installWay(state({ standalone: true, canPrompt: true }))).toBeNull();
    expect(installWay(state({ installed: true, platform: "ios" }))).toBeNull();
  });

  test("системное окно важнее инструкции; без него — инструкция для iPhone и Android, на компьютере — ничего", () => {
    expect(installWay(state({ canPrompt: true, platform: "other" }))).toBe("prompt");
    expect(installWay(state({ canPrompt: true, platform: "android" }))).toBe("prompt");
    expect(installWay(state({ platform: "ios" }))).toBe("ios");
    expect(installWay(state({ platform: "android" }))).toBe("android");
    expect(installWay(state({ platform: "other" }))).toBeNull();
  });

  test("встроенный браузер Telegram, Instagram и других приложений распознаём: «На экран „Домой“» там нет", () => {
    expect(isInAppBrowser(UA.iphone)).toBe(false);
    expect(isInAppBrowser(UA.iphoneChrome)).toBe(false); // Chrome на iPhone ставит из «Поделиться» (iOS 16.4+)
    expect(isInAppBrowser(UA.ipadDesktop)).toBe(false);
    expect(isInAppBrowser(UA.android)).toBe(false);
    expect(isInAppBrowser(UA.windows)).toBe(false);
    expect(isInAppBrowser(UA.iphoneWebView)).toBe(true);
    expect(isInAppBrowser(UA.instagram)).toBe(true);
    expect(isInAppBrowser(UA.telegramAndroid)).toBe(true);
  });

  test("карточка в ленте — один раз: с третьего захода, только на телефоне в браузере", () => {
    const card = (x: Partial<InstallCardState> = {}) => showInstallCard({ way: "prompt", platform: "android", inApp: false, visits: INSTALL_CARD_FROM_VISIT, hint: "new", ...x });
    expect(card()).toBe(true);
    expect(card({ way: "ios", platform: "ios" })).toBe(true);
    // Показана в этот заход — видна до «Скрыть», не пропадает при переходах между вкладками.
    expect(card({ hint: "showing" })).toBe(true);
    // Показана в прошлый заход, скрыта или уже нажали «Установить» — больше не показываем.
    expect(card({ hint: "done" })).toBe(false);
    expect(card({ way: "ios", platform: "ios", hint: "done" })).toBe(false);
    expect(card({ visits: INSTALL_CARD_FROM_VISIT - 1 })).toBe(false);
    // Внутри Telegram на iPhone инструкция «Поделиться → На экран „Домой“» не сработает.
    expect(card({ way: "ios", platform: "ios", inApp: true })).toBe(false);
    // Android без системного окна: инструкция только в профиле, в ленте не зовём.
    expect(card({ way: "android" })).toBe(false);
    // Компьютер: установка есть в профиле, карточка «на телефон» не к месту.
    expect(card({ platform: "other" })).toBe(false);
    expect(card({ way: null })).toBe(false);
  });
});

describe("подсказки над лентой: одна за раз и без прыжков списка", () => {
  const flags = (x: Partial<FeedHintFlags> = {}): FeedHintFlags => ({ telegram: false, howto: false, install: false, ...x });

  test("по важности: Telegram, затем «Как брать заказы», затем установка", () => {
    expect(pickFeedHint(flags({ telegram: true, howto: true, install: true }))).toBe("telegram");
    expect(pickFeedHint(flags({ howto: true, install: true }))).toBe("howto");
    expect(pickFeedHint(flags({ install: true }))).toBe("install");
    expect(pickFeedHint(flags())).toBeNull();
  });

  test("выбранная подсказка исчезает, когда не нужна, но другая на её место не встаёт", () => {
    expect(shownFeedHint("telegram", flags({ telegram: true, install: true }))).toBe("telegram");
    // Скрыли баннер Telegram — установку в этот раз не показываем, она подождёт следующего открытия ленты.
    expect(shownFeedHint("telegram", flags({ install: true }))).toBeNull();
  });

  test("предложение установки, пришедшее после открытия ленты, карточку не вставляет", () => {
    const atOpen = pickFeedHint(flags());
    expect(shownFeedHint(atOpen, flags({ install: true }))).toBeNull();
  });
});

describe("системное окно установки", () => {
  afterEach(() => useInstall.setState({ prompt: null, installed: false }));

  test("согласился — приложение установлено, предложение и строка в профиле исчезают", async () => {
    const f = fakePrompt();
    useInstall.setState({ prompt: f.event });
    const result = promptInstall();
    f.answer("accepted");
    expect(await result).toBe("accepted");
    expect(f.prompt).toHaveBeenCalledTimes(1);
    expect(useInstall.getState()).toMatchObject({ prompt: null, installed: true });
  });

  test("отказался — событие использовано (оно одноразовое), приложение не установлено", async () => {
    const f = fakePrompt();
    useInstall.setState({ prompt: f.event });
    const result = promptInstall();
    f.answer("dismissed");
    expect(await result).toBe("dismissed");
    expect(useInstall.getState()).toMatchObject({ prompt: null, installed: false });
  });

  test("второе нажатие, пока окно открыто, не открывает его ещё раз", async () => {
    const f = fakePrompt();
    useInstall.setState({ prompt: f.event });
    const first = promptInstall();
    expect(await promptInstall()).toBe("busy");
    f.answer("accepted");
    expect(await first).toBe("accepted");
    expect(f.prompt).toHaveBeenCalledTimes(1);
  });

  test("предложение браузера ловим с запуска: мини-панель браузера не показываем, событие бережём до нажатия", async () => {
    const win = new EventTarget();
    vi.stubGlobal("window", win);
    vi.resetModules();
    try {
      const m = await import("../src/data/workerInstall");
      m.listenForInstall();
      m.listenForInstall(); // каркас смонтировался ещё раз — второй обработчик не вешаем
      win.dispatchEvent(new Event("beforeinstallprompt")); // без prompt() — не предложение установки
      expect(m.useInstall.getState().prompt).toBeNull();

      const f = fakePrompt();
      const preventDefault = vi.spyOn(f.event, "preventDefault");
      win.dispatchEvent(f.event);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(m.useInstall.getState().prompt).toBe(f.event);

      // Установили из меню браузера — предложение больше не нужно.
      win.dispatchEvent(new Event("appinstalled"));
      expect(m.useInstall.getState()).toMatchObject({ prompt: null, installed: true });
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });

  test("окно не открылось — «unavailable», событие сброшено; без события — тоже «unavailable»", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const f = fakePrompt(true);
      useInstall.setState({ prompt: f.event });
      expect(await promptInstall()).toBe("unavailable");
      expect(useInstall.getState().prompt).toBeNull();
      expect(await promptInstall()).toBe("unavailable");
    } finally {
      warn.mockRestore();
    }
  });
});

const seen = (x: Partial<SeenOrder> = {}): SeenOrder => ({ payout: 21000, deadline: "2026-10-12T09:00:00.000Z", address: "мкр. Самал-2, д. 58, кв. 14", ...x });

describe("плашки «Оплата изменилась», «Срок изменён», «Адрес изменён»", () => {
  test("выплата важнее срока и адреса, показываем «было → стало»", () => {
    expect(changeOf(seen(), seen({ payout: 18000, deadline: "2026-10-13T09:00:00.000Z", address: "ул. Абая, 10" }), true)).toEqual({ kind: "payout", before: 21000, after: 18000 });
  });

  test("срок: другой момент — изменение; тот же момент в другой записи — нет", () => {
    expect(changeOf(seen(), seen({ deadline: "2026-10-12T11:00:00.000Z" }), true)).toEqual({ kind: "deadline", after: "2026-10-12T11:00:00.000Z" });
    expect(changeOf(seen(), seen({ deadline: "2026-10-12T09:00:00Z" }), true)).toBeNull();
  });

  test("адрес: открылся после подтверждения — не изменение; изменился уже открытый — изменение", () => {
    expect(changeOf(seen({ address: null }), seen(), true)).toBeNull();
    expect(changeOf(seen(), seen({ address: "ул. Абая, 10" }), true)).toEqual({ kind: "address" });
    expect(changeOf(seen(), seen({ address: null }), true)).toBeNull();
  });

  test("у завершённого заказа срок и адрес не важны, а выплата — важна", () => {
    expect(changeOf(seen(), seen({ deadline: "2026-10-14T09:00:00.000Z", address: "ул. Абая, 10" }), false)).toBeNull();
    expect(changeOf(seen(), seen({ payout: 25000 }), false)).toEqual({ kind: "payout", before: 21000, after: 25000 });
  });

  test("заказ открыт впервые: сравниваем с тем, что на экране, — правка оператора, пока экран открыт, сразу видна", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    try {
      const onScreen = seen();
      const base = seenBase("o9", onScreen);
      expect(base).toEqual(onScreen);
      expect(changeOf(base, seen({ payout: 18000 }), true)).toEqual({ kind: "payout", before: 21000, after: 18000 });
      // Уже видел заказ раньше — сравниваем с прошлым просмотром.
      writeSeen("o9", seen({ payout: 25000 }));
      expect(seenBase("o9", onScreen)).toEqual(seen({ payout: 25000 }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("снимок заказа: пустой адрес — «скрыт», пробелы по краям не считаются изменением", () => {
    expect(seenOf({ payout: 1, deadline: "2026-10-12T09:00:00.000Z", address: "  " }).address).toBeNull();
    expect(seenOf({ payout: 1, deadline: "2026-10-12T09:00:00.000Z" }).address).toBeNull();
    expect(changeOf(seen(), seenOf({ ...seen(), address: ` ${seen().address} ` }), true)).toBeNull();
  });
});

describe("память на этом устройстве", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  test("повреждённое хранилище не ломает экран: битые записи пропускаем", () => {
    expect(parseSeen(null)).toEqual({});
    expect(parseSeen("{не json")).toEqual({});
    expect(parseSeen("[1,2]")).toEqual({});
    const good = { ...seen(), at: 5 };
    expect(parseSeen(JSON.stringify({ bad: { payout: "1" }, also: null, good }))).toEqual({ good });
  });

  test(`храним не больше ${SEEN_LIMIT} последних заказов`, () => {
    const store: SeenStore = Object.fromEntries(Array.from({ length: SEEN_LIMIT + 5 }, (_, i) => [`o${i}`, { ...seen(), at: i }]));
    const pruned = pruneSeen(store);
    expect(Object.keys(pruned)).toHaveLength(SEEN_LIMIT);
    expect(pruned.o0).toBeUndefined();
    expect(pruned[`o${SEEN_LIMIT + 4}`]).toBeDefined();
  });

  test("снимок заказа: запись, чтение и перезапись по «Понятно»", () => {
    vi.stubGlobal("localStorage", memoryStorage());
    expect(readSeen("o1")).toBeNull();
    writeSeen("o1", seen());
    writeSeen("o2", seen({ payout: 5000 }));
    writeSeen("o1", seen({ payout: 18000 }));
    expect(readSeen("o1")).toEqual(seen({ payout: 18000 }));
    expect(readSeen("o2")).toEqual(seen({ payout: 5000 }));
  });

  test("без localStorage (приватный режим) ничего не падает", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => writeSeen("o1", seen())).not.toThrow();
    expect(readSeen("o1")).toBeNull();
  });

  test("заход в кабинет считается один раз за загрузку страницы и продолжает старый счёт", async () => {
    vi.stubGlobal("localStorage", memoryStorage({ "hm.visits": "2" }));
    vi.resetModules();
    const { useWorkerPrefs } = await import("../src/data/workerPrefs");
    expect(useWorkerPrefs.getState().visits).toBe(2);
    useWorkerPrefs.getState().countVisit();
    useWorkerPrefs.getState().countVisit(); // повторный монтаж каркаса — не новый заход
    expect(useWorkerPrefs.getState().visits).toBe(3);
    expect(localStorage.getItem("hm.visits")).toBe("3");
  });

  test("подсказка об установке — один раз: в этот заход видна до «Скрыть», в следующий заход её нет", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
    const first = (await import("../src/data/workerPrefs")).useWorkerPrefs;
    expect(first.getState().installHint).toBe("new");
    first.getState().showInstallHint(1_700_000_000_000);
    first.getState().showInstallHint(1_700_000_500_000); // показ ещё раз (другая вкладка, повторный монтаж) — ничего не меняет
    expect(first.getState().installHint).toBe("showing");
    expect(localStorage.getItem("hm.installHintAt")).toBe("1700000000000");

    vi.resetModules();
    const next = (await import("../src/data/workerPrefs")).useWorkerPrefs;
    expect(next.getState().installHint).toBe("done");
  });

  test("«Скрыть» и «Установить» убирают подсказку сразу и навсегда; «Как брать заказы» тоже запоминается", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.resetModules();
    const first = (await import("../src/data/workerPrefs")).useWorkerPrefs;
    first.getState().closeInstallHint(1_700_000_000_000);
    first.getState().showInstallHint(1_700_000_100_000); // после «Скрыть» показ уже не возвращает подсказку
    first.getState().finishOnboarding();
    expect(first.getState().installHint).toBe("done");

    vi.resetModules();
    const next = (await import("../src/data/workerPrefs")).useWorkerPrefs;
    expect(next.getState()).toMatchObject({ installHint: "done", onboarded: true });
  });

  test("без localStorage (приватный режим) подсказка всё равно закрывается до перезагрузки страницы", async () => {
    vi.stubGlobal("localStorage", undefined);
    vi.resetModules();
    const prefs = (await import("../src/data/workerPrefs")).useWorkerPrefs;
    expect(prefs.getState().installHint).toBe("new");
    expect(() => prefs.getState().showInstallHint(1)).not.toThrow();
    expect(prefs.getState().installHint).toBe("showing");
    prefs.getState().closeInstallHint(2);
    expect(prefs.getState().installHint).toBe("done");
  });
});

/** Ширина, высота и есть ли прозрачность — из заголовка PNG (IHDR). */
function pngInfo(dataUri: string): { width: number; height: number; alpha: boolean } {
  const bytes = Uint8Array.from(atob(dataUri.split(",")[1] ?? ""), (c) => c.charCodeAt(0));
  expect(String.fromCharCode(...bytes.slice(12, 16))).toBe("IHDR");
  const view = new DataView(bytes.buffer);
  const colorType = bytes[25];
  return { width: view.getUint32(16), height: view.getUint32(20), alpha: colorType === 4 || colorType === 6 };
}

const iconAt = (src: string): string => {
  const data = ICONS[`../public${src}`];
  if (!data) throw new Error(`нет файла public${src}`);
  return data;
};

describe("манифест и иконки для установки (Android, iPhone)", () => {
  const manifest: unknown = JSON.parse(manifestRaw);

  test("приложение называется Home Max, открывается кабинетом мастера, без адресной строки", () => {
    expect(manifest).toMatchObject({ id: "/", name: "Home Max Service", short_name: "Home Max", lang: "ru", start_url: "/w", scope: "/", display: "standalone", background_color: "#F7F6F2", theme_color: "#FFFFFF" });
    expect(manifest).not.toHaveProperty("prefer_related_applications", true);
  });

  test("иконки 192, 512 и maskable 512 есть и совпадают с заявленными размерами", () => {
    const icons = (manifest as { icons: { src: string; sizes: string; type: string; purpose: string }[] }).icons;
    const find = (sizes: string, purpose: string) => icons.find((i) => i.sizes === sizes && i.purpose === purpose);
    expect(find("192x192", "any")).toBeDefined();
    expect(find("512x512", "any")).toBeDefined();
    expect(find("512x512", "maskable")).toBeDefined();
    for (const icon of icons) {
      expect(icon.type).toBe("image/png");
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngInfo(iconAt(icon.src))).toMatchObject({ width: w, height: h });
    }
    // Maskable обрезается системой по кругу или «капле» — фон должен быть сплошным.
    expect(pngInfo(iconAt(find("512x512", "maskable")!.src)).alpha).toBe(false);
  });

  test("index.html: манифест, цвет шапки как в манифесте, иконка для iPhone 180×180 без прозрачности", () => {
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(indexHtml).toContain(`<meta name="theme-color" content="${(manifest as { theme_color: string }).theme_color}" />`);
    const apple = /<link rel="apple-touch-icon" href="([^"]+)"/.exec(indexHtml)?.[1];
    expect(apple).toBeDefined();
    expect(pngInfo(iconAt(apple!))).toEqual({ width: 180, height: 180, alpha: false });
  });

  test("описание страницы (его видно в превью ссылки в Telegram) — как в манифесте, без «CRM» и «исполнитель»", () => {
    const description = /<meta name="description" content="([^"]+)"/.exec(indexHtml)?.[1] ?? "";
    expect(description).toBe((manifest as { description: string }).description);
    expect(description).not.toMatch(/CRM|исполнител/i);
  });

  test("viewport: клавиатура сжимает экран, масштаб не запрещён", () => {
    const viewport = /<meta name="viewport" content="([^"]+)"/.exec(indexHtml)?.[1] ?? "";
    expect(viewport).toContain("interactive-widget=resizes-content");
    expect(viewport).toContain("viewport-fit=cover");
    expect(viewport).not.toMatch(/maximum-scale|user-scalable\s*=\s*no/);
  });
});
