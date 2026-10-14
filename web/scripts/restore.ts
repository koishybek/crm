// Восстановление данных из файла резервной копии (ТЗ п.20.10, п.26.5) в деплоймент Convex.
//
//   CONVEX_DEPLOY_KEY='prod:…|…' npx tsx scripts/restore.ts homemax-backup-2026-10-13-0200.json --dry-run
//   CONVEX_DEPLOY_KEY='prod:…|…' npx tsx scripts/restore.ts homemax-backup-….json --yes [--wipe] [--owner-login=owner@firma.kz]
//
// --dry-run — только показать, что будет сделано (на деплойменте ничего не меняется, ALLOW_SEED не нужен).
// Запись — только с --yes и ALLOW_SEED=1 на деплойменте. В базе уже есть данные — отказ, если не указан --wipe
// (стирает данные, входы и служебные таблицы; настройки, подключения и файлы хранилища остаются).
// Паролей в копии нет: --owner-login + RESTORE_OWNER_PASSWORD (от 12 символов) — временный пароль владельцу.
// Функции restore:* внутренние — скрипт зовёт их ключом деплоя, как seed-convex.ts.
import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { existsSync, readFileSync } from "node:fs";
import { internal } from "../convex/_generated/api";
import { parseBackup } from "../convex/lib/restorePlan";
import { surveyRestore, writeRestore, type AdminCaller } from "../convex/lib/restoreRun";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const yes = args.includes("--yes");
const wipe = args.includes("--wipe");
const ownerLogin = args.find((a) => a.startsWith("--owner-login="))?.slice("--owner-login=".length);

const envFile = new URL("../.env.local", import.meta.url);
const envLocal: Record<string, string | undefined> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf8")
        .split(/\r?\n/)
        .map((l) => /^([A-Z_]+)=(\S*)/.exec(l))
        .filter((m): m is RegExpExecArray => !!m)
        .map((m) => [m[1], m[2]]),
    )
  : {};
const deployKey = process.env.CONVEX_DEPLOY_KEY ?? "";
const keyDeployment = /^(?:dev|prod):([a-z0-9-]+)\|/.exec(deployKey)?.[1];
const url = process.env.CONVEX_URL ?? envLocal.VITE_CONVEX_URL ?? (keyDeployment ? `https://${keyDeployment}.convex.cloud` : undefined);

function fail(text: string): never {
  console.error(text);
  process.exit(1);
}

if (!file) fail("Укажите файл копии: npx tsx scripts/restore.ts <файл.json> --dry-run | --yes [--wipe]");
if (!dryRun && !yes) fail("Ничего не изменено. Сначала посмотрите план: --dry-run; для записи — явно --yes");
if (!deployKey) fail("Нужен CONVEX_DEPLOY_KEY — ключ деплоя из панели Convex (Settings → Deploy key) для деплоймента, куда восстанавливаем");
if (!url) fail("Нужен CONVEX_URL (или VITE_CONVEX_URL в .env.local)");
if (keyDeployment && new URL(url).hostname.split(".")[0] !== keyDeployment) fail(`CONVEX_DEPLOY_KEY выдан для «${keyDeployment}», а адрес — ${url}`);
const ownerPassword = process.env.RESTORE_OWNER_PASSWORD ?? "";
if (ownerLogin && !dryRun && ownerPassword.length < 12) fail("Для --owner-login нужен RESTORE_OWNER_PASSWORD (от 12 символов) — временный пароль владельца");

interface AdminClient {
  setAdminAuth(token: string): void;
  function(fn: FunctionReference<"query" | "mutation" | "action", "internal">, componentPath: string | undefined, args: Record<string, unknown>): Promise<unknown>;
}
const admin = new ConvexHttpClient(url) as unknown as AdminClient;
admin.setAdminAuth(deployKey);
const call = <F extends FunctionReference<"query" | "mutation" | "action", "internal">>(fn: F, a: FunctionArgs<F>): Promise<FunctionReturnType<F>> => admin.function(fn, undefined, a) as Promise<FunctionReturnType<F>>;
const caller: AdminCaller = { query: call, mutation: call, action: call };

