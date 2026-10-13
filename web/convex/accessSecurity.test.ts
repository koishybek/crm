/// <reference types="vite/client" />
// Остаток аудита безопасности: временные пароли и смена своего (M-8, E30, L-1), отключённые пользователи (M-5),
// область руководителя (M-7), первый владелец и демо-данные (H-1, E17), вебхук АТС и показ ключа (L-2, E20, M-11),
// мелочи (L-6, L-8, M-2) и сравнение секретов за постоянное время.
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { safeEqual } from "./lib/crypto";
import schema from "./schema";

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

const T = "t-test";
const at = new Date().toISOString();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true });
    const operator = await ctx.db.insert("users", { name: "Оператор Тест", email: "op@test.kz", phone: "77010000001", role: "operator", tenantId: T, active: true });
    const manager = await ctx.db.insert("users", { name: "Руководитель Климат", email: "boss-ac@test.kz", phone: "77010000002", role: "manager", categories: ["ac"], tenantId: T, active: true });
    const mk = async (name: string, phone: string, categories: string[], chat?: string) => {
      const ex = await ctx.db.insert("executors", { tenantId: T, name, phone, city: "Алматы", categories, skills: [], available: true, rating: 5, reviews: 0, cooperation: "freelance", joinedAt: at });
      const user = await ctx.db.insert("users", { name, email: phone, phone, role: "executor", executorId: ex, tenantId: T, active: true, telegramChatId: chat });
      return { ex, user };
    };
    const ac = await mk("Асет Климатов", "77000000001", ["ac"], "555");
    const plumb = await mk("Берик Сантехников", "77000000002", ["plumbing"]);
    const client = await ctx.db.insert("clients", { tenantId: T, name: "Клиент Тест", kind: "person", phone: "77071234567", city: "Алматы", source: "olx", tags: [], createdAt: at, ordersCount: 0, activeCount: 0, lastActivityAt: at });
    const order = await ctx.db.insert("orders", {
      tenantId: T,
      number: 1001,
      clientId: client,
      clientName: "Клиент Тест",
      clientPhone: "77071234567",
      source: "olx",
      serviceId: "ac-repair",
      category: "ac",
      description: "Не холодит",
      city: "Алматы",
      address: "ул. Абая, 1",
      deadline: new Date(Date.now() + 86400_000).toISOString(),
      priority: "normal",
      status: "awaiting_executor",
      clientPrice: 30000,
      payoutMode: "fixed",
      payoutValue: 21000,
      payments: [],
      payoutPaid: false,
      createdAt: at,
      createdBy: owner,
      files: [],
    });
    return { owner, operator, manager, ac, plumb, client, order };
  });
  const as = (id: Id<"users">, session = "s") => t.withIdentity({ subject: `${id}|${session}` });
  const user = (id: Id<"users">) => t.run((ctx) => ctx.db.get(id));
  const journal = () => t.run((ctx) => ctx.db.query("audit").collect());
  return { t, ids, as, user, journal };
}

type Env = Awaited<ReturnType<typeof setup>>;

/** Сессия Convex Auth с одним refresh-токеном — как после настоящего входа. */
async function session(t: Env["t"], userId: Id<"users">): Promise<Id<"authSessions">> {
  return t.run(async (ctx) => {
    const sessionId = await ctx.db.insert("authSessions", { userId, expirationTime: Date.now() + 86400_000 });
    await ctx.db.insert("authRefreshTokens", { sessionId, expirationTime: Date.now() + 86400_000 });
    return sessionId;
  });
}
const sessionsOf = (t: Env["t"], userId: Id<"users">) => t.run((ctx) => ctx.db.query("authSessions").withIndex("userId", (q) => q.eq("userId", userId)).collect());
const refreshTokensOf = (t: Env["t"], sessionId: Id<"authSessions">) => t.run((ctx) => ctx.db.query("authRefreshTokens").withIndex("sessionId", (q) => q.eq("sessionId", sessionId)).collect());

