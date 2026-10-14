// Общее для браузерных проверок: адрес, пароль демо-аккаунтов, Chrome, вход с повторами.
// BASE — сайт (по умолчанию локальный Vite), E2E_PASSWORD — пароль демо-аккаунтов (как DEMO_PASSWORD при заливке),
// CHROME — путь к Chrome (по умолчанию — стандартный для Windows / macOS / Linux).
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const BASE = process.env.BASE ?? "http://localhost:5190";
export const PASS = process.env.E2E_PASSWORD ?? process.env.DEMO_PASSWORD ?? "";
export const OUT = process.env.E2E_OUT ?? fileURLToPath(new URL("./out/", import.meta.url));
if (!PASS) throw new Error("Задайте E2E_PASSWORD — пароль демо-аккаунтов");
mkdirSync(OUT, { recursive: true });

const CHROME_PATHS = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

export async function launch() {
  const executablePath = process.env.CHROME ?? CHROME_PATHS.find((p) => existsSync(p));
  if (!executablePath) throw new Error("Не найден Chrome — укажите путь в CHROME");
  return chromium.launch({ executablePath, headless: true });
}

/** Новая вкладка со сбором ошибок страницы и консоли (ConvexError — ожидаемые ответы сервера, их не считаем). */
export async function page(browser, vp, errors, who = "") {
  const p = await (await browser.newContext({ viewport: vp, locale: "ru-RU" })).newPage();
  p.setDefaultTimeout(20000);
  p.on("pageerror", (e) => errors.push(`[${who}] ${e.message.slice(0, 160)}`));
  p.on("console", (m) => {
    const t = m.text();
    if (m.type() === "error" && !/ConvexError|favicon|Failed to load resource|Download the React/.test(t)) errors.push(`[${who}] ${t.slice(0, 160)}`);
  });
  return p;
}

/** Вход; первый запуск Vite и перевыкладка функций бывают медленными — до трёх попыток. */
export async function login(p, who) {
  for (let attempt = 1; ; attempt++) {
    try {
      await p.goto(BASE + "/login", { waitUntil: "domcontentloaded", timeout: 60000 });
      await p.locator("#email").fill(who);
      await p.locator('input[type="password"]').fill(PASS);
      await p.getByRole("button", { name: /Войти/ }).click();
      await p.waitForFunction(() => location.pathname !== "/login", null, { timeout: 45000 });
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await p.waitForTimeout(5000);
    }
  }
}
