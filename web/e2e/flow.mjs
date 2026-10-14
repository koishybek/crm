// Сквозной процесс: заявка → цена → лента → мастер берёт → работа → сдача → оплата → выплата → доход мастера.
// Запуск: E2E_PASSWORD=… [BASE=…] npm run e2e:flow — на базе с демо-данными (npm run seed). Создаёт заявку и заказ.
import { BASE, OUT, launch, login as signIn, page } from "./common.mjs";
const browser = await launch();
const errors = []; let stepName = "";
const tag = String(Date.now() % 100000);
const desc = `Сквозной тест ${tag}: кондиционер не холодит`;
async function login(who, vp) {
  const p = await page(browser, vp, errors, who);
  await signIn(p, who);
  return p;
}
const step = async (p, name, fn) => { stepName = name; try { await fn(); console.log("✓", name); } catch (e) { await p.screenshot({ path: `${OUT}/flow-fail.png`, fullPage: true }).catch(() => {}); throw new Error(`шаг «${name}»: ${e.message.split("\n")[0]}`); } };
try {
  const o = await login("alikhan@homemax.kz", { width: 1440, height: 900 });
  let orderUrl = "";
  await step(o, "новая заявка → заказ", async () => {
    await o.getByRole("button", { name: /Новая заявка/ }).first().click();
    const d = o.getByRole("dialog").last();
    // Пустая форма: ошибка должна появиться и быть на экране, а не упасть или спрятаться под прокруткой.
    await d.getByRole("button", { name: "Создать заказ" }).click();
    const alert = o.getByRole("alert").filter({ hasText: /Укажите клиента/ }).first();
    await alert.waitFor({ timeout: 10000 });
    if (!(await alert.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }))) throw new Error("ошибка формы не видна");
    await d.getByLabel(/^Клиент/).fill(`Тест Сквозной ${tag}`);
    await d.getByLabel(/^Телефон/).fill(`70199${tag.padStart(5, "0")}`.slice(0, 10));
    const src = d.getByLabel(/^Источник/);
    if ((await src.evaluate((e) => e.tagName)) === "SELECT") await src.selectOption({ index: 1 }); else { await src.click(); await o.getByRole("option").first().click(); }
    const svc = d.getByLabel(/^Услуга/);
    if ((await svc.evaluate((e) => e.tagName)) === "SELECT") await svc.selectOption({ label: "Ремонт кондиционера" }); else { await svc.click(); await o.getByRole("option", { name: "Ремонт кондиционера" }).click(); }
    const city = d.getByLabel(/^Город/);
    if ((await city.evaluate((e) => e.tagName)) === "SELECT") await city.selectOption({ label: "Алматы" }); else await city.fill("Алматы");
    await d.getByLabel(/^Описание/).fill(desc);
    await d.getByRole("button", { name: "Создать заказ" }).click();
    await o.waitForFunction(() => /^\/orders\/[a-z0-9]+$/.test(location.pathname), null, { timeout: 30000 });
    orderUrl = o.url();
  });
  await step(o, "указать цену 25 000", async () => {
    await o.getByRole("button", { name: "Указать цену" }).first().click();
    const d = o.getByRole("dialog").last();
    await d.getByLabel(/Цена для клиента/).fill("25000");
    await d.getByRole("button", { name: "Сохранить" }).click();
    await o.getByText(/25\s000/).first().waitFor({ timeout: 15000 });
  });
  await step(o, "опубликовать в ленту", async () => {
    await o.getByRole("button", { name: "Опубликовать" }).first().click();
    await o.getByText(/Свободен|В ленте|Ждёт исполнителя|Ожидает исполнителя/).first().waitFor({ timeout: 15000 });
  });
  const m = await login("77011234567", { width: 390, height: 844 });
  await step(m, "мастер видит заказ в ленте и берёт", async () => {
    await m.goto(BASE + "/w"); await m.getByText(desc.slice(0, 20)).first().waitFor({ timeout: 30000 }).catch(async () => { await m.getByText(new RegExp(tag)).first().waitFor({ timeout: 5000 }); });
    const card = m.locator("article, li, div").filter({ hasText: desc.slice(0, 20) }).last();
    await card.getByRole("button", { name: /Взять заказ/ }).first().click();
    const sheet = m.getByRole("dialog").last();
    await sheet.getByRole("button", { name: /беру заказ/i }).last().click();
    await m.waitForTimeout(2500);
  });
  await step(m, "мастер: начать работу", async () => {
    await m.goto(orderUrl.replace(/.*\/orders\//, BASE + "/w/orders/"));
    await m.getByRole("button", { name: /Начать работу/ }).first().click();
    const s = m.getByRole("dialog"); if (await s.count()) await s.last().getByRole("button", { name: /Начать/ }).last().click().catch(() => {});
    await m.getByText(/В работе/).first().waitFor({ timeout: 15000 });
  });
  await step(m, "мастер: работа выполнена", async () => {
    await m.getByRole("button", { name: /Работа выполнена/ }).first().click();
    const s = m.getByRole("dialog").last();
    await s.getByRole("button", { name: /Работа выполнена|Сдать|Подтвердить/ }).last().click();
    await m.getByText(/Сдан|Ждём оплату|Работа сдана/).first().waitFor({ timeout: 15000 });
  });
  await step(o, "владелец: статус «Ожидает оплаты»", async () => {
    await o.goto(orderUrl); await o.getByText(/Ожидает оплаты/).first().waitFor({ timeout: 20000 });
  });
  await step(o, "владелец: оплата → «Оплачен»", async () => {
    await o.getByRole("button", { name: "Внести оплату" }).first().click();
    await o.getByRole("dialog").last().getByRole("button", { name: /^Внести / }).click();
    await o.getByText(/^Оплачен$/).first().waitFor({ timeout: 20000 });
  });
  await step(o, "владелец: выплата мастеру из заказа", async () => {
    await o.getByRole("button", { name: /Выплатить исполнителю/ }).first().click();
    await o.getByRole("dialog").last().getByRole("button", { name: /^Выплатить/ }).last().click();
    await o.getByText(/Выплачено|выплачено/).first().waitFor({ timeout: 20000 });
  });
  await step(m, "мастер видит выплату в «Доходе»", async () => {
    await m.goto(BASE + "/w/income"); await m.getByText(/Выплаты от офиса/).first().waitFor({ timeout: 20000 });
  });
  await o.screenshot({ path: `${OUT}/flow-order-final.png`, fullPage: true });
} catch (e) { errors.push(String(e.message)); }
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "flow OK, no errors");
await browser.close();
process.exitCode = errors.length ? 1 : 0;
