/// <reference types="vite/client" />
// Письма через обычный ящик (SMTP): выбор транспорта, диалог SMTP на поддельном сервере, письмо (MIME), разбор ошибок,
// повторы, мониторинг и отсутствие пароля и данных писем в логах и ошибках. Соединение (node:tls) подменено.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { notify } from "./lib/domain";
import { buildMessage, dotStuff, encodeWord, ReplyReader, SmtpError, SmtpLinkError, smtpOutcome, smtpSend, type SmtpDialer, type SmtpLink, type SmtpServer } from "./lib/smtp";

const h = vi.hoisted(() => ({ dialer: null as null | ((o: { host: string; port: number; secure: boolean; timeoutMs: number }) => Promise<unknown>) }));
vi.mock("./lib/smtpSocket", () => ({ nodeDialer: (o: { host: string; port: number; secure: boolean; timeoutMs: number }) => h.dialer!(o) }));

const modules = Object.fromEntries(
  Object.entries(import.meta.glob("./**/*.*s")).filter(([path]) => !path.endsWith(".d.ts") && !path.includes(".test.")),
);

// ── Поддельный почтовый сервер ───────────────────────────────────────────────

type Stage = "greeting" | "auth" | "from" | "rcpt" | "data" | "message";
interface Script {
  /** Строки возможностей в ответе на EHLO (без STARTTLS — его сервер добавляет сам до перехода на TLS). */
  caps?: string[];
  starttls?: boolean;
  /** Ответ сервера на этапе вместо успешного. */
  replies?: Partial<Record<Stage, string>>;
  dialError?: SmtpLinkError;
  /** Сервер молчит после соединения. */
  silent?: boolean;
}

function fakeServer(script: Script = {}) {
  const state = { commands: [] as string[], message: "", upgraded: false, dials: [] as { host: string; port: number; secure: boolean }[] };
  const dialer: SmtpDialer = async ({ host, port, secure }) => {
    state.dials.push({ host, port, secure });
    if (script.dialError) throw script.dialError;
    const reader = new ReplyReader();
    const say = (line: string) => reader.push(`${line}\r\n`);
    let tls = secure;
    let inData = false;
    let authStep = 0;
    if (!script.silent) say(script.replies?.greeting ?? "220 smtp.test ESMTP ready");
    const link: SmtpLink = {
      async send(data) {
        if (inData) {
          inData = false;
          state.message = data;
          say(script.replies?.message ?? "250 2.0.0 OK queued");
          return;
        }
        const line = data.replace(/\r\n$/, "");
        state.commands.push(line);
        if (authStep > 0) {
          authStep++;
          say(authStep === 2 ? "334 UGFzc3dvcmQ6" : (script.replies?.auth ?? "235 2.7.0 Accepted"));
          if (authStep === 3) authStep = 0;
          return;
        }
        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") {
          const lines = ["smtp.test greets you", ...(script.caps ?? ["SIZE 35882577", "AUTH LOGIN PLAIN XOAUTH2"]), ...(!tls && script.starttls !== false ? ["STARTTLS"] : [])];
          // Ответ кусками, как из сети: строка может разорваться посередине.
          const raw = lines.map((l, i) => `250${i === lines.length - 1 ? " " : "-"}${l}\r\n`).join("");
          reader.push(raw.slice(0, 17));
          reader.push(raw.slice(17));
        } else if (verb === "STARTTLS") say("220 2.0.0 Ready to start TLS");
        else if (line === "AUTH LOGIN") {
          authStep = 1;
          say("334 VXNlcm5hbWU6");
        } else if (verb === "AUTH") say(script.replies?.auth ?? "235 2.7.0 Accepted");
        else if (verb === "MAIL") say(script.replies?.from ?? "250 2.1.0 OK");
        else if (verb === "RCPT") say(script.replies?.rcpt ?? "250 2.1.5 OK");
        else if (verb === "DATA") {
          if (script.replies?.data) say(script.replies.data);
          else {
            inData = true;
            say("354 Go ahead");
          }
        } else if (verb === "QUIT") say("221 2.0.0 closing connection");
        else say("500 5.5.1 Unrecognized command");
      },
      reply: () => reader.next(),
      async startTls() {
        tls = true;
        state.upgraded = true;
      },
      close: () => reader.fail(new SmtpLinkError("network")),
    };
    return link;
  };
  return { dialer, state };
}

