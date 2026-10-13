// Иконки приложения для установки на телефон (PWA) из знака бренда public/favicon.svg:
//   node scripts/make-icons.mjs
// Знак рисуется в безголовом Chrome и сохраняется в public/icons. Разовый скрипт: зависимостей в проект
// не добавляет — playwright-core берётся из временной папки, браузер — установленный Chrome
// (пути можно переопределить переменными PLAYWRIGHT_CORE и CHROME).
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ??
  "C:/Users/koish/AppData/Local/Temp/claude/c--Users-koish-OneDrive--------------job-projects-OLX-CRM/16ae2b55-b948-4208-a184-3b10e5ef60e1/scratchpad/pw/node_modules/playwright-core/index.mjs";
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const PUBLIC = new URL("../public/", import.meta.url);
const OUT = new URL("icons/", PUBLIC);

// Шестиугольник в координатах favicon.svg (viewBox 0 0 32 32): высота 27 (от 2,5 до 29,5), центр — (16, 16).
const MARK_HEIGHT = 27;
const MARK_CENTER = 16;
const DARK = "#1c1c1e";

/**
 * logo — доля высоты иконки под знак.
 * Обычные иконки: прозрачный фон, поля по 8%. Maskable: всё важное — в круге радиусом 40% от центра
 * (web.dev/articles/maskable-icon), поэтому знак не выше 60% стороны. Apple — тёмный фон без прозрачности;
 * iOS не обрезает иконку кругом, а только скругляет углы, поэтому знак крупнее, чем в maskable.
 */
const ICONS = [
  { file: "icon-192.png", size: 192, logo: 0.84, background: null },
  { file: "icon-512.png", size: 512, logo: 0.84, background: null },
  { file: "maskable-512.png", size: 512, logo: 0.6, background: DARK },
  { file: "apple-touch-icon-180.png", size: 180, logo: 0.7, background: DARK },
];

const favicon = await readFile(new URL("favicon.svg", PUBLIC), "utf8");
const mark = favicon.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
if (!mark.includes("<path")) throw new Error("В public/favicon.svg не найден знак бренда");

function iconSvg({ size, logo, background }) {
  const scale = (size * logo) / MARK_HEIGHT;
  const shift = size / 2 - MARK_CENTER * scale;
  const fill = background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="display:block">${fill}<g transform="translate(${shift} ${shift}) scale(${scale})">${mark}</g></svg>`;
}

const { chromium } = await import(pathToFileURL(PLAYWRIGHT_CORE).href);
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of ICONS) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${iconSvg(icon)}</body></html>`);
    await page.screenshot({ path: fileURLToPath(new URL(icon.file, OUT)), omitBackground: !icon.background, clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
    console.log(`icons/${icon.file} — ${icon.size}×${icon.size}`);
  }
} finally {
  await browser.close();
}
