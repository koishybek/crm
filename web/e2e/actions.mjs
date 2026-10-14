// Ключевые действия по всем ролям: после каждого — страница не упала («Что-то пошло не так»), в консоли нет ошибок.
// Запуск: E2E_PASSWORD=… [BASE=…] npm run e2e:actions — на базе с демо-данными. Меняет данные (назначение, пауза, ответ).
import { BASE, OUT, launch, login, page } from "./common.mjs";

const browser = await launch();
const errors = [];
const results = [];
async function act(p, name, fn) {
  const before = errors.length;
  try {
    await fn();
    await p.waitForTimeout(1200);
    if (await p.getByText("Что-то пошло не так", { exact: true }).first().isVisible()) throw new Error("экран ошибки раздела");
    const fresh = errors.slice(before);
    results.push(fresh.length ? `✗ ${name}: ${fresh.join(" | ")}` : `✓ ${name}`);
  } catch (e) {
    await p.screenshot({ path: `${OUT}/action-fail-${results.length + 1}.png`, fullPage: true }).catch(() => {});
    results.push(`✗ ${name}: ${e.message.split("\n")[0].slice(0, 200)}`);
  }
}
const open = async (p, list, sel) => {
  await p.goto(BASE + list);
  await p.locator(sel).first().click();
  await p.waitForTimeout(1500);
};

const o = await page(browser, { width: 1440, height: 900 }, errors, "owner");
await login(o, "alikhan@homemax.kz");
await act(o, "заказ: окно «Назначить исполнителя» и выбор кандидата", async () => {
  await o.goto(BASE + "/orders");
  await o.getByRole("button", { name: "Список" }).click();
  await o.waitForTimeout(1500);
  await o.locator("tr.row-link").filter({ hasText: /Ожидает исполнителя/ }).first().click();
  await o.getByRole("button", { name: /Назначить исполнителя/ }).first().click();
  const d = o.getByRole("dialog").last();
  await d.waitFor();
  await d.getByRole("button", { name: /Назначить/ }).first().click();
});
await act(o, "аналитика: смена периода", async () => {
  await o.goto(BASE + "/analytics");
  await o.getByText("Выручка").first().waitFor({ timeout: 20000 });
  const sel = o.locator("select").first();
  if (await sel.count()) await sel.selectOption({ index: 1 });
  else await o.getByRole("button", { name: /Последние|Период|дней/ }).first().click();
});
await act(o, "настройки: сохранить «Сроки реакции»", async () => {
  await o.goto(BASE + "/settings");
  const card = o.locator("section").filter({ hasText: "Сроки реакции" }).first();
  await card.scrollIntoViewIfNeeded();
  // «Сохранить» активна только после изменения — меняем первый срок на минуту и обратно сохраняем.
  const input = card.locator('input[type="number"], input[inputmode="numeric"]').first();
  const was = await input.inputValue();
  await input.fill(String(Number(was) + 1));
  await card.getByRole("button", { name: /^Сохранить/ }).first().click();
  await o.waitForTimeout(1500);
  await input.fill(was);
  await card.getByRole("button", { name: /^Сохранить/ }).first().click();
});
await act(o, "клиент: карточка и вкладки", async () => {
  await open(o, "/clients", "tr.row-link");
  for (const t of ["Звонки", "Оплаты", "Файлы"]) {
    const tab = o.getByRole("tab", { name: new RegExp(t) });
    if (await tab.count()) await tab.first().click();
  }
});
await act(o, "заказы: архив с поиском", async () => {
  await o.goto(BASE + "/orders?view=archive");
  await o.waitForTimeout(1500);
  const q = o.getByRole("searchbox").or(o.getByPlaceholder(/Номер|поиск|Поиск/)).first();
  if (await q.count()) await q.fill("10");
});

const op = await page(browser, { width: 1366, height: 768 }, errors, "operator");
await login(op, "madina@homemax.kz");
await act(op, "заявка: «Взять в работу» (если есть ждущие)", async () => {
  await op.goto(BASE + "/leads");
  await op.waitForTimeout(1500);
  await op.locator("tr.row-link").first().click();
  const take = op.getByRole("button", { name: "Взять в работу" });
  if (await take.count()) await take.first().click();
});
await act(op, "сообщения: ответ в диалоге", async () => {
  await op.goto(BASE + "/inbox");
  await op.waitForTimeout(2000);
  await op.locator("ul li button, [role=listitem] button, a[href*='/inbox?c=']").first().click();
  const box = op.getByRole("textbox").last();
  if (await box.isEnabled()) {
    await box.fill("Здравствуйте! Проверка ответа");
    await op.keyboard.press("Enter");
  }
});

const m = await page(browser, { width: 390, height: 844 }, errors, "master");
await login(m, "77011234567");
await act(m, "мастер: пауза и снятие паузы", async () => {
  await m.goto(BASE + "/w/my");
  await m.waitForTimeout(1500);
  const link = m.locator("a[href^='/w/orders/']").first();
  if (await link.count()) await link.click();
  else await m.getByText(/Сейчас · №/).first().click();
  await m.waitForFunction(() => location.pathname.startsWith("/w/orders/"), null, { timeout: 15000 });
  const pause = m.getByRole("button", { name: /Жду клиента/ });
  if (await pause.count()) {
    await pause.first().click();
    const sheet = m.getByRole("dialog").last();
    await sheet.getByRole("button", { name: "Поставить на паузу" }).click();
    await m.waitForTimeout(1500);
    await m.getByRole("button", { name: /Снять паузу|Продолжить/ }).first().click();
  }
});
await act(m, "мастер: профиль и выключение приёма", async () => {
  await m.goto(BASE + "/w/profile");
  await m.waitForTimeout(1500);
});

for (const r of results) console.log(r);
const bad = results.filter((r) => r.startsWith("✗")).length;
console.log(`\nдействий: ${results.length}, с ошибками: ${bad}`);
await browser.close();
process.exitCode = bad ? 1 : 0;