const PASS = "abcd efgh SECRET-pass";
const USER = "hms.noreply@gmail.com";
const server = (over: Partial<SmtpServer> = {}): SmtpServer => ({ host: "smtp.test", port: 465, secure: true, user: USER, pass: PASS, ...over });
const mail = { from: { address: USER, name: "Home Max Service" }, to: "owner@test.kz", subject: "Оплата по заказу №1001", text: "Оплата 5 000 ₸\n.точка в начале строки", html: "<p>Оплата</p>", key: "notification/k57abc" };
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const QUICK = { stepMs: 50, totalMs: 80 };

// ── Протокол и письмо ────────────────────────────────────────────────────────

describe("диалог SMTP", () => {
  test("порт 465: TLS сразу, AUTH PLAIN, конверт, письмо, QUIT — пароль только в AUTH", async () => {
    const s = fakeServer();
    await smtpSend(s.dialer, server(), mail);
    expect(s.state.dials).toEqual([{ host: "smtp.test", port: 465, secure: true }]);
    expect(s.state.upgraded).toBe(false);
    expect(s.state.commands).toEqual([`EHLO gmail.com`, `AUTH PLAIN ${b64(`\u0000${USER}\u0000${PASS}`)}`, `MAIL FROM:<${USER}>`, "RCPT TO:<owner@test.kz>", "DATA", "QUIT"]);
    expect(s.state.message.endsWith("\r\n.\r\n")).toBe(true);
    expect(s.state.message).not.toContain(PASS);
  });

  test("порт 587: STARTTLS обязателен, после него — новый EHLO; без STARTTLS пароль не отправляется", async () => {
    const s = fakeServer();
    await smtpSend(s.dialer, server({ port: 587, secure: false }), mail);
    expect(s.state.upgraded).toBe(true);
    expect(s.state.commands.slice(0, 3)).toEqual(["EHLO gmail.com", "STARTTLS", "EHLO gmail.com"]);

    const plain = fakeServer({ starttls: false });
    const e = await smtpSend(plain.dialer, server({ port: 587, secure: false }), mail).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SmtpError);
    expect(plain.state.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
    expect(smtpOutcome(e, 30_000)).toEqual({ kind: "fail", note: "Почтовый сервер не поддерживает шифрование STARTTLS — укажите порт 465" });
  });

  test("сервер предлагает только AUTH LOGIN — логин и пароль отдельными шагами", async () => {
    const s = fakeServer({ caps: ["AUTH LOGIN"] });
    await smtpSend(s.dialer, server(), mail);
    expect(s.state.commands.slice(1, 4)).toEqual(["AUTH LOGIN", b64(USER), b64(PASS)]);
  });

  test("письмо: тема в RFC 2047, Message-ID из ключа, тела в base64, точка в начале строки удвоена, CRLF", async () => {
    const msg = buildMessage({ ...mail, replyTo: "info@test.kz" }, new Date("2026-10-14T09:30:05Z"), "b1");
    expect(msg).toContain('From: "Home Max Service" <hms.noreply@gmail.com>\r\n');
    expect(msg).toContain("To: <owner@test.kz>\r\n");
    expect(msg).toContain("Reply-To: <info@test.kz>\r\n");
    expect(msg).toContain("Date: Wed, 14 Oct 2026 09:30:05 +0000\r\n");
    expect(msg).toContain("Message-ID: <notification.k57abc@gmail.com>\r\n");
    expect(msg).toContain("Auto-Submitted: auto-generated\r\n");
    expect(msg).toMatch(/Subject: =\?UTF-8\?B\?/);
    const text = /Content-Type: text\/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)--b1/.exec(msg)![1]!.replace(/\r\n/g, "");
    expect(new TextDecoder().decode(Uint8Array.from(atob(text), (c) => c.charCodeAt(0)))).toBe(mail.text);
    expect(msg.split("\r\n").every((l) => l.length <= 998)).toBe(true);
    expect(dotStuff("a\n.b\r\n..c")).toBe("a\r\n..b\r\n...c");
  });

  test("тема: длинная кириллица — куски до 75 символов, перевод строки не делает новый заголовок", () => {
    const words = encodeWord("Просрочка: заказ №1001 — кондиционер не холодит, клиент ждёт мастера с утра").split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);
    const msg = buildMessage({ ...mail, subject: "Тема\r\nBcc: evil@x.kz" }, new Date(), "b2");
    expect(msg).not.toMatch(/^Bcc:/m);
  });

  test("ответ сервера по кускам и многострочный; мусор вместо ответа — ошибка протокола", async () => {
    const r = new ReplyReader();
    const first = r.next();
    r.push("250-smtp.test\r\n250-AU");
    r.push("TH PLAIN\r\n250 OK\r\n");
    expect(await first).toEqual({ code: 250, lines: ["smtp.test", "AUTH PLAIN", "OK"] });
    const bad = new ReplyReader();
    bad.push("HTTP/1.1 400 Bad Request\r\n");
    await expect(bad.next()).rejects.toMatchObject({ kind: "protocol" });
  });

  test("таймауты: сервер молчит — отправка обрывается сама", async () => {
    const s = fakeServer({ silent: true });
    const e = await smtpSend(s.dialer, server(), mail, QUICK).catch((x: unknown) => x);
    expect(e).toMatchObject({ stage: "greeting", kind: "timeout" });
    expect(smtpOutcome(e, 30_000)).toMatchObject({ kind: "retry", delayMs: 30_000 });
  });
});