describe("временные пароли (аудит M-8, E30)", () => {
  test("пароль, выданный другим человеком, — временный: сотрудник, мастер, сброс; демо-аккаунты — без смены", async () => {
    const { t, ids, as, user } = await setup();
    const owner = as(ids.owner);
    const staff = await owner.action(api.users.createStaff, { name: "Айдана Сервис", login: "aidana@test.kz", role: "operator" });
    const aidana = (await t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", staff.login)).unique()))!;
    expect(aidana.mustChangePassword).toBe(true);

    const master = await as(ids.operator).action(api.executors.create, { name: "Новый Мастер", phone: "+7 700 000 00 09", city: "Алматы", categories: ["ac"], skills: [], cooperation: "freelance" });
    const masterUser = (await t.run((ctx) => ctx.db.query("users").withIndex("by_executor", (q) => q.eq("executorId", master.id)).first()))!;
    expect(masterUser.mustChangePassword).toBe(true);

    await owner.action(api.users.resetPassword, { userId: ids.operator });
    expect((await user(ids.operator))?.mustChangePassword).toBe(true);

    // Демо-данные заливаются как есть — заказчик показывает демо-доступ без смены пароля.
    vi.stubEnv("ALLOW_SEED", "1");
    const [demoId] = (await t.mutation(internal.seed.ingest, { table: "users", rows: [{ name: "Демо Оператор", email: "demo@test.kz", role: "operator", tenantId: T, active: true }] })) as Id<"users">[];
    expect((await as(demoId!).query(api.users.me, {}))?.mustChangePassword).toBeUndefined();
    expect(await as(demoId!).query(api.leads.list, {})).toMatchObject({ leads: [] });
  });

  test("с временным паролем сервер ничего не отдаёт и ничего не даёт сделать — только экран смены пароля", async () => {
    const { t, ids, as } = await setup();
    await t.run((ctx) => ctx.db.patch(ids.operator, { mustChangePassword: true }));
    const op = as(ids.operator);
    expect(await op.query(api.users.me, {})).toMatchObject({ id: ids.operator, mustChangePassword: true });
    await expect(op.query(api.leads.list, {})).rejects.toThrow("Сначала смените временный пароль");
    await expect(op.mutation(api.clients.create, { name: "Х", phone: "77011112233", city: "Алматы", source: "phone" })).rejects.toThrow("Сначала смените временный пароль");
    expect(await op.query(api.users.team, {})).toBeNull();
    await expect(op.mutation(api.telegram.linkUrl, {})).rejects.toThrow("Нужно войти");
  });

  test("смена своего пароля: нужен текущий, правила длины, другие входы закрываются, текущий остаётся; в журнале — без пароля", async () => {
    const { t, ids, as, user, journal } = await setup();
    const creds = await as(ids.owner).action(api.users.createStaff, { name: "Айдана Сервис", login: "aidana@test.kz", role: "operator" });
    const uid = (await t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", creds.login)).unique()))!._id;
    const current = await session(t, uid);
    const other = await session(t, uid);
    const me = as(uid, current);
    const next = "Свой-пароль-2026";

    await expect(me.action(api.users.changeMyPassword, { current: "не-тот-пароль", next })).rejects.toThrow("Текущий пароль неверный");
    await expect(me.action(api.users.changeMyPassword, { current: creds.password, next: "короткий" })).rejects.toThrow("не короче 10");
    await expect(me.action(api.users.changeMyPassword, { current: creds.password, next: creds.password })).rejects.toThrow();
    expect((await user(uid))?.mustChangePassword).toBe(true);

    await me.action(api.users.changeMyPassword, { current: creds.password, next });
    expect((await user(uid))?.mustChangePassword).toBeUndefined();
    expect((await sessionsOf(t, uid)).map((s) => s._id)).toEqual([current]);
    expect(await refreshTokensOf(t, other)).toHaveLength(0);
    expect(await refreshTokensOf(t, current)).toHaveLength(1);
    const row = (await journal()).find((a) => a.action === "user.password" && a.actorId === uid)!;
    expect(row).toMatchObject({ entityId: uid, meta: { self: true, temporary: true } });
    expect(JSON.stringify(await journal())).not.toContain(next);

    // Старый (временный) пароль больше не подходит, новый — подходит.
    await expect(me.action(api.users.changeMyPassword, { current: creds.password, next: "Ещё-один-пароль-1" })).rejects.toThrow("Текущий пароль неверный");
    await me.action(api.users.changeMyPassword, { current: next, next: "Ещё-один-пароль-1" });
  });

  test("владельцу — пароль от 12 символов (аудит L-1)", async () => {
    const { t, ids, as } = await setup();
    const creds = await as(ids.owner).action(api.users.createStaff, { name: "Второй Владелец", login: "owner2@test.kz", role: "owner" });
    const uid = (await t.run((ctx) => ctx.db.query("users").withIndex("email", (q) => q.eq("email", creds.login)).unique()))!._id;
    await expect(as(uid).action(api.users.changeMyPassword, { current: creds.password, next: "Десять-сим" })).rejects.toThrow("не короче 12");
    await expect(as(ids.owner).action(api.users.createStaff, { name: "Х", login: "x@test.kz", role: "owner", password: "short-pass" })).rejects.toThrow("не короче 12");
  });
});

describe("отключённый пользователь (аудит M-5)", () => {
  test("уведомления отключённому не уходят — ни в колокольчик, ни в Telegram", async () => {
    const { t, ids, as } = await setup();
    // Отключён в обход setActive (Telegram ещё привязан) — проверяем само правило notify.
    await t.run(async (ctx) => {
      await ctx.db.patch(ids.ac.user, { active: false });
      await ctx.db.patch(ids.order, { status: "accepted", executorId: ids.ac.ex });
    });
    await as(ids.owner).mutation(api.orders.changeStatus, { id: ids.order, to: "cancelled", reason: "Клиент передумал" });
    const notes = await t.run((ctx) => ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", ids.ac.user)).collect());
    expect(notes).toHaveLength(0);
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((s) => JSON.stringify(s.args).includes('"chatId":"555"'))).toBe(false);
  });

  test("отключение: Telegram отвязан, мастер снят со смены, все входы закрыты; одна запись в журнале", async () => {
    vi.useFakeTimers();
    const { t, ids, as, user, journal } = await setup();
    const s1 = await session(t, ids.ac.user);
    await session(t, ids.ac.user);
    await as(ids.owner).mutation(api.users.setActive, { userId: ids.ac.user, active: false });
    const u = await user(ids.ac.user);
    expect(u).toMatchObject({ active: false });
    expect(u?.telegramChatId).toBeUndefined();
    expect((await t.run((ctx) => ctx.db.get(ids.ac.ex)))?.available).toBe(false);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await sessionsOf(t, ids.ac.user)).toHaveLength(0);
    expect(await refreshTokensOf(t, s1)).toHaveLength(0);
    const rows = (await journal()).filter((a) => a.entityId === ids.ac.user);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "user.access", meta: { active: false, telegramUnlinked: true, shiftOff: true } });
  });

  test("отключённого мастера нет в подборе, назначить его нельзя даже владельцу", async () => {
    const { t, ids, as } = await setup();
    await as(ids.owner).mutation(api.users.setActive, { userId: ids.ac.user, active: false });
    const detail = await as(ids.owner).query(api.orders.detail, { id: ids.order });
    expect(detail!.executors.map((e) => e.id)).not.toContain(ids.ac.ex);
    await expect(as(ids.owner).mutation(api.orders.assign, { id: ids.order, executorId: ids.ac.ex })).rejects.toThrow("отключён доступ");
    expect((await t.run((ctx) => ctx.db.get(ids.order)))?.executorId).toBeUndefined();
  });
});

