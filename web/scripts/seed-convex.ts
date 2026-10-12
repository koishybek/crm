// Заливка демо-данных в Convex: npm run seed (нужны SEED_SECRET и ALLOW_SEED=1 на деплойменте).
// Генерация — локально (время считается в часовом поясе этой машины), вставка — пачками через seed:ingest.
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { buildSeed } from "../src/data/seed";
import { ACTIVE_STATUSES } from "../src/data/catalog";
import type { Actor } from "../src/data/types";

const envLocal = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .map((l) => /^([A-Z_]+)=(\S*)/.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const url = process.env.CONVEX_URL ?? envLocal.VITE_CONVEX_URL;
const secret = process.env.SEED_SECRET;
const password = process.env.DEMO_PASSWORD ?? "Demo-2026";
if (!url || !secret) throw new Error("Нужны CONVEX_URL (или .env.local) и SEED_SECRET");

const client = new ConvexHttpClient(url);
type Table = "executors" | "users" | "clients" | "leads" | "orders" | "messages" | "history" | "interactions" | "clientNotes" | "notifications" | "counters" | "calls";

async function insert(table: Table, rows: Record<string, unknown>[]): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < rows.length; i += 150) {
    ids.push(...(await client.mutation(api.seed.ingest, { secret: secret!, table, rows: rows.slice(i, i + 150) })));
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
  const uploadUrl = await client.mutation(api.seed.uploadUrl, { secret: secret! });
  const res = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": "audio/mpeg" }, body: readFileSync(new URL(`./demo-calls/${file}`, import.meta.url)) });
  if (!res.ok) throw new Error(`Не загрузилась запись ${file}: HTTP ${res.status}`);
  return ((await res.json()) as { storageId: string }).storageId;
}

async function main() {
  // Привязки Telegram переживают перезаливку: людям не нужно заново жать «Подключить».
  const links = await client.query(api.seed.telegramLinks, { secret: secret! });
  const tgLinks = new Map([...links.map((l) => [l.name, l.chatId] as const), ...links.map((l) => [l.login, l.chatId] as const)]);
  if (process.argv.includes("--wipe")) {
    console.log("Очищаю базу…");
    for (const t of ["categories", "services", "notifications", "clientNotes", "interactions", "history", "messages", "calls", "botChats", "orders", "leads", "clients", "users", "executors", "counters", "authAccounts", "authSessions", "authRefreshTokens", "authVerificationCodes", "authVerifiers", "authRateLimits"] as const) {
      while ((await client.mutation(api.seed.wipe, { secret: secret!, table: t })) > 0);
    }
    while ((await client.mutation(api.seed.wipeFiles, { secret: secret! })) > 0);
  }
  const db = buildSeed(new Date());
  console.log("Заливаю демо-данные…");

  const exIds = await insert("executors", db.executors.map(strip));
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

  const leadIds = await insert(
    "leads",
    db.leads.map((l) => {
      const { orderId: _o, ...rest } = strip(l);
      void _o;
      return { ...rest, clientId: clientMap.get(l.clientId), operatorId: userMap.get(l.operatorId) };
    }),
  );
  const leadMap = new Map(db.leads.map((l, i) => [l.id, leadIds[i]!]));

  const orderIds = await insert(
    "orders",
    db.orders.map((o) => ({
      ...strip(o),
      clientId: clientMap.get(o.clientId),
      leadId: o.leadId ? leadMap.get(o.leadId) : undefined,
      executorId: o.executorId ? exMap.get(o.executorId) : undefined,
      createdBy: userMap.get(o.createdBy),
      files: o.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })),
    })),
  );
  const orderMap = new Map(db.orders.map((o, i) => [o.id, orderIds[i]!]));

  const patches = db.leads.filter((l) => l.orderId).map((l) => ({ id: leadMap.get(l.id)!, fields: { orderId: orderMap.get(l.orderId!) } }));
  for (let i = 0; i < patches.length; i += 200) await client.mutation(api.seed.patchMany, { secret: secret!, table: "leads", patches: patches.slice(i, i + 200) });

  const actor = (a: Actor): Actor => (a.type === "user" ? { type: "user", id: userMap.get(a.id)! } : a.type === "client" ? { type: "client", id: clientMap.get(a.id)! } : a);
  await insert("messages", db.messages.map((m) => ({ ...strip(m), orderId: orderMap.get(m.orderId), author: actor(m.author), files: m.files.map((f) => ({ id: f.id, name: f.name, kind: f.kind })) })));
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
  await client.mutation(api.seed.patchMany, { secret: secret!, table: "leads", patches: fromLeads.map((c, i) => ({ id: c.leadId!, fields: { callId: callIds[i] } })) });

  const logins = db.users.map((u) => ({ login: loginOf(u), password }));
  for (let i = 0; i < logins.length; i += 5) await client.action(api.seed.logins, { secret: secret!, logins: logins.slice(i, i + 5) });
  await client.mutation(api.seed.processCalls, { secret: secret!, ids: callIds.slice(-liveRows.length) as Id<"calls">[] });
  console.log(`AI разбирает записи звонков: ${liveRows.length}. Через ~30–60 секунд появятся новые заявки.`);
  if (links.length) console.log(`Привязки Telegram сохранены: ${links.length}`);
  console.log(`Готово. Логины: ${logins.slice(0, 5).map((l) => l.login).join(", ")}… пароль «${password}»`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
