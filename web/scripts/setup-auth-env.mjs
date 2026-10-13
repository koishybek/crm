// Ключи для Convex Auth + служебные переменные деплоймента.
// node scripts/setup-auth-env.mjs [--prod] SITE_URL=... [KEY=VALUE ...]
// KEY=random — случайное значение (24 байта hex), KEY=random32 — 32 байта в base64 (например, INTEGRATIONS_KEY).
// Сгенерированные значения в консоль и логи CI не печатаем (аудит L-9): они дописываются в .secrets.local
// (в git не попадает — *.local в .gitignore), чтобы при необходимости передать их в другой сервис.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";

const prod = process.argv.includes("--prod");
const extra = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.includes("="))
    .map((a) => [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)]),
);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString().trimEnd().replace(/\n/g, " ");
const jwks = JSON.stringify({ keys: [{ use: "sig", ...publicKey.export({ format: "jwk" }) }] });

const RANDOM = { random: () => randomBytes(24).toString("hex"), random32: () => randomBytes(32).toString("base64") };
const secretsFile = new URL("../.secrets.local", import.meta.url);

const vars = { JWT_PRIVATE_KEY: pem, JWKS: jwks, ...extra };
for (const [k, v] of Object.entries(vars)) {
  const generated = Object.hasOwn(RANDOM, v);
  const value = generated ? RANDOM[v]() : v;
  execFileSync(process.execPath, ["node_modules/convex/bin/main.js", "env", "set", ...(prod ? ["--prod"] : []), k, "--", value], { stdio: ["ignore", "ignore", "inherit"] });
  if (generated) appendFileSync(secretsFile, `${prod ? "prod" : "dev"} ${k}=${value}\n`, { mode: 0o600 });
  console.log(`${k} ✓${generated ? " (значение — в .secrets.local)" : ""}`);
}