/** Те же таблицы, что стирает заливка демо-данных (seed-convex.ts --wipe), кроме справочника файлов. */
const WIPE = ["categories", "services", "notifications", "clientNotes", "interactions", "history", "messages", "calls", "botChats", "clientNotices", "conversationMessages", "conversations", "apiLeads", "apiKeys", "audit", "reviews", "reviewRequests", "adSpend", "payouts", "rateLimits", "telegramUpdates", "escalations", "systemStatus", "backups", "oauthStates", "uploads", "exports", "campaignSpend", "webhookDeliveries", "webhooks", "pushSubscriptions", "clientErrors", "offsiteFiles", "orders", "leads", "clients", "users", "executors", "counters", "authAccounts", "authSessions", "authRefreshTokens", "authVerificationCodes", "authVerifiers", "authRateLimits"] as const;

async function main(): Promise<void> {
  const data = parseBackup(JSON.parse(readFileSync(file!, "utf8")) as unknown);
  const s = await surveyRestore(caller, data);

  console.log(`Копия от ${data.createdAt || "?"} (версия ${data.version}) → ${url}${dryRun ? " — ПРОБНЫЙ ЗАПУСК" : ""}`);
  console.log("Будет восстановлено (в этом порядке):");
  for (const o of s.order) console.log(`  ${o.table}: ${o.rows}`);
  for (const m of s.merged) console.log(`  ${m.table}: ${m.rows} — сливаются с тем, что уже есть на деплойменте`);
  for (const n of s.notRestored) console.log(`Не восстанавливается ${n.table} (${n.rows}): ${n.why}`);
  if (s.unknown.length) console.log(`Неизвестные этому деплойменту таблицы пропускаются: ${s.unknown.join(", ")}`);
  console.log(
    `Файлы: в описи ${s.files.total}, есть в хранилище ${s.files.present}, нет — ${s.missing.size}${s.missing.size ? " (ссылки на них будут убраны; сами файлы — во внешнем хранилище files/<storageId>, если копирование файлов было включено)" : ""}`,
  );
  if (s.occupied.length) console.log(`В базе уже есть данные: ${s.occupied.join(", ")}${wipe ? " — будут стёрты (--wipe)" : ""}`);
  if (dryRun) {
    if (s.occupied.length && !wipe) console.log("Для записи понадобится --wipe.");
    if (!ownerLogin) console.log("Входов в копии нет: добавьте --owner-login=<логин владельца> и RESTORE_OWNER_PASSWORD, чтобы владелец смог войти.");
    console.log("Пробный запуск: на деплойменте ничего не изменено.");
    return;
  }
  if (s.occupied.length && !wipe) fail("Отказ: в базе уже есть данные. Восстановление поверх смешает записи — добавьте --wipe (сотрёт текущие данные) или выберите пустой деплоймент.");

  if (wipe) {
    console.log("Стираю текущие данные…");
    for (const t of WIPE) while ((await call(internal.seed.wipe, { table: t })) > 0);
  }
  console.log("Восстанавливаю…");
  const r = await writeRestore(caller, data, s, (line) => console.log(line));
  if (r.deferred) console.log(`  взаимных ссылок дописано: ${r.deferred}`);
  console.log(`  настройки: ${r.settings}, подключения: ${r.integrations} (подключить заново)`);

  if (ownerLogin) {
    await call(internal.restore.ownerLogin, { login: ownerLogin, password: ownerPassword });
    console.log(`Владелец ${ownerLogin}: временный пароль задан, при входе система попросит сменить его.`);
  } else {
    console.log(`Входов в копии нет. Чтобы владелец смог войти: npx convex run [--prod] restore:ownerLogin '{"login":"…","password":"…"}' (пока стоит ALLOW_SEED=1).`);
  }
  console.log(`Готово: восстановлено ${r.docs} записей. Ключи API и вебхуки создайте заново, OLX подключите заново.`);
}

main().catch((e: unknown) => fail(`Восстановление прервано: ${e instanceof Error ? e.message : String(e)}`));
