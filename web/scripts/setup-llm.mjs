// Основной LLM для AI-разбора — OpenAI-совместимый API (по умолчанию TokenLayer, gpt-5.6-luna).
// Ключ берётся из .env.local (Token_layer_api_key / LLM_API_KEY) и никуда не печатается.
// node scripts/setup-llm.mjs [--prod] [--model gpt-5.6-luna]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const prod = process.argv.includes("--prod");
const modelArg = process.argv.indexOf("--model");
const model = modelArg > 0 ? process.argv[modelArg + 1] : "gpt-5.6-luna";
const base = "https://api.tokenlayer.net/v1";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const key = /^(?:Token_layer_api_key|LLM_API_KEY)\s*=\s*"?([^"\s]+)"?/im.exec(env)?.[1];
if (!key) throw new Error("В .env.local нет Token_layer_api_key");

// Проверка до записи в Convex: ключ рабочий и модель доступна.
const res = await fetch(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
if (!res.ok) throw new Error(`TokenLayer отклонил ключ: HTTP ${res.status}`);
const ids = (((await res.json()).data ?? [])).map((m) => m.id);
if (!ids.includes(model)) throw new Error(`Модели ${model} нет в TokenLayer. Доступны: ${ids.join(", ")}`);

const convexEnv = (args) =>
  execFileSync(process.execPath, ["node_modules/convex/bin/main.js", "env", ...(prod ? ["--prod"] : []), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
for (const [k, v] of [
  ["LLM_API_KEY", key],
  ["LLM_BASE_URL", base],
  ["LLM_MODEL", model],
  ["LLM_REASONING_EFFORT", "minimal"],
]) {
  convexEnv(["set", k, "--", v]);
  console.log(`${k} ✓`);
}
console.log(`LLM: ${model} через TokenLayer (${prod ? "prod" : "dev"})`);
