// Ключи для Convex Auth + служебные переменные деплоймента.
// node scripts/setup-auth-env.mjs [--prod] SITE_URL=... [KEY=VALUE ...]
import { execFileSync } from "node:child_process";
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

const vars = { JWT_PRIVATE_KEY: pem, JWKS: jwks, ...extra };
for (const [k, v] of Object.entries(vars)) {
  const value = v === "random" ? randomBytes(24).toString("hex") : v;
  execFileSync(process.execPath, ["node_modules/convex/bin/main.js", "env", "set", ...(prod ? ["--prod"] : []), k, "--", value], { stdio: ["ignore", "ignore", "inherit"] });
  console.log(`${k} ✓${v === "random" ? ` (${value})` : ""}`);
}
