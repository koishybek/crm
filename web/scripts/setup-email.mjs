// Письма через обычный ящик компании (SMTP): сервер, порт и логин — в переменные Convex, пароль — тоже, но
// никуда не печатается и не попадает в командную строку (в convex env set уходит через stdin).
// node scripts/setup-email.mjs [--prod] HOST PORT USER [--from "Home Max Service <noreply@домен.kz>"] [--reply-to офис@домен.kz]
// Пароль: переменная окружения EMAIL_SMTP_PASS, или через stdin (echo … | node …), или скрипт спросит его скрытым вводом.
// Готовые настройки: Gmail — smtp.gmail.com 465, Яндекс — smtp.yandex.ru 465, Mail.ru — smtp.mail.ru 465; везде пароль приложения.
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const prod = argv.includes("--prod");
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const from = option("--from");
const replyTo = option("--reply-to");
const positional = argv.filter((a, i) => !a.startsWith("--") && !["--from", "--reply-to"].includes(argv[i - 1]));
const [host, port, user] = positional;

const usage = "node scripts/setup-email.mjs [--prod] HOST PORT USER [--from \"Имя <адрес>\"] [--reply-to адрес]";
if (!host || !port || !user) throw new Error(`Нужны сервер, порт и логин: ${usage}`);
if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host)) throw new Error("Сервер — имя вроде smtp.gmail.com");
if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Порт — число: 465 (SSL) или 587 (STARTTLS)");
if (!["465", "587"].includes(port)) console.warn(`Порт ${port}: соединение будет только с STARTTLS — без шифрования пароль не отправляется.`);
if (!from && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(user)) throw new Error("Логин — не email: укажите отправителя через --from \"Имя <адрес>\"");

/** Пароль скрытым вводом: символы не отображаются. */
function askHidden(question) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

let pass = process.env.EMAIL_SMTP_PASS ?? (process.stdin.isTTY ? await askHidden(`Пароль приложения для ${user}: `) : await readStdin());
// Google показывает пароль приложения группами через пробел — сам пароль без пробелов.
if (host.toLowerCase() === "smtp.gmail.com") pass = pass.replace(/\s+/g, "");
if (!pass.trim()) throw new Error("Пароль пустой");

const convexEnv = (args, input) =>
  execFileSync(process.execPath, ["node_modules/convex/bin/main.js", "env", ...(prod ? ["--prod"] : []), ...args], {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  }).trim();

for (const [k, v] of [
  ["EMAIL_SMTP_HOST", host.toLowerCase()],
  ["EMAIL_SMTP_PORT", port],
  ["EMAIL_SMTP_USER", user],
  ...(from ? [["EMAIL_FROM", from]] : []),
  ...(replyTo ? [["EMAIL_REPLY_TO", replyTo]] : []),
]) {
  convexEnv(["set", k, "--", v]);
  console.log(`${k} ✓`);
}
// Пароль — через stdin: в списке процессов и истории команд его нет.
convexEnv(["set", "EMAIL_SMTP_PASS"], pass);
console.log("EMAIL_SMTP_PASS ✓ (значение не показывается)");

const isSet = (name) => {
  try {
    return !!convexEnv(["get", name]);
  } catch {
    return false;
  }
};
const resendKey = isSet("EMAIL_API_KEY") || isSet("RESEND_API_KEY");
if (resendKey) console.warn("Внимание: на деплойменте задан ключ Resend (EMAIL_API_KEY) — пока он есть, письма идут через Resend. Уберите его: npx convex env remove EMAIL_API_KEY");
console.log(`Почта: ${host}:${port} (${port === "465" ? "SSL" : "STARTTLS"}), вход ${user} — ${prod ? "prod" : "dev"}. Проверка: «Настройки → Email → Отправить проверочное письмо».`);