describe("область руководителя направления (аудит M-7)", () => {
  test("справочник команды: руководителю — мастера его направлений без контактов сотрудников; мастеру — без других мастеров", async () => {
    const { ids, as } = await setup();
    const forManager = (await as(ids.manager).query(api.users.team, {}))!;
    expect(forManager.executors.map((e) => e.id)).toEqual([ids.ac.ex]);
    expect(forManager.users.map((u) => u.id)).not.toContain(ids.plumb.user);
    expect(forManager.users.every((u) => u.email === "" && u.phone === "")).toBe(true);

    const forMaster = (await as(ids.ac.user).query(api.users.team, {}))!;
    expect(forMaster.users.map((u) => u.id).sort()).toEqual([ids.owner, ids.operator, ids.manager, ids.ac.user].sort());
    expect(forMaster.executors.map((e) => e.id)).toEqual([ids.ac.ex]);
    expect(forMaster.users.every((u) => u.email === "" && u.phone === "")).toBe(true);

    // Владельцу и оператору — все.
    expect((await as(ids.operator).query(api.users.team, {}))!.executors).toHaveLength(2);
  });

  test("руководитель не выбирает клиента из базы по id; по телефону — обычная заявка", async () => {
    const { ids, as } = await setup();
    const input = { clientName: "Кто-то", phone: "77019990011", source: "phone" as const, serviceId: "ac-repair", city: "Алматы", description: "Не холодит", urgency: "normal" as const };
    await expect(as(ids.manager).mutation(api.leads.create, { ...input, clientId: ids.client })).rejects.toThrow("не выбирает клиента");
    await as(ids.manager).mutation(api.leads.create, input);
    await as(ids.operator).mutation(api.leads.create, { ...input, clientId: ids.client });
  });

  test("руководитель не даёт мастеру чужое направление и не уводит заявку в чужое", async () => {
    const { ids, as } = await setup();
    await expect(
      as(ids.manager).mutation(api.executors.update, { id: ids.ac.ex, name: "Асет Климатов", phone: "77000000001", city: "Алматы", categories: ["ac", "plumbing"], skills: [], cooperation: "freelance" }),
    ).rejects.toThrow("своего направления");
    const lead = await as(ids.manager).mutation(api.leads.create, { clientName: "Кто-то", phone: "77019990012", source: "phone", serviceId: "ac-repair", city: "Алматы", description: "Шумит", urgency: "normal" });
    await expect(as(ids.manager).mutation(api.leads.update, { id: lead.id, serviceId: "leak-fix" })).rejects.toThrow("не ваше направление");
  });
});

