// Заливка демо-данных в Convex: CONVEX_DEPLOY_KEY=… DEMO_PASSWORD=… npm run seed [-- --wipe] (на деплойменте — ALLOW_SEED=1).
// Функции seed:* внутренние (аудит H-1): клиенты их не видят, скрипт зовёт их с правами администратора деплоймента —
// ключом деплоя (панель Convex → Settings → Deploy key), так же, как это делает `npx convex run`.
// Генерация — локально (время считается в часовом поясе этой машины), вставка — пачками через seed:ingest.
import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { existsSync, readFileSync } from "node:fs";
import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { withDefaultPrices } from "../convex/lib/defaultPrices";
import { buildSeed } from "../src/data/seed";
import { ACTIVE_STATUSES, DEFAULT_CATEGORIES, DEFAULT_SERVICES, serviceById, setCatalog, WORK_STATUSES } from "../src/data/catalog";
import { DEFAULT_MAX_ACTIVE, paidAmount, payout } from "../src/data/logic";
import { bayesianRating } from "../src/data/reviews";
import type { Actor } from "../src/data/types";
import { money } from "../src/lib/format";

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
/** Ключ деплоя «dev:имя|…» / «prod:имя|…» — имя деплоймента, к которому он подходит. */
const keyDeployment = /^(?:dev|prod):([a-z0-9-]+)\|/.exec(deployKey)?.[1];
const url = process.env.CONVEX_URL ?? envLocal.VITE_CONVEX_URL ?? (keyDeployment ? `https://${keyDeployment}.convex.cloud` : undefined);
// Пароль демо-аккаунтов — только из окружения: в публичном репозитории его быть не должно.
const password: string = process.env.DEMO_PASSWORD ?? "";
if (!deployKey) throw new Error("Нужен CONVEX_DEPLOY_KEY — ключ деплоя из панели Convex (Settings → Deploy key) для деплоймента, куда заливаем демо-данные");
if (!url) throw new Error("Нужен CONVEX_URL (или VITE_CONVEX_URL в .env.local)");
// Ключ от одного деплоймента и адрес другого — скорее всего, опечатка: лучше остановиться, чем залить (и стереть) не туда.
if (keyDeployment && new URL(url).hostname.split(".")[0] !== keyDeployment) throw new Error(`CONVEX_DEPLOY_KEY выдан для «${keyDeployment}», а адрес — ${url}`);
if (!password || password.length < 10) throw new Error("Нужен DEMO_PASSWORD (не короче 10 символов) — пароль демо-аккаунтов");

/** setAdminAuth и function — служебные методы ConvexHttpClient, через них зовёт внутренние функции и `npx convex run`. */
interface AdminClient {
  setAdminAuth(token: string): void;
  function(fn: FunctionReference<"query" | "mutation" | "action", "internal">, componentPath: string | undefined, args: Record<string, unknown>): Promise<unknown>;
}
const admin = new ConvexHttpClient(url) as unknown as AdminClient;
admin.setAdminAuth(deployKey);
const call = <F extends FunctionReference<"query" | "mutation" | "action", "internal">>(fn: F, args: FunctionArgs<F>): Promise<FunctionReturnType<F>> =>
  admin.function(fn, undefined, args) as Promise<FunctionReturnType<F>>;

type Table = "executors" | "users" | "clients" | "leads" | "orders" | "messages" | "history" | "interactions" | "clientNotes" | "notifications" | "counters" | "calls" | "conversations" | "conversationMessages" | "audit" | "reviews" | "adSpend" | "payouts" | "campaignSpend";

async function insert(table: Table, rows: Record<string, unknown>[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 150) {
    ids.push(...(await call(internal.seed.ingest, { table, rows: rows.slice(i, i + 150) })));
  }
  process.stdout.write(`  ${table}: ${rows.length}\n`);
  return ids;
}

const strip = <T extends { id: string }>(x: T) => {
  const { id: _id, ...rest } = x;
  void _id;
  return rest;
};

// Номер компании для демо-звонков: городской алматинский.
const COMPANY_PHONE = "77273450000";
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