describe("ошибки SMTP → итог", () => {
  const fail = async (script: Script) => {
    const e = await smtpSend(fakeServer(script).dialer, server(), mail, QUICK).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(SmtpError);
    const out = smtpOutcome(e, 120_000);
    // Ни пароля, ни логина, ни адреса получателя, ни текста ответа сервера.
    const shown = JSON.stringify(out) + String((e as Error).message);
    for (const secret of [PASS, USER, "owner@test.kz", "Username and Password", "spam"]) expect(shown).not.toContain(secret);
    // Ошибка отправки — всегда «повтор» или «отказ» с пояснением.
    if (out.kind === "sent") throw new Error("ожидали ошибку");
    return out;
  };

  test("неверный пароль (535) — сразу ошибка с подсказкой про пароль приложения", async () => {
    expect(await fail({ replies: { auth: "535 5.7.8 Username and Password not accepted for hms.noreply@gmail.com" } })).toEqual({
      kind: "fail",
      note: "Почтовый сервер не принял логин или пароль (SMTP 535 5.7.8) — нужен пароль приложения (Gmail, Яндекс, Mail.ru), а не обычный пароль ящика",
    });
  });
  test("Gmail требует пароль приложения (534) — тоже про пароль", async () => {
    expect((await fail({ replies: { auth: "534 5.7.9 Application-specific password required" } })).kind).toBe("fail");
  });
  test("временная ошибка (421, 451) — повтор по расписанию", async () => {
    expect(await fail({ replies: { greeting: "421 4.7.0 Try again later" } })).toEqual({ kind: "retry", delayMs: 120_000, note: "Почтовый сервер просит повторить позже (SMTP 421 4.7.0)" });
    expect((await fail({ replies: { message: "451 4.3.0 Mail server temporarily rejected message" } })).kind).toBe("retry");
  });
  test("отправитель не тот (Яндекс 553) — подсказка про EMAIL_FROM", async () => {
    expect((await fail({ replies: { from: "553 5.7.1 Sender address rejected: not owned by auth user owner@test.kz" } })).note).toContain("EMAIL_FROM должен быть адресом этого ящика");
  });
  test("получатель, спам, суточный лимит", async () => {
    expect((await fail({ replies: { rcpt: "550 5.1.1 owner@test.kz no such user" } })).note).toBe("Почтовый сервер не принял адрес получателя (SMTP 550 5.1.1)");
    expect((await fail({ replies: { message: "554 5.7.1 Message rejected under suspicion of spam" } })).note).toBe("Почтовый сервер отклонил письмо (SMTP 554 5.7.1)");
    expect((await fail({ replies: { from: "550 5.4.5 Daily user sending limit exceeded" } })).note).toContain("суточный лимит");
  });
  test("нет связи и TLS: связь — повтор, сертификат — сразу ошибка", async () => {
    expect(await fail({ dialError: new SmtpLinkError("network") })).toMatchObject({ kind: "retry", note: "Нет связи с почтовым сервером — проверьте EMAIL_SMTP_HOST и порт" });
    expect((await fail({ dialError: new SmtpLinkError("tls") })).kind).toBe("fail");
  });
});