describe("первый владелец и демо-данные (аудит H-1, E17)", () => {
  test("bootstrapOwner создаёт владельца только в базе без владельцев; пароль от 12 символов", async () => {
    const t = convexTest(schema, modules);
    await expect(t.action(internal.seed.bootstrapOwner, { name: "Алихан", login: "boss@test.kz", password: "короткий" })).rejects.toThrow("не короче 12");
    expect(await t.action(internal.seed.bootstrapOwner, { name: "Алихан", login: " Boss@Test.kz ", password: "Длинный-пароль-2026" })).toBe("boss@test.kz");
    const owners = await t.run((ctx) => ctx.db.query("users").withIndex("by_role", (q) => q.eq("role", "owner")).collect());
    expect(owners.map((u) => [u.email, u.mustChangePassword])).toEqual([["boss@test.kz", undefined]]);
    expect(await t.run((ctx) => ctx.db.query("authAccounts").collect())).toHaveLength(1);
    // Владелец уже есть — второго так не создать (раньше хватало SEED_SECRET).
    await expect(t.action(internal.seed.bootstrapOwner, { name: "Взломщик", login: "evil@test.kz", password: "Длинный-пароль-2026" })).rejects.toThrow("Владелец уже есть");
    expect(await t.run((ctx) => ctx.db.query("users").collect())).toHaveLength(1);
  });

  test("демо-данные — только с ALLOW_SEED=1", async () => {
    const t = convexTest(schema, modules);
    await expect(t.mutation(internal.seed.wipe, { table: "authAccounts" })).rejects.toThrow("ALLOW_SEED");
    await expect(t.mutation(internal.seed.ingest, { table: "users", rows: [{ name: "Х", email: "x@test.kz", role: "owner", tenantId: T, active: true }] })).rejects.toThrow("ALLOW_SEED");
    vi.stubEnv("ALLOW_SEED", "1");
    expect(await t.mutation(internal.seed.wipe, { table: "authAccounts" })).toBe(0);
  });
});