// Расшифровки для витринных заявок «с телефона» (AI-разбор у них уже есть в демо-данных).
const TRANSCRIPTS: Record<string, string> = {
  "fridge-repair":
    "Хоум Макс Сервис, здравствуйте, Мадина слушает. Здравствуйте. У меня холодильник Samsung перестал охлаждать нижнюю камеру, уже два дня так. Морозилка при этом работает нормально. Поняла вас. Подскажите адрес. Алматы, микрорайон Самал-2, дом 58. Когда вам удобно принять мастера? Завтра после шести вечера, раньше я на работе. Хорошо, мастер перезвонит и подтвердит время. Спасибо.",
  boiler:
    "Хоум Макс Сервис, добрый день. Добрый день. Я хочу заменить старый бойлер на новый, на 80 литров, новый уже купила. В каком вы городе? Караганда. Когда удобно сделать монтаж? На этой неделе, лучше в субботу. И скажите, а старый бойлер вы вывозите? Уточню у мастера и перезвоню. Какой у вас бюджет на работу? Где-то до двадцати пяти тысяч. Записала, перезвоним сегодня.",
};

/** Детерминированный «случай» по номеру заявки — перезаливка даёт те же длительности. */
const frac = (n: number) => ((n * 2654435761) >>> 0) / 2 ** 32;

async function uploadDemo(file: string): Promise<string> {
  const uploadUrl = await call(internal.seed.uploadUrl, {});
  const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "audio/mpeg" }, body: readFileSync(new URL(`./demo-calls/${file}`, import.meta.url)) });
  if (!res.ok) throw new Error(`Не загрузилась запись ${file}: HTTP ${res.status}`);
  return ((await res.json()) as { storageId: string }).storageId;
}

