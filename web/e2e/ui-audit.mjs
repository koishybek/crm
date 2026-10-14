// Обход всех экранов по ролям и размерам экрана: ошибки консоли, горизонтальная прокрутка, содержимое, которое не
// влезает и не прокручивается (как сайдбар), обрезанный текст без многоточия, мелкие кнопки на телефоне. Скриншоты — в OUT.
// Запуск: E2E_PASSWORD=… [BASE=…] [ONLY=owner-phone] npm run e2e:audit — нужны демо-данные (npm run seed). Выход ≠ 0 при замечаниях.
import { BASE, OUT, launch, login, page } from "./common.mjs";
const ONLY = process.env.ONLY; // фильтр по имени набора
const browser = await launch();
const STAFF = ["/", "/leads", "/calls", "/inbox", "/orders", "/orders?view=archive", "/clients", "/executors", "/payouts", "/analytics", "/audit", "/settings", "/platform"];
const SETS = [
  { name: "owner-laptop", who: "alikhan@homemax.kz", vp: { width: 1366, height: 768 }, paths: [...STAFF, "@order", "@client", "@executor", "@lead"] },
  { name: "owner-small", who: "alikhan@homemax.kz", vp: { width: 1280, height: 650 }, paths: ["/", "/settings"] },
  { name: "owner-phone", who: "alikhan@homemax.kz", vp: { width: 390, height: 844 }, paths: [...STAFF, "@order", "@client", "@executor", "@lead", "@menu"] },
  { name: "owner-tablet", who: "alikhan@homemax.kz", vp: { width: 820, height: 1180 }, paths: ["/", "/orders", "/analytics", "/settings", "@order"] },
  { name: "operator-laptop", who: "madina@homemax.kz", vp: { width: 1366, height: 768 }, paths: ["/", "/leads", "/orders", "/inbox", "@order"] },
  { name: "manager-laptop", who: "erlan@homemax.kz", vp: { width: 1366, height: 768 }, paths: ["/", "/orders", "/analytics", "@order"] },
  { name: "master-phone", who: "77011234567", vp: { width: 360, height: 740 }, paths: ["/w", "/w/my", "/w/income", "/w/profile", "@worder"] },
  { name: "master-desktop", who: "77011234567", vp: { width: 1366, height: 768 }, paths: ["/w", "/w/my", "/w/profile"] },
  { name: "public", who: null, vp: { width: 390, height: 844 }, paths: ["/login", "/zayavka", "/register", "/help", "/privacy", "/offer"] },
];
const report = [];
async function probe(p, label, phone) {
  await p.waitForTimeout(2200);
  const r = await p.evaluate((phone) => {
    const out = { hScroll: document.documentElement.scrollWidth - innerWidth, stuck: [], clipped: [], tiny: [] };
    const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
    const name = (e) => (e.getAttribute("aria-label") || e.innerText || e.className || e.tagName).toString().trim().replace(/\s+/g, " ").slice(0, 50);
    for (const e of document.querySelectorAll("body *")) {
      const cs = getComputedStyle(e);
      if (!vis(e)) continue;
      // Скрытые подписи для экранных чтецов (sr-only: 1×1, clip) — не текст на экране.
      const bb = e.getBoundingClientRect();
      if (bb.width <= 2 || bb.height <= 2 || cs.clip !== "auto" && cs.clip !== "" || /sr-only/.test(e.className)) continue;
      // Содержимое выше контейнера, а прокрутки нет (и контейнер не обрезан намеренно маленьким: >120px).
      if (e.scrollHeight > e.clientHeight + 4 && e.clientHeight > 120 && (cs.position === "fixed" || cs.position === "sticky" || e.tagName === "ASIDE" || e.tagName === "NAV") && !/(auto|scroll)/.test(cs.overflowY))
        out.stuck.push(`${e.tagName.toLowerCase()} «${name(e)}» ${e.scrollHeight}>${e.clientHeight}`);
      // Текст не влезает по ширине, обрезан без многоточия.
      if (e.children.length === 0 && e.innerText && e.scrollWidth > e.clientWidth + 2 && cs.overflowX !== "visible" && cs.textOverflow !== "ellipsis" && !/(auto|scroll)/.test(cs.overflowX))
        out.clipped.push(`«${name(e)}»`);
      if (phone && /^(BUTTON|A)$/.test(e.tagName) || (phone && e.getAttribute("role") === "button")) {
        const b = e.getBoundingClientRect();
        if (b.height < 32 && b.width < 32 && !e.closest("table") && !e.classList.contains("hit")) out.tiny.push(`«${name(e)}» ${Math.round(b.width)}×${Math.round(b.height)}`);
      }
    }
    // Элементы за правым краем экрана (вылезают на телефоне).
    out.offscreen = [...document.querySelectorAll("button, a, input, h1, h2, h3")].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 2 && !e.closest(".scroll-x, [class*=overflow-x], [class*=overflow-auto]"); }).slice(0, 5).map((e) => `«${name(e)}»`);
    out.stuck = out.stuck.slice(0, 5); out.clipped = [...new Set(out.clipped)].slice(0, 6); out.tiny = [...new Set(out.tiny)].slice(0, 6);
    return out;
  }, phone);
  const issues = [];
  if (r.hScroll > 1) issues.push(`горизонтальная прокрутка ${r.hScroll}px`);
  if (r.stuck.length) issues.push(`не прокручивается: ${r.stuck.join("; ")}`);
  if (r.offscreen.length) issues.push(`за краем экрана: ${r.offscreen.join(", ")}`);
  if (r.clipped.length) issues.push(`обрезан текст: ${r.clipped.join(", ")}`);
  if (r.tiny.length) issues.push(`мелкие кнопки: ${r.tiny.join(", ")}`);
  report.push({ label, issues });
}
for (const set of SETS) {
  if (ONLY && !set.name.startsWith(ONLY)) continue;
  const errs = [];
  const p = await page(browser, set.vp, errs, set.name);
  if (set.who) await login(p, set.who);
  const phone = set.vp.width < 500;
  for (const path of set.paths) {
    errs.length = 0;
    const label = `${set.name} ${path}`;
    try {
      if (path === "@menu") { await p.goto(BASE + "/"); await p.waitForTimeout(1500); await p.getByRole("button", { name: /Открыть меню|Меню/ }).first().click(); }
      else if (path === "@order") { await p.goto(BASE + "/orders"); await p.waitForTimeout(2000); await p.locator("tr.row-link, a[href^='/orders/']").first().click(); }
      else if (path === "@client") { await p.goto(BASE + "/clients"); await p.waitForTimeout(2000); await p.locator("tr.row-link, a[href^='/clients/']").first().click(); }
      else if (path === "@executor") { await p.goto(BASE + "/executors"); await p.waitForTimeout(2000); await p.locator("tr.row-link, a[href^='/executors/']").first().click(); }
      else if (path === "@lead") { await p.goto(BASE + "/leads"); await p.waitForTimeout(2000); await p.locator("tr.row-link").first().click(); }
      else if (path === "@worder") { await p.goto(BASE + "/w/my"); await p.waitForTimeout(2000); await p.locator("a[href^='/w/orders/']").first().click(); }
      else await p.goto(BASE + path, { waitUntil: "domcontentloaded" });
      await probe(p, label, phone);
      if (errs.length) report.at(-1).issues.push(`ошибки: ${[...new Set(errs)].join(" | ")}`);
      await p.screenshot({ path: `${OUT}/${label.replace(/[^a-z0-9-]+/gi, "_")}.png`, fullPage: false });
    } catch (e) { report.push({ label, issues: [`СБОЙ: ${e.message.split("\n")[0].slice(0, 160)}`] }); }
  }
  await p.context().close();
}
for (const r of report) if (r.issues.length) console.log(`✗ ${r.label}\n   - ${r.issues.join("\n   - ")}`);
const bad = report.filter((r) => r.issues.length).length;
console.log(`\nэкранов: ${report.length}, с замечаниями: ${bad}; скриншоты — ${OUT}`);
await browser.close();
process.exitCode = bad ? 1 : 0;
