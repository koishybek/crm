// Подключение Telegram-бота к деплойменту Convex: имя бота, переменные, вебхук, меню команд.
// Токен берётся из .env.local (Telegram_bot_token / TELEGRAM_BOT_TOKEN) и никуда не печатается.
// node scripts/setup-telegram.mjs [--prod]            — всё: переменные, вебхук, профиль бота
// node scripts/setup-telegram.mjs --profile           — только имя, описание и команды (вебхук не трогаем)
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const prod = process.argv.includes("--prod");
const profileOnly = process.argv.includes("--profile");
const APP_NAME = "Home Max Service";
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const token = /^(?:Telegram_bot_token|TELEGRAM_BOT_TOKEN)\s*=\s*"?([^"\s]+)"?/im.exec(env)?.[1];
if (!token) throw new Error("В .env.local нет Telegram_bot_token");

const tg = async (method, body) => {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
};

const convexEnv = (args) =>
  execFileSync(process.execPath, ["node_modules/convex/bin/main.js", "env", ...(prod ? ["--prod"] : []), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

const me = await tg("getMe");
console.log(`Бот: @${me.username} (${me.first_name})`);

async function profile() {
  await tg("setMyName", { name: APP_NAME });
  await tg("setMyCommands", {
    commands: [
      { command: "start", description: "Начать / подключить уведомления" },
      { command: "orders", description: "Мои заказы (для исполнителей)" },
      { command: "feed", description: "Свободные заказы (для исполнителей)" },
      { command: "help", description: "Что умеет бот" },
    ],
  });
  await tg("setMyShortDescription", { short_description: `${APP_NAME}: заявки на ремонт и сервис. Мастерам — новые заказы в один клик.` });
  await tg("setMyDescription", {
    description: `Здравствуйте! Это ${APP_NAME}. Опишите, что случилось, — оператор перезвонит.\n\nМастерам и сотрудникам бот присылает новые заказы и сообщения — подключение в CRM: меню профиля → «Подключить Telegram».`,
  });
  console.log(`Профиль бота: «${APP_NAME}», описание и команды ✓`);
}
if (profileOnly) {
  await profile();
  process.exit(0);
}

const site = convexEnv(["get", "CONVEX_SITE_URL"]) || "";
const deployment = /https:\/\/([a-z0-9-]+)\.convex\.site/.exec(site)?.[1];
const siteUrl = site.startsWith("https://") ? site : null;
if (!siteUrl || !deployment) throw new Error("Не получилось узнать CONVEX_SITE_URL деплоймента");

const secret = randomBytes(24).toString("hex");
for (const [k, v] of [
  ["TELEGRAM_BOT_TOKEN", token],
  ["TELEGRAM_BOT_USERNAME", me.username],
  ["TELEGRAM_WEBHOOK_SECRET", secret],
]) {
  convexEnv(["set", k, "--", v]);
  console.log(`${k} ✓`);
}

await tg("setWebhook", { url: `${siteUrl}/telegram`, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: true });
await profile();
const info = await tg("getWebhookInfo");
console.log(`Вебхук: ${info.url} · ожидают: ${info.pending_update_count}${info.last_error_message ? ` · последняя ошибка: ${info.last_error_message}` : ""}`);