async function main() {
  // Привязки Telegram переживают перезаливку: людям не нужно заново жать «Подключить».
  const links = await call(internal.seed.telegramLinks, {});
  const tgLinks = new Map([...links.map((l) => [l.name, l.chatId] as const), ...links.map((l) => [l.login, l.chatId] as const)]);
  if (process.argv.includes("--wipe")) {
    console.log("Очищаю базу…");
    for (const t of ["categories", "services", "notifications", "clientNotes", "interactions", "history", "messages", "calls", "botChats", "clientNotices", "conversationMessages", "conversations", "apiLeads", "apiKeys", "audit", "reviews", "reviewRequests", "adSpend", "payouts", "rateLimits", "telegramUpdates", "escalations", "systemStatus", "backups", "oauthStates", "uploads", "exports", "campaignSpend", "webhookDeliveries", "webhooks", "orders", "leads", "clients", "users", "executors", "counters", "authAccounts", "authSessions", "authRefreshTokens", "authVerificationCodes", "authVerifiers", "authRateLimits", "statsFacts", "dailyStats", "statsDirty", "statsState", "pushSubscriptions", "clientErrors", "offsiteFiles", "paymentIntents", "documents"] as const) {
      while ((await call(internal.seed.wipe, { table: t })) > 0);
    }
    while ((await call(internal.seed.wipeFiles, {})) > 0);
  }
  // Цены справочника по умолчанию живут только на сервере (convex/lib/defaultPrices.ts) — генератору демо-данных они нужны.
  setCatalog(DEFAULT_CATEGORIES, withDefaultPrices(DEFAULT_SERVICES));
  const db = buildSeed(new Date());
  console.log("Заливаю демо-данные…");

  // Лимит заказов в работе (ТЗ п.14): у кого в демо заказов больше лимита по умолчанию, тому владелец «поднял» лимит.
  const activeBy = new Map<string, number>();
  for (const o of db.orders) if (o.executorId && WORK_STATUSES.includes(o.status)) activeBy.set(o.executorId, (activeBy.get(o.executorId) ?? 0) + 1);
  const exIds = await insert(
    "executors",
    db.executors.map((e) => {
      const active = activeBy.get(e.id) ?? 0;
      return { ...strip(e), ...(active > DEFAULT_MAX_ACTIVE ? { maxActiveOrders: active } : {}) };
    }),
  );
  const exMap = new Map(db.executors.map((e, i) => [e.id, exIds[i]!]));

  const loginOf = (u: (typeof db.users)[number]) => (u.role === "executor" ? u.phone : u.email.toLowerCase());
  const userIds = await insert(
    "users",
    db.users.map((u) => ({
      name: u.name,
      email: loginOf(u),
      phone: u.phone,
      role: u.role,
      executorId: u.executorId ? exMap.get(u.executorId) : undefined,
      categories: u.categories,
      tenantId: u.tenantId,
      active: true,
      telegramChatId: tgLinks.get(loginOf(u)) ?? tgLinks.get(u.name),
    })),
  );
  const userMap = new Map(db.users.map((u, i) => [u.id, userIds[i]!]));

  // Счётчики клиента — как их считает refreshClient.
  const stats = new Map<string, { count: number; active: number; last?: string }>();
  for (const o of db.orders) {
    if (o.status === "cancelled") continue;
    const s = stats.get(o.clientId) ?? { count: 0, active: 0 };
    s.count++;
    if (ACTIVE_STATUSES.includes(o.status)) s.active++;
    if (!s.last || o.createdAt > s.last) s.last = o.createdAt;
    stats.set(o.clientId, s);
  }
  const lastLead = new Map<string, string>();
  for (const l of db.leads) if ((lastLead.get(l.clientId) ?? "") < l.createdAt) lastLead.set(l.clientId, l.createdAt);
  const clientIds = await insert(
    "clients",
    db.clients.map((c) => {
      const s = stats.get(c.id);
      return { ...strip(c), ordersCount: s?.count ?? 0, activeCount: s?.active ?? 0, lastOrderAt: s?.last, lastActivityAt: [c.createdAt, s?.last ?? "", lastLead.get(c.id) ?? ""].sort().pop()! };
    }),
  );
  const clientMap = new Map(db.clients.map((c, i) => [c.id, clientIds[i]!]));

  // Кто завёл заявку (E12): заявки сайта и бота Telegram пришли сами; ещё не взятые («Новая») — без оператора,
  // на демо видно «Взять в работу»; остальные ведёт оператор, взявший их в работу через несколько минут.
  const ORIGIN: Partial<Record<string, "site" | "bot">> = { site: "site", telegram: "bot" };
  const originOf = (l: (typeof db.leads)[number]) => ORIGIN[l.source] ?? "operator";
  const untaken = (l: (typeof db.leads)[number]) => originOf(l) !== "operator" && l.status === "new";
  // Рекламные кампании (ТЗ п.28.5): заявки сайта и Instagram — по меткам utm, через одну; заказ наследует метки заявки.
  const CAMPAIGNS: Partial<Record<string, { source: string; medium: string; campaign: string }[]>> = {
    site: [
      { source: "google", medium: "cpc", campaign: "ac-oct-search" },
      { source: "2gis", medium: "cpc", campaign: "wm-autumn" },
    ],
    instagram: [{ source: "instagram", medium: "paid-social", campaign: "ac-oct-reels" }],
  };
  const utmOf = (l: (typeof db.leads)[number], i: number) => (i % 2 === 0 ? CAMPAIGNS[l.source]?.[(i >> 1) % (CAMPAIGNS[l.source]?.length ?? 1)] : undefined);
  const leadUtm = new Map(db.leads.map((l, i) => [l.id, utmOf(l, i)] as const));
  const leadIds = await insert(
    "leads",
    db.leads.map((l) => {
      const { orderId: _o, ...rest } = strip(l);
      void _o;
      const origin = originOf(l);
      return {
        ...rest,
        clientId: clientMap.get(l.clientId),
        operatorId: untaken(l) ? undefined : userMap.get(l.operatorId),
        origin,
        firstActionAt: untaken(l) ? undefined : origin === "operator" ? l.createdAt : iso(Date.parse(l.createdAt) + 4 * MIN),
        ...(leadUtm.get(l.id) ? { utm: leadUtm.get(l.id), campaign: leadUtm.get(l.id)!.campaign } : {}),
      };
    }),
  );
  const leadMap = new Map(db.leads.map((l, i) => [l.id, leadIds[i]!]));

  // Мастер видит только переписку «С мастером» и файлы, отмеченные для него: демо-сообщения мастеров — в этом канале,
  // фото от клиента «показаны мастеру».
  const executorUsers = new Set(db.users.filter((u) => u.role === "executor").map((u) => u.id));
  const byExecutor = (a: Actor) => a.type === "user" && executorUsers.has(a.id);
  const shownToExecutor = new Set(db.messages.filter((m) => m.author.type === "client" || byExecutor(m.author)).flatMap((m) => m.files.map((f) => f.id)));
  const fileRow = (f: { id: string; name: string; kind: "image" | "file" }) => ({ id: f.id, name: f.name, kind: f.kind, ...(shownToExecutor.has(f.id) ? { forExecutor: true } : {}) });

  // ── Деньги по правилам системы (ТЗ п.10, п.13): статус по оплате, возврат — записью, снимок выплаты мастеру ──
  const ownerId = userMap.get("u-owner")!;
  const ACCEPTED = new Set<string>(["accepted", "in_progress", "awaiting_client", "done", "awaiting_payment", "paid", "closed", "refund"]);
  for (const o of db.orders) {
    const paid = paidAmount(o);
    // Сданная работа сразу уходит в статус по деньгам: «Выполнен» дольше мгновения не держится.
    if (o.status === "done" && o.doneAt) {
      const to = paid >= o.clientPrice ? "paid" : "awaiting_payment";
      db.history.push({ id: `h-settle-${o.id}`, orderId: o.id, kind: "status", text: to === "paid" ? "Оплачен: клиент оплатил заказ полностью" : `Ожидает оплаты: долг клиента ${money(o.clientPrice - paid)}`, actor: { type: "system" }, at: iso(Date.parse(o.doneAt) + 1000), from: "done", to });
      o.status = to;
    }
    // Возврат — не просто статус, а запись: сумма, способ, дата и причина (как оформляет владелец).
    if (o.status === "refund" && paid > 0) {
      const step = db.history.find((h) => h.orderId === o.id && h.text.startsWith("Оформлен возврат"));
      const method = o.payments[o.payments.length - 1]?.method ?? "kaspi";
      o.refunds = [{ id: `r-${o.id}`, amount: paid, method, at: step?.at ?? o.closedAt ?? o.createdAt, reason: "Клиент недоволен качеством", by: ownerId }];
    }
    // Мастер принял заказ — за выплату на тот момент (её правки после этого приходят ему уведомлением).
    if (o.executorId && ACCEPTED.has(o.status)) o.acceptedPayout = payout(o);
  }
  const moneyAt = (o: (typeof db.orders)[number]) => [...o.payments.map((p) => p.at), ...(o.refunds ?? []).map((r) => r.at)].sort().pop();

  const orderIds = await insert(
    "orders",
    db.orders.map((o) => ({
      ...strip(o),
      clientId: clientMap.get(o.clientId),
      leadId: o.leadId ? leadMap.get(o.leadId) : undefined,
      executorId: o.executorId ? exMap.get(o.executorId) : undefined,
      createdBy: userMap.get(o.createdBy),
      files: o.files.map(fileRow),
      moneyAt: moneyAt(o),
      ...(o.leadId && leadUtm.get(o.leadId) ? { utm: leadUtm.get(o.leadId), campaign: leadUtm.get(o.leadId)!.campaign } : {}),
    })),
  );
  const orderMap = new Map(db.orders.map((o, i) => [o.id, orderIds[i]!]));

  // ── Реестр выплат: за закрытые заказы мастерам уже заплатили — одна выплата мастеру за день закрытия ──
  const almatyDay = (at: string) => new Date(Date.parse(at) + 5 * 3600_000).toISOString().slice(0, 10);
  const paidAtOf = (o: (typeof db.orders)[number]) => o.closedAt ?? o.paidAt ?? o.doneAt ?? o.createdAt;
  const payoutGroups = new Map<string, (typeof db.orders)[number][]>();
  for (const o of db.orders) {
    if (!o.payoutPaid || !o.executorId) continue;
    const key = `${o.executorId}|${almatyDay(paidAtOf(o))}`;
    payoutGroups.set(key, [...(payoutGroups.get(key) ?? []), o]);
  }
  const groups = [...payoutGroups.values()];
  const payoutRows = groups.map((list) => {
    const at = list.map(paidAtOf).sort().pop()!;
    return {
      tenantId: db.users[0]!.tenantId,
      executorId: exMap.get(list[0]!.executorId!),
      orderIds: list.map((o) => orderMap.get(o.id)),
      orderNumbers: list.map((o) => o.number),
      amount: list.reduce((s, o) => s + payout(o), 0),
      method: list[0]!.number % 4 === 0 ? "cash" : "kaspi",
      at,
      by: ownerId,
      createdAt: at,
    };
  });
  const payoutIds = await insert("payouts", payoutRows);
  const payoutPatches = groups.flatMap((list, i) => list.map((o) => ({ id: orderMap.get(o.id)!, fields: { payoutId: payoutIds[i], payoutPaidAt: payoutRows[i]!.at } })));
  for (let i = 0; i < payoutPatches.length; i += 200) await call(internal.seed.patchMany, { table: "orders", patches: payoutPatches.slice(i, i + 200) });

  const patches = db.leads.filter((l) => l.orderId).map((l) => ({ id: leadMap.get(l.id)!, fields: { orderId: orderMap.get(l.orderId!) } }));
  for (let i = 0; i < patches.length; i += 200) await call(internal.seed.patchMany, { table: "leads", patches: patches.slice(i, i + 200) });

  const actor = (a: Actor): Actor => (a.type === "user" ? { type: "user", id: userMap.get(a.id)! } : a.type === "client" ? { type: "client", id: clientMap.get(a.id)! } : a);
  await insert(
    "messages",
    db.messages.map((m) => ({ ...strip(m), orderId: orderMap.get(m.orderId), author: actor(m.author), channel: byExecutor(m.author) ? "executor" : m.channel, files: m.files.map(fileRow) })),
  );
  await insert("history", db.history.map((h) => ({ ...strip(h), orderId: orderMap.get(h.orderId), actor: actor(h.actor) })));
  await insert("interactions", db.interactions.map((x) => ({ ...strip(x), clientId: clientMap.get(x.clientId), leadId: x.leadId ? leadMap.get(x.leadId) : undefined })));
  await insert("clientNotes", db.clientNotes.map((n) => ({ ...strip(n), clientId: clientMap.get(n.clientId), authorId: userMap.get(n.authorId) })));
  const link = (l?: string) => l?.replace(/(o-[0-9a-z]+)/, (m) => orderMap.get(m) ?? m);
  await insert("notifications", db.notifications.map((n) => ({ ...strip(n), userId: userMap.get(n.userId), link: link(n.link) })));
  await insert("counters", [{ name: "number", value: Math.max(...db.orders.map((o) => o.number), ...db.leads.map((l) => l.number)) }]);

  // ── Звонки ───────────────────────────────────────────────────────────────
  const now = Date.now();
  const tenantId = db.users[0]!.tenantId;
  const clientById = new Map(db.clients.map((c) => [c.id, c]));
  // Заявки «с телефона» за полтора месяца: каждой предшествовал входящий звонок.
  const fromLeads = db.leads
    .filter((l) => l.source === "phone" && now - Date.parse(l.createdAt) < 45 * 86400_000)
    .map((l) => {
      const c = clientById.get(l.clientId)!;
      const duration = 50 + Math.round(frac(l.number) * 250);
      const startedAt = Date.parse(l.createdAt) - (3 + Math.round(frac(l.number + 1) * 5)) * MIN - duration * 1000;
      return {
        tenantId,
        direction: "in",
        from: c.phone,
        to: COMPANY_PHONE,
        clientId: clientMap.get(c.id),
        clientName: c.name,
        leadId: leadMap.get(l.id),
        operatorId: userMap.get(l.operatorId),
        status: "completed",
        startedAt: iso(startedAt),
        endedAt: iso(startedAt + duration * 1000),
        duration,
        transcript: l.ai ? TRANSCRIPTS[l.serviceId] : undefined,
        ai: l.ai,
        aiStatus: l.ai ? "done" : "none",
      };
    });
  const aisulu = db.clients.find((c) => c.phone === "77014443322");
  const ruslan = db.clients.find((c) => c.phone === "77772345678");
  const madina = userMap.get("u-madina");
  const today = [
    // Клиентка с заказом в работе не дозвонилась — оператору нужно перезвонить.
    aisulu && { tenantId, direction: "in", from: aisulu.phone, to: COMPANY_PHONE, clientId: clientMap.get(aisulu.id), clientName: aisulu.name, status: "missed", startedAt: iso(now - 24 * MIN), endedAt: iso(now - 23.5 * MIN), aiStatus: "none" },
    { tenantId, direction: "in", from: "77017778899", to: COMPANY_PHONE, status: "missed", startedAt: iso(now - 71 * MIN), endedAt: iso(now - 70.5 * MIN), aiStatus: "none" },
    ruslan && { tenantId, direction: "out", from: COMPANY_PHONE, to: ruslan.phone, clientId: clientMap.get(ruslan.id), clientName: ruslan.name, operatorId: madina, status: "completed", startedAt: iso(now - 47 * MIN), endedAt: iso(now - 44.8 * MIN), duration: 132, aiStatus: "none" },
  ].filter((x) => !!x);
  // Две записи проходят настоящий AI прямо при заливке: расшифровка → разбор → новая заявка.
  const live = [
    { file: "washer.mp3", from: "77015550147", min: 38, duration: 64 },
    { file: "office-ac.mp3", from: "77012340955", min: 96, duration: 66 },
  ];
  const liveRows = [];
  for (const x of live) {
    liveRows.push({
      tenantId,
      direction: "in",
      from: x.from,
      to: COMPANY_PHONE,
      operatorId: madina,
      status: "completed",
      startedAt: iso(now - x.min * MIN),
      endedAt: iso(now - x.min * MIN + x.duration * 1000),
      duration: x.duration,
      recordingId: await uploadDemo(x.file),
      aiStatus: "pending",
    });
  }
  const callIds = await insert("calls", [...fromLeads, ...today, ...liveRows]);
  await call(internal.seed.patchMany, { table: "leads", patches: fromLeads.map((c, i) => ({ id: c.leadId!, fields: { callId: callIds[i] } })) });

  // ── Требуемые навыки у части открытых заказов — чтобы подбор по навыкам было видно на демо ──
  const SKILL_BY_SERVICE: Record<string, string[]> = { "ac-install": ["Монтаж сплит-систем"], "wm-repair": ["Стиральные машины"], boiler: ["Бойлеры"], "boiler-service": ["Газовые котлы"], cctv: ["Видеонаблюдение"] };
  const skillPatches = db.orders
    .filter((o) => (o.status === "awaiting_executor" || o.status === "new") && SKILL_BY_SERVICE[o.serviceId])
    .map((o) => ({ id: orderMap.get(o.id)!, fields: { requiredSkills: SKILL_BY_SERVICE[o.serviceId] } }));
  if (skillPatches.length) await call(internal.seed.patchMany, { table: "orders", patches: skillPatches });

  // ── Переписка в разделе «Сообщения»: заявки из Telegram, WhatsApp, OLX и с сайта за последние дни ──
  type Channel = "telegram" | "whatsapp" | "olx" | "site";
  type Msg = { direction: "in" | "out"; text: string; at: number; authorId?: string };
  const ADVERT: Record<string, string> = {
    ac: "Ремонт и чистка кондиционеров — выезд в день обращения",
    appliances: "Ремонт стиральных машин и холодильников на дому",
    plumbing: "Сантехник: протечки, смесители, засоры",
    electric: "Электрик: розетки, проводка, щитки",
    heating: "Установка и ремонт бойлеров и котлов",
    furniture: "Сборка мебели ИКЕА и корпусной",
    cleaning: "Генеральная уборка квартир и офисов",
    it: "Компьютерная помощь и настройка Wi‑Fi",
    intercom: "Домофоны и видеонаблюдение под ключ",
    other: "Мастер на час",
  };
  const WHEN = ["завтра после 18:00", "сегодня до 20:00", "в субботу утром", "в будни после обеда"];
  const convs: { row: Record<string, unknown>; msgs: Msg[] }[] = [];
  const chatId = (n: number) => String(500000000 + Math.floor(frac(n) * 400000000));
  for (const l of db.leads.filter((x) => ["telegram", "whatsapp", "olx", "site"].includes(x.source) && now - Date.parse(x.createdAt) < 10 * 86400_000).slice(0, 45)) {
    const c = clientById.get(l.clientId)!;
    const channel = l.source as Channel;
    const t0 = Date.parse(l.createdAt) - 7 * MIN;
    const op = userMap.get(l.operatorId);
    const msgs: Msg[] =
      channel === "site"
        ? [{ direction: "in", text: `Заявка с сайта: ${l.description}`, at: t0 }]
        : [
            { direction: "in", text: channel === "olx" ? `Здравствуйте! Актуально? ${l.description}` : l.description, at: t0 },
            { direction: "out", text: "Здравствуйте! Спасибо, что написали. Подскажите адрес и когда удобно принять мастера?", at: t0 + 3 * MIN, authorId: op },
            { direction: "in", text: `${c.address ?? c.city}. Удобно ${WHEN[l.number % WHEN.length]}${channel === "olx" ? `. Мой номер ${c.phone.replace(/^7/, "8")}` : ""}`, at: t0 + 6 * MIN },
          ];
    const last = msgs[msgs.length - 1]!;
    const fresh = now - last.at < 3 * 86400_000;
    convs.push({
      row: {
        tenantId,
        channel,
        externalId: channel === "telegram" ? chatId(l.number) : channel === "olx" ? `demo-olx-${l.number}` : c.phone,
        contactName: c.name,
        contactPhone: channel === "telegram" && l.number % 3 === 0 ? undefined : c.phone,
        clientId: clientMap.get(c.id),
        leadId: leadMap.get(l.id),
        subject: channel === "olx" ? ADVERT[serviceById(l.serviceId).category] ?? ADVERT.other : undefined,
        lastMessageAt: iso(last.at),
        lastText: last.text.slice(0, 140),
        lastDirection: last.direction,
        unread: 0,
        status: fresh ? "open" : "closed",
        replyUntil: channel === "whatsapp" ? iso(last.at + 86400_000) : undefined,
      },
      msgs,
    });
  }
  // Свежие непрочитанные обращения без заявки — с них удобно показать «Создать заявку» из чата.
  const unreadToday: { channel: Channel; externalId: string; name: string; phone?: string; subject?: string; texts: string[]; ago: number }[] = [
    { channel: "whatsapp", externalId: "77019887766", name: "Дина", phone: "77019887766", texts: ["Здравствуйте, у вас есть мастер по посудомоечным машинам?", "Bosch не сливает воду, Алматы, Самал-1. Можно сегодня вечером?"], ago: 12 },
    { channel: "olx", externalId: "demo-olx-new-1", name: "Сергей", subject: ADVERT.appliances, texts: ["Актуально? Сколько стоит замена подшипника на Samsung 6 кг?"], ago: 35 },
    { channel: "telegram", externalId: chatId(9001), name: "Айгерим", texts: ["Добрый день! Нужна генеральная уборка 3-комнатной квартиры в эту пятницу, Астана, Есиль"], ago: 8 },
  ];
  for (const u of unreadToday) {
    const msgs: Msg[] = u.texts.map((text, i) => ({ direction: "in", text, at: now - (u.ago - i) * MIN }));
    const last = msgs[msgs.length - 1]!;
    convs.push({
      row: {
        tenantId,
        channel: u.channel,
        externalId: u.externalId,
        contactName: u.name,
        contactPhone: u.phone,
        subject: u.subject,
        lastMessageAt: iso(last.at),
        lastText: last.text.slice(0, 140),
        lastDirection: "in",
        unread: msgs.length,
        status: "open",
        replyUntil: u.channel === "whatsapp" ? iso(last.at + 86400_000) : undefined,
      },
      msgs,
    });
  }
  const convIds = await insert("conversations", convs.map((c) => c.row));
  await insert(
    "conversationMessages",
    convs.flatMap((c, i) =>
      c.msgs.map((m) => ({ conversationId: convIds[i], direction: m.direction, kind: "text", text: m.text, at: iso(m.at), authorId: m.authorId, status: m.direction === "out" ? "read" : undefined })),
    ),
  );

  // ── Отзывы клиентов по выполненным заказам и рейтинг мастеров по той же формуле, что на сервере ──
  const DONE = new Set(["done", "awaiting_payment", "paid", "closed"]);
  const COMMENTS: Record<number, string[]> = {
    5: ["Всё сделал быстро и аккуратно, спасибо!", "Мастер пришёл вовремя, объяснил, что сломалось", "Рекомендую, работает чисто", "Отлично, кондиционер снова холодит"],
    4: ["Хорошо, но приехал на полчаса позже", "Сделал всё, но пришлось подождать запчасть", "Нормально, без замечаний"],
    3: ["Работу сделал, но мусор оставил", "Долго ждали мастера"],
    2: ["Пришлось вызывать повторно"],
  };
  const reviewRows: Record<string, unknown>[] = [];
  const ratingsByExecutor = new Map<string, number[]>();
  for (const o of db.orders) {
    if (!o.executorId || !o.doneAt || !DONE.has(o.status) || frac(o.number + 3) > 0.55) continue;
    const roll = frac(o.number + 7);
    const rating = roll < 0.7 ? 5 : roll < 0.9 ? 4 : roll < 0.97 ? 3 : 2;
    const pool = COMMENTS[rating]!;
    const viaLink = frac(o.number + 11) < 0.6;
    reviewRows.push({
      tenantId,
      orderId: orderMap.get(o.id),
      executorId: exMap.get(o.executorId),
      clientId: clientMap.get(o.clientId),
      rating,
      text: frac(o.number + 13) < 0.4 ? pool[o.number % pool.length] : undefined,
      via: viaLink ? "link" : "operator",
      at: iso(Date.parse(o.doneAt) + (2 + Math.floor(frac(o.number + 17) * 28)) * 3600_000),
      authorId: viaLink ? undefined : userMap.get("u-madina"),
    });
    ratingsByExecutor.set(o.executorId, [...(ratingsByExecutor.get(o.executorId) ?? []), rating]);
  }
  await insert("reviews", reviewRows);
  await call(internal.seed.patchMany, {
    table: "executors",
    patches: [...ratingsByExecutor.entries()].map(([id, list]) => ({ id: exMap.get(id)!, fields: { rating: bayesianRating(list), reviews: list.length } })),
  });

  // ── Расходы на рекламу за три месяца — для стоимости заявки и заказа в аналитике ──
  const monthKey = (ms: number) => new Date(ms + 5 * 3600_000).toISOString().slice(0, 7);
  const months = [0, 1, 2].map((k) => {
    const d = new Date(now + 5 * 3600_000);
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - k);
    return monthKey(d.getTime() - 5 * 3600_000);
  });
  const SPEND: [string, number][] = [["olx", 150_000], ["instagram", 120_000], ["site", 90_000]];
  await insert(
    "adSpend",
    months.flatMap((month, i) => SPEND.map(([source, amount]) => ({ month, source, amount: Math.round(amount * (1 - i * 0.08)), updatedAt: iso(now), updatedBy: userMap.get("u-owner") }))),
  );
  const CAMPAIGN_SPEND: [string, number][] = [["ac-oct-search", 60_000], ["wm-autumn", 25_000], ["ac-oct-reels", 70_000]];
  await insert(
    "campaignSpend",
    months.flatMap((month, i) => CAMPAIGN_SPEND.map(([campaign, amount]) => ({ month, campaign, amount: Math.round(amount * (1 - i * 0.1)), updatedAt: iso(now), updatedBy: userMap.get("u-owner") }))),
  );

  // ── Журнал действий за две недели — из событий демо-заявок и заказов, чтобы журнал не был пустым ──
  const userById = new Map(db.users.map((u) => [u.id, u]));
  const orderById = new Map(db.orders.map((o) => [o.id, o]));
  const AUDIT_KIND: Partial<Record<string, string>> = {
    created: "order.created",
    status: "order.status",
    assigned: "order.assigned",
    taken: "order.taken",
    finance: "order.finance",
    payment: "order.payment",
    edited: "order.info",
    published: "order.published",
  };
  const since = now - 14 * 86400_000;
  const auditRows: Record<string, unknown>[] = [];
  const CHANNEL_ACTOR = { site: "Сайт", bot: "Telegram" } as const;
  for (const l of db.leads) {
    if (Date.parse(l.createdAt) < since) continue;
    // Заявку канала завёл канал, а не оператор (он её только взял в работу).
    const origin = originOf(l);
    const u = origin === "operator" ? userById.get(l.operatorId) : undefined;
    auditRows.push({
      tenantId,
      at: l.createdAt,
      actorId: u ? userMap.get(u.id) : undefined,
      actorName: u?.name ?? (origin === "operator" ? "Система" : CHANNEL_ACTOR[origin]),
      actorRole: u?.role,
      action: "lead.created",
      entity: "lead",
      entityId: leadMap.get(l.id),
      summary: `Заявка №${l.number}: ${serviceById(l.serviceId).label} (${clientById.get(l.clientId)?.name ?? "клиент"})`,
    });
  }
  for (const h of db.history) {
    const action = AUDIT_KIND[h.kind];
    if (!action || Date.parse(h.at) < since || h.actor.type === "client") continue;
    const o = orderById.get(h.orderId);
    if (!o) continue;
    const u = h.actor.type === "user" ? userById.get(h.actor.id) : undefined;
    auditRows.push({
      tenantId,
      at: h.at,
      actorId: u ? userMap.get(u.id) : undefined,
      actorName: u?.name ?? "Система",
      actorRole: u?.role,
      action,
      entity: "order",
      entityId: orderMap.get(o.id),
      summary: `Заказ №${o.number}: ${h.text}`,
    });
  }
  auditRows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  await insert("audit", auditRows);

  const logins = db.users.map((u) => ({ login: loginOf(u), password }));
  for (let i = 0; i < logins.length; i += 5) await call(internal.seed.logins, { logins: logins.slice(i, i + 5) });
  await call(internal.seed.processCalls, { ids: callIds.slice(-liveRows.length) as Id<"calls">[] });
  console.log(`AI разбирает записи звонков: ${liveRows.length}. Через ~30–60 секунд появятся новые заявки.`);
  if (links.length) console.log(`Привязки Telegram сохранены: ${links.length}`);
  console.log(`Готово. Логины: ${logins.slice(0, 5).map((l) => l.login).join(", ")}… (пароль — из DEMO_PASSWORD)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