describe("АТС: вебхук и ключ (аудит L-2, E20, M-11)", () => {
  const post = (body: string, headers: Record<string, string> = {}) => ({ method: "POST", body, headers: { "Content-Type": "application/json", ...headers } });

  test("неверный ключ — 403, красная отметка и одна запись в журнале за 10 минут; заголовок важнее адреса", async () => {
    const { t, ids, as, journal } = await setup();
    const secret = await as(ids.owner).mutation(api.calls.regeneratePbxSecret, {});
    const event = JSON.stringify({ event: "ringing", callId: "c1", from: "+77071234567" });
    for (const wrong of ["nope", secret.slice(0, -1), `${secret}x`, ""]) {
      expect((await t.fetch("/pbx/events", post(event, { "X-PBX-Secret": wrong }))).status).toBe(403);
    }
    // Ключ в заголовке неверный — верный ключ в адресе не спасает.
    expect((await t.fetch(`/pbx/events?secret=${secret}`, post(event, { "X-PBX-Secret": "nope" }))).status).toBe(403);
    const rejected = (await journal()).filter((a) => a.action === "integration.pbxRejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ actorName: "АТС", meta: { via: "header" } });
    expect(JSON.stringify(rejected)).not.toContain(secret);
    const mark = await t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "pbx")).unique());
    expect(mark?.error).toBe("АТС прислала событие без ключа или с неверным ключом");

    expect((await t.fetch("/pbx/events", post(event, { "X-PBX-Secret": secret }))).status).toBe(200);
    // Ключ в адресе по-прежнему принимается (АТС без заголовков), хоть это и менее безопасно.
    expect((await t.fetch(`/pbx/events?secret=${secret}`, post(JSON.stringify({ event: "answered", callId: "c1" })))).status).toBe(200);
  });

  test("тело больше 64 КБ — 413; null — 400; время события вне суток — заменяется текущим", async () => {
    const { t, ids, as } = await setup();
    const secret = await as(ids.owner).mutation(api.calls.regeneratePbxSecret, {});
    const h = { "X-PBX-Secret": secret };
    const huge = JSON.stringify({ event: "ringing", callId: "big", note: "x".repeat(70 * 1024) });
    expect((await t.fetch("/pbx/events", post(huge, h))).status).toBe(413);
    expect((await t.fetch("/pbx/events", post("null", h))).status).toBe(400);

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    await t.fetch("/pbx/events", post(JSON.stringify({ event: "ringing", callId: "old", at: "1970-01-01T00:00:00Z" }), h));
    await t.fetch("/pbx/events", post(JSON.stringify({ event: "ringing", callId: "future", at: "2099-01-01T00:00:00Z" }), h));
    await t.fetch("/pbx/events", post(JSON.stringify({ event: "ringing", callId: "fresh", at: hourAgo }), h));
    const calls = await t.run((ctx) => ctx.db.query("calls").collect());
    const started = (id: string) => Date.parse(calls.find((c) => c.externalId === id)!.startedAt);
    expect(Math.abs(started("old") - Date.now())).toBeLessThan(60_000);
    expect(Math.abs(started("future") - Date.now())).toBeLessThan(60_000);
    expect(started("fresh")).toBe(Date.parse(hourAgo));
  });

  test("ключ АТС: в настройках — только последние 4 символа; показ целиком — владельцу и с записью в журнал", async () => {
    const { ids, as, journal } = await setup();
    const owner = as(ids.owner);
    const secret = await owner.mutation(api.calls.regeneratePbxSecret, {});
    const s = await owner.query(api.calls.pbxSettings, {});
    expect(s).toMatchObject({ configured: true, tail: secret.slice(-4) });
    expect(JSON.stringify(s)).not.toContain(secret);
    expect(await owner.mutation(api.calls.revealPbxSecret, {})).toBe(secret);
    expect((await journal()).filter((a) => a.action === "integration.pbxSecretViewed").map((a) => a.actorId)).toEqual([ids.owner]);
    await expect(as(ids.operator).mutation(api.calls.revealPbxSecret, {})).rejects.toThrow("Нет доступа");
  });
});

describe("мелочи аудита (L-6, L-8, M-2)", () => {
  test("исполнитель без профиля мастера не пишет в чужой свободный заказ (L-6)", async () => {
    const { t, ids, as } = await setup();
    const broken = await t.run((ctx) => ctx.db.insert("users", { name: "Без профиля", email: "77000000077", role: "executor", tenantId: T, active: true }));
    await expect(as(broken).mutation(api.orders.addMessage, { orderId: ids.order, text: "Возьму", channel: "client", files: [] })).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("messages").collect())).toHaveLength(0);
  });

  test("исполнителю не видны провайдеры AI (L-8)", async () => {
    const { ids, as } = await setup();
    expect(await as(ids.ac.user).query(api.ai.status, {})).toBeNull();
    expect(await as(ids.operator).query(api.ai.status, {})).not.toBeNull();
  });

  test("доска заказов не глубже 120 дней, сколько бы ни попросили (M-2)", async () => {
    const { t, ids, as } = await setup();
    const doneAgo = (days: number, number: number) =>
      t.run(async (ctx) => {
        const base = (await ctx.db.get(ids.order))!;
        const { _id, _creationTime, ...copy } = base;
        void _id;
        void _creationTime;
        const doneAt = new Date(Date.now() - days * 86400_000).toISOString();
        return ctx.db.insert("orders", { ...copy, number, status: "done", doneAt, createdAt: doneAt });
      });
    const old = await doneAgo(200, 1002);
    const recent = await doneAgo(100, 1003);
    const board = await as(ids.operator).query(api.orders.board, { days: 100_000 });
    expect(board.map((o) => o.id)).toContain(recent);
    expect(board.map((o) => o.id)).not.toContain(old);
  });

  test("сравнение секретов: верно для любых строк, длина и место расхождения не важны", () => {
    expect(safeEqual("s3cr3t-key", "s3cr3t-key")).toBe(true);
    expect(safeEqual("s3cr3t-key", "s3cr3t-kez")).toBe(false);
    expect(safeEqual("s3cr3t-key", "s3cr3t")).toBe(false);
    expect(safeEqual("", "s3cr3t")).toBe(false);
    expect(safeEqual("ключ-АТС", "ключ-АТС")).toBe(true);
    expect(safeEqual("ключ-АТС", "ключ-АТC")).toBe(false); // кириллица и латиница
  });
});
