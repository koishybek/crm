// Ключи VAPID для уведомлений на телефон (web push, ТЗ п.23.6) → переменные Convex.
// node scripts/setup-vapid.mjs [--prod] --subject=mailto:admin@firma.kz [--force]
// Генерирует пару P-256 и ставит VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT. Закрытый ключ в консоль
// не печатается — дописывается в .secrets.local (в git не попадает). Смена ключей отключает все подписки:
// людям придётся включить уведомления заново, поэтому без --force существующие ключи не перезаписываются.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { webcrypto } from "node:crypto";

const prod = process.argv.includes("--prod");
const force = process.argv.includes("--force");
const subject = process.argv.find((a) => a.startsWith("--subject="))?.slice("--subject=".length) ?? "";
if (!/^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(subject)) {
  console.error("Нужен --subject=mailto:почта@компании (или https://адрес): по нему push-сервис свяжется при проблемах");
  process.exit(1);
}

const convex = (args, opts = {}) => execFileSync(process.execPath, ["node_modules/convex/bin/main.js", "env", ...args], { encoding: "utf8", ...opts });

if (!force) {
  let current = "";
  try {
    current = convex(["get", ...(prod ? ["--prod"] : []), "VAPID_PUBLIC_KEY"], { stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    // Переменной нет — CLI завершается с ошибкой: ставим новые ключи.
  }
  if (current) {
    console.error("Ключи VAPID уже заданы. Смена ключей отключит все подписки — если это нужно, запустите с --force");
    process.exit(1);
  }
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
const publicKey = b64url(await webcrypto.subtle.exportKey("raw", pair.publicKey));
const privateKey = jwk.d;

const set = (k, value) => execFileSync(process.execPath, ["node_modules/convex/bin/main.js", "env", "set", ...(prod ? ["--prod"] : []), k, "--", value], { stdio: ["ignore", "ignore", "inherit"] });
set("VAPID_PUBLIC_KEY", publicKey);
set("VAPID_PRIVATE_KEY", privateKey);
set("VAPID_SUBJECT", subject);
appendFileSync(new URL("../.secrets.local", import.meta.url), `${prod ? "prod" : "dev"} VAPID_PRIVATE_KEY=${privateKey}\n`, { mode: 0o600 });
console.log(`VAPID_PUBLIC_KEY ✓ (${publicKey})`);
console.log("VAPID_PRIVATE_KEY ✓ (значение — в .secrets.local)");
console.log(`VAPID_SUBJECT ✓ (${subject})`);