// ── Вместе с очередью писем (convex-test) ────────────────────────────────────

const T = "t-komfort";

describe("транспорт SMTP в приложении", () => {
  let srv: ReturnType<typeof fakeServer>;
  let logs: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    srv = fakeServer();
    h.dialer = (o) => srv.dialer(o);
    logs = [];
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(" ")));
    vi.stubEnv("EMAIL_API_KEY", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("EMAIL_SMTP_HOST", "smtp.gmail.com");
    vi.stubEnv("EMAIL_SMTP_USER", USER);
    vi.stubEnv("EMAIL_SMTP_PASS", PASS);
    vi.stubEnv("APP_URL", "https://app.test/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "resend-id" })),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    // Ни в одном логе — ни пароля, ни логина ящика, ни адресов и тем писем.
    for (const l of logs) for (const secret of [PASS, USER, "owner@test.kz", "Просрочка"]) expect(l).not.toContain(secret);
  });

  async function setup() {
    const t = convexTest(schema, modules);
    const ids = await t.run(async (ctx) => {
      const owner = await ctx.db.insert("users", { name: "Владелец Тест", email: "owner@test.kz", role: "owner", tenantId: T, active: true, notifyEmail: true });
      const operator = await ctx.db.insert("users", { name: "Оператор", email: "op@test.kz", role: "operator", tenantId: T, active: true });
      return { owner, operator };
    });
    const as = (id: Id<"users">) => t.withIdentity({ subject: `${id}|s` });
    const health = () => t.run((ctx) => ctx.db.query("systemStatus").withIndex("by_key", (q) => q.eq("key", "email")).unique());
    return { t, ids, as, health, flush: () => t.finishAllScheduledFunctions(vi.runAllTimers) };
  }

  test("выбор: без ключа Resend — ящик по SMTP (порт 465, SSL, отправитель — сам ящик); с ключом — Resend", async () => {
    const s = await setup();
    const card = await s.as(s.ids.owner).query(api.email.settings, {});
    expect(card).toMatchObject({ configured: true, transport: "smtp", missing: [], from: `Home Max Service <${USER}>`, smtp: { host: "smtp.gmail.com", port: 465, security: "SSL", user: USER } });
    expect(JSON.stringify(card)).not.toContain(PASS);
    expect(await s.as(s.ids.owner).action(api.email.sendTest, {})).toEqual({ status: "sent" });
    expect(srv.state.dials).toEqual([{ host: "smtp.gmail.com", port: 465, secure: true }]);
    expect(srv.state.commands).toContain("RCPT TO:<owner@test.kz>");
    expect(fetch).not.toHaveBeenCalled();
    expect((await s.health())?.okAt).toBeDefined();
    await expect(s.as(s.ids.operator).action(api.email.sendTest, {})).rejects.toThrow("Нет доступа");

    vi.stubEnv("EMAIL_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "Home Max Service <noreply@notify.test.kz>");
    srv.state.dials = [];
    expect(await s.as(s.ids.owner).query(api.email.settings, {})).toMatchObject({ transport: "resend", configured: true });
    expect(await s.as(s.ids.owner).action(api.email.sendTest, {})).toEqual({ status: "sent" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(srv.state.dials).toHaveLength(0);
  });

  test("порт 587 — STARTTLS; EMAIL_FROM и EMAIL_REDIRECT_TO действуют и для ящика", async () => {
    vi.stubEnv("EMAIL_SMTP_PORT", "587");
    vi.stubEnv("EMAIL_FROM", "Офис Home Max <hms.noreply@gmail.com>");
    vi.stubEnv("EMAIL_REDIRECT_TO", "qa@test.kz");
    const s = await setup();
    expect(await s.as(s.ids.owner).query(api.email.settings, {})).toMatchObject({ smtp: { port: 587, security: "STARTTLS" }, from: "Офис Home Max <hms.noreply@gmail.com>" });
    await s.t.run((ctx) => notify(ctx, [s.ids.owner], "Просрочка: заказ №1001", { link: "/orders/x", email: { kind: "order_overdue" } }));
    await s.flush();
    expect(srv.state.upgraded).toBe(true);
    expect(srv.state.commands).toContain("RCPT TO:<qa@test.kz>");
    expect(srv.state.message).toMatch(/From: =\?UTF-8\?B\?[^\r]+ <hms\.noreply@gmail\.com>/);
  });

  test("неверный пароль — без повторов, ошибка в мониторинге с подсказкой и без пароля", async () => {
    srv = fakeServer({ replies: { auth: "535 5.7.8 Username and Password not accepted" } });
    const s = await setup();
    const r = await s.t.action(internal.email.send, { to: "owner@test.kz", subject: "Просрочка", text: "Просрочка", html: "<p>Просрочка</p>" });
    expect(r).toMatchObject({ status: "failed" });
    await s.flush();
    expect(srv.state.dials).toHaveLength(1);
    const mark = await s.health();
    expect(mark?.error).toContain("пароль приложения");
    expect(JSON.stringify(mark)).not.toContain(PASS);
    expect(JSON.stringify(r)).not.toContain(PASS);
  });

  test("нет связи — повтор по расписанию с тем же ключом письма (тот же Message-ID), вторая попытка доходит", async () => {
    let first = true;
    const ok = fakeServer();
    h.dialer = async (o) => {
      if (first) {
        first = false;
        throw new SmtpLinkError("network");
      }
      return ok.dialer(o);
    };
    const s = await setup();
    const r = await s.t.action(internal.email.send, { to: "owner@test.kz", subject: "Просрочка", text: "Просрочка", html: "<p>Просрочка</p>", key: "notification/abc" });
    expect(r).toEqual({ status: "retry", attempt: 1 });
    await s.flush();
    expect(ok.state.message).toContain("Message-ID: <notification.abc@gmail.com>");
    expect((await s.health())?.okAt).toBeDefined();
  });

  test("ящик настроен не до конца — «не настроено» с именами переменных, письма не ставятся", async () => {
    vi.stubEnv("EMAIL_SMTP_PASS", "");
    vi.stubEnv("EMAIL_SMTP_PORT", "smtp");
    const s = await setup();
    expect(await s.as(s.ids.owner).query(api.email.settings, {})).toMatchObject({ configured: false, transport: "smtp", missing: ["EMAIL_SMTP_PASS", "EMAIL_SMTP_PORT (465 или 587)"] });
    await s.t.run((ctx) => notify(ctx, [s.ids.owner], "Просрочка: заказ №1001", { link: "/orders/x", email: { kind: "order_overdue" } }));
    await s.flush();
    expect(srv.state.dials).toHaveLength(0);

    // Логин — не email и отправитель не задан: письмо не от кого отправить.
    vi.stubEnv("EMAIL_SMTP_PASS", PASS);
    vi.stubEnv("EMAIL_SMTP_PORT", "");
    vi.stubEnv("EMAIL_SMTP_USER", "hms-login");
    expect((await s.as(s.ids.owner).query(api.email.settings, {})).missing).toEqual(["EMAIL_FROM (логин ящика — не email, укажите адрес отправителя)"]);
  });
});
