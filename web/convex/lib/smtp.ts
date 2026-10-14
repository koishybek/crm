// Письма через обычный почтовый ящик (SMTP, логин и пароль приложения) — второй транспорт рядом с Resend (ТЗ п.18).
// Здесь всё, что не зависит от рантайма: сервер из окружения, сборка письма (MIME), диалог SMTP поверх абстрактного
// соединения и разбор ошибок в понятный владельцу текст. Само соединение (node:net / node:tls) — lib/smtpSocket.ts,
// оно работает только в рантайме Node (emailSmtp.ts). В тексты ошибок не попадают ни пароль, ни ответы сервера
// (в них бывают адреса) — только код SMTP и расширенный статус («535 5.7.8»).
import { env } from "../env";
import type { Outcome } from "./mail";

export const SMTP_ENV = ["EMAIL_SMTP_HOST", "EMAIL_SMTP_USER", "EMAIL_SMTP_PASS"] as const;
/** 465 — TLS сразу (SSL); остальные порты (587) — только с STARTTLS: пароль открытым текстом не уходит никогда. */
export const SMTP_TLS_PORT = 465;

export interface SmtpServer {
  host: string;
  port: number;
  /** true — TLS с первого байта (порт 465), false — STARTTLS. */
  secure: boolean;
  user: string;
  pass: string;
}

const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function port(): number | null {
  const raw = env("EMAIL_SMTP_PORT");
  if (!raw) return SMTP_TLS_PORT;
  const n = Number(raw);
  return /^\d{1,5}$/.test(raw) && n >= 1 && n <= 65535 ? n : null;
}

/** Задана хоть одна переменная SMTP — владелец выбрал этот транспорт. */
export const smtpChosen = (): boolean => [...SMTP_ENV, "EMAIL_SMTP_PORT"].some((k) => !!env(k));

/** Каких переменных сервера не хватает (или заданы с ошибкой) — только имена. */
export function smtpServerMissing(): string[] {
  const missing: string[] = SMTP_ENV.filter((k) => !env(k));
  const host = env("EMAIL_SMTP_HOST");
  if (host && !HOST_RE.test(host.toLowerCase())) missing.push("EMAIL_SMTP_HOST (имя сервера, например smtp.gmail.com)");
  if (port() === null) missing.push("EMAIL_SMTP_PORT (465 или 587)");
  return missing;
}

export function smtpServer(): SmtpServer | null {
  if (smtpServerMissing().length) return null;
  const p = port()!;
  return { host: env("EMAIL_SMTP_HOST")!.toLowerCase(), port: p, secure: p === SMTP_TLS_PORT, user: env("EMAIL_SMTP_USER")!, pass: env("EMAIL_SMTP_PASS")! };
}

// ── Письмо (RFC 5322 + MIME) ─────────────────────────────────────────────────

export interface Sender {
  address: string;
  name?: string;
}

export interface SmtpMail {
  from: Sender;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** Ключ письма: один во всех попытках — из него Message-ID, по которому почта получателя склеивает дубли. */
  key: string;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

function b64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const ASCII_TEXT = /^[\x20-\x7e]*$/;

/** Заголовок с не-ASCII текстом — encoded-word по RFC 2047, кусками до 75 символов, не разрывая символ UTF-8. */
export function encodeWord(s: string): string {
  if (ASCII_TEXT.test(s)) return s;
  const words: string[] = [];
  let chunk: number[] = [];
  for (const ch of s) {
    const bytes = utf8(ch);
    if (chunk.length + bytes.length > 45) {
      words.push(`=?UTF-8?B?${b64(Uint8Array.from(chunk))}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(`=?UTF-8?B?${b64(Uint8Array.from(chunk))}?=`);
  return words.join("\r\n ");
}

/** Отправитель для заголовка From: имя в кавычках (или encoded-word) и адрес. */
export function formatSender(s: Sender): string {
  const name = s.name?.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) return `<${s.address}>`;
  const shown = ASCII_TEXT.test(name) ? `"${name.replace(/(["\\])/g, "\\$1")}"` : encodeWord(name);
  return `${shown} <${s.address}>`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** Дата по RFC 5322 в UTC: «Wed, 14 Oct 2026 09:30:00 +0000». */
export const rfcDate = (d: Date): string =>
  `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;

const domainOf = (address: string): string => address.slice(address.lastIndexOf("@") + 1);
/** Только безопасные для заголовка символы: ключ — служебная строка («notification/<id>»). */
const headerToken = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, ".").slice(0, 120) || "mail";

const wrap76 = (s: string): string => s.replace(/.{1,76}/g, "$&\r\n");

function part(type: "text/plain" | "text/html", body: string): string {
  return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(utf8(body)))}`;
}

/** Письмо целиком: текст и HTML в multipart/alternative, тела в base64 — строки короткие, без точек в начале. */
export function buildMessage(m: SmtpMail, date: Date, boundary: string): string {
  const headers = [
    `From: ${formatSender(m.from)}`,
    `To: <${m.to}>`,
    ...(m.replyTo ? [`Reply-To: <${m.replyTo}>`] : []),
    `Subject: ${encodeWord(m.subject.replace(/[\u0000-\u001f\u007f]+/g, " "))}`,
    `Date: ${rfcDate(date)}`,
    `Message-ID: <${headerToken(m.key)}@${domainOf(m.from.address)}>`,
    "MIME-Version: 1.0",
    // Разные уведомления — разные письма, а не одна цепочка; автоответчики на них не отвечают.
    `X-Entity-Ref-ID: ${headerToken(m.key)}`,
    "Auto-Submitted: auto-generated",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  return `${headers.join("\r\n")}\r\n\r\n--${boundary}\r\n${part("text/plain", m.text)}--${boundary}\r\n${part("text/html", m.html)}--${boundary}--\r\n`;
}

/** Тело команды DATA: переводы строк — CRLF, строка с точкой в начале — удвоенная точка (RFC 5321 §4.5.2). */
export const dotStuff = (msg: string): string =>
  msg
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((l) => (l.startsWith(".") ? `.${l}` : l))
    .join("\r\n");

// ── Соединение и ответы сервера ──────────────────────────────────────────────

export interface SmtpReply {
  code: number;
  lines: string[];
}

export type LinkFailure = "network" | "timeout" | "tls" | "protocol";

/** Ошибка соединения или разбора ответа: без текста ОС и сервера — только вид; этап добавляет smtpSend. */
export class SmtpLinkError extends Error {
  constructor(readonly kind: LinkFailure) {
    super(`smtp link: ${kind}`);
  }
}

/** Соединение с почтовым сервером: строки туда, ответы обратно, переход на TLS. */
export interface SmtpLink {
  send(data: string): Promise<void>;
  reply(): Promise<SmtpReply>;
  startTls(): Promise<void>;
  close(): void;
}

export type SmtpDialer = (o: { host: string; port: number; secure: boolean; timeoutMs: number }) => Promise<SmtpLink>;

const MAX_BUFFER = 64 * 1024;
const MAX_LINES = 200;

/** Разбор потока ответов SMTP: «250-…» — продолжение, «250 …» — конец ответа. */
export class ReplyReader {
  private buf = "";
  private lines: string[] = [];
  private ready: SmtpReply[] = [];
  private failure: Error | null = null;
  private waiter: { resolve: (r: SmtpReply) => void; reject: (e: Error) => void } | null = null;

  push(chunk: string): void {
    if (this.failure) return;
    this.buf += chunk;
    if (this.buf.length > MAX_BUFFER) return this.fail(new SmtpLinkError("network"));
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -]|$)(.*)$/.exec(line);
      if (!m || this.lines.length >= MAX_LINES) return this.fail(new SmtpLinkError("protocol"));
      this.lines.push(m[3]!);
      if (m[2] !== "-") {
        this.ready.push({ code: Number(m[1]), lines: this.lines });
        this.lines = [];
      }
    }
    this.flush();
  }

  fail(e: Error): void {
    if (!this.failure) this.failure = e;
    this.flush();
  }

  next(): Promise<SmtpReply> {
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.flush();
    });
  }

  private flush(): void {
    const w = this.waiter;
    if (!w) return;
    const r = this.ready.shift();
    if (r) {
      this.waiter = null;
      w.resolve(r);
    } else if (this.failure) {
      this.waiter = null;
      w.reject(this.failure);
    }
  }
}

// ── Диалог ───────────────────────────────────────────────────────────────────

export type SmtpStage = "connect" | "greeting" | "ehlo" | "tls" | "auth" | "from" | "rcpt" | "data" | "message";
export type SmtpFailure = LinkFailure | "reply";

/** Ошибка отправки: этап, вид и код SMTP. message — только служебный, без ответа сервера. */
export class SmtpError extends Error {
  constructor(
    readonly stage: SmtpStage,
    readonly kind: SmtpFailure,
    readonly code?: number,
    /** Расширенный статус из ответа («5.7.8») — без остального текста. */
    readonly status?: string,
  ) {
    super(`smtp ${stage}: ${kind}${code ? ` ${code}` : ""}${status ? ` ${status}` : ""}`);
  }
}

export interface SmtpTimeouts {
  /** На каждый шаг (соединение, ответ сервера). */
  stepMs: number;
  /** На всю отправку. */
  totalMs: number;
}

export const SMTP_TIMEOUTS: SmtpTimeouts = { stepMs: 20_000, totalMs: 60_000 };

const statusOf = (r: SmtpReply): string | undefined => /^([245]\.\d{1,3}\.\d{1,3})\b/.exec(r.lines[0] ?? "")?.[1];

/** Возможности сервера из ответа на EHLO: «AUTH PLAIN LOGIN», «STARTTLS», старое «AUTH=LOGIN». */
function capabilities(r: SmtpReply): Map<string, string[]> {
  const caps = new Map<string, string[]>();
  for (const line of r.lines.slice(1)) {
    const [word = "", ...rest] = line.trim().toUpperCase().split(/[\s=]+/);
    if (word) caps.set(word, [...(caps.get(word) ?? []), ...rest]);
  }
  return caps;
}

/** Отправить одно письмо. Бросает SmtpError; при успехе сервер принял письмо (250 после DATA). */
export async function smtpSend(dial: SmtpDialer, server: SmtpServer, mail: SmtpMail, t: SmtpTimeouts = SMTP_TIMEOUTS, now: Date = new Date()): Promise<void> {
  let stage: SmtpStage = "connect";
  let link: SmtpLink | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expect = async (ok: (code: number) => boolean): Promise<SmtpReply> => {
    const r = await link!.reply();
    if (!ok(r.code)) throw new SmtpError(stage, "reply", r.code, statusOf(r));
    return r;
  };
  const command = async (s: SmtpStage, line: string, ok: (code: number) => boolean): Promise<SmtpReply> => {
    stage = s;
    await link!.send(`${line}\r\n`);
    return expect(ok);
  };
  const is = (...codes: number[]) => (c: number) => codes.includes(c);
  const b64s = (s: string) => b64(utf8(s));
  const helo = domainOf(mail.from.address);

  const dialogue = async (): Promise<void> => {
    link = await dial({ host: server.host, port: server.port, secure: server.secure, timeoutMs: t.stepMs });
    stage = "greeting";
    await expect(is(220));
    let caps = capabilities(await command("ehlo", `EHLO ${helo}`, is(250)));
    if (!server.secure) {
      if (!caps.has("STARTTLS")) throw new SmtpError("tls", "protocol");
      await command("tls", "STARTTLS", is(220));
      await link.startTls();
      caps = capabilities(await command("ehlo", `EHLO ${helo}`, is(250)));
    }
    const methods = caps.get("AUTH") ?? [];
    if (methods.includes("PLAIN")) {
      await command("auth", `AUTH PLAIN ${b64s(`\u0000${server.user}\u0000${server.pass}`)}`, is(235));
    } else if (methods.includes("LOGIN")) {
      await command("auth", "AUTH LOGIN", is(334));
      await command("auth", b64s(server.user), is(334));
      await command("auth", b64s(server.pass), is(235));
    } else {
      throw new SmtpError("auth", "protocol");
    }
    await command("from", `MAIL FROM:<${mail.from.address}>`, is(250));
    await command("rcpt", `RCPT TO:<${mail.to}>`, is(250, 251));
    await command("data", "DATA", is(354));
    stage = "message";
    const boundary = `hms-${crypto.randomUUID()}`;
    await link.send(`${dotStuff(buildMessage(mail, now, boundary))}\r\n.\r\n`);
    await expect(is(250));
    // Письмо принято; ответ на QUIT не ждём.
    await link.send("QUIT\r\n").catch(() => undefined);
  };

  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SmtpLinkError("timeout")), t.totalMs);
  });
  try {
    await Promise.race([dialogue(), deadline]);
  } catch (e) {
    if (e instanceof SmtpError) throw e;
    throw new SmtpError(stage, e instanceof SmtpLinkError ? e.kind : "network");
  } finally {
    clearTimeout(timer);
    (link as SmtpLink | null)?.close();
  }
}

// ── Итог для очереди писем ───────────────────────────────────────────────────

/**
 * Ошибка SMTP → что делать дальше (те же правила повтора, что у Resend): связь, таймаут и 4xx — повтор по расписанию;
 * 5xx, TLS и протокол — сразу ошибка с подсказкой владельцу. Повтор после обрыва на последнем шаге может дать дубль —
 * у него тот же Message-ID, и почта получателя (Gmail, Яндекс) показывает одно письмо.
 */
export function smtpOutcome(e: unknown, retryMs: number): Outcome {
  const retry = (note: string): Outcome => ({ kind: "retry", delayMs: retryMs, note });
  const fail = (note: string): Outcome => ({ kind: "fail", note });
  if (!(e instanceof SmtpError)) return retry("Сбой отправки через почтовый сервер");
  const code = e.code ? ` (SMTP ${e.code}${e.status ? ` ${e.status}` : ""})` : "";
  const PORTS = "465 — SSL, 587 — STARTTLS";
  switch (e.kind) {
    case "network":
      return retry(e.stage === "connect" ? "Нет связи с почтовым сервером — проверьте EMAIL_SMTP_HOST и порт" : "Почтовый сервер оборвал соединение");
    case "timeout":
      return retry(`Почтовый сервер не ответил вовремя — проверьте порт (${PORTS})`);
    case "tls":
      return fail(`Не удалось установить защищённое соединение с почтовым сервером — проверьте адрес и порт (${PORTS})`);
    case "protocol":
      if (e.stage === "tls") return fail("Почтовый сервер не поддерживает шифрование STARTTLS — укажите порт 465");
      if (e.stage === "auth") return fail("Почтовый сервер не предлагает вход по паролю (AUTH PLAIN или LOGIN)");
      return fail(`Почтовый сервер ответил не по протоколу SMTP — проверьте адрес и порт (${PORTS})`);
    case "reply":
      break;
  }
  if (e.code !== undefined && e.code >= 400 && e.code < 500) return retry(`Почтовый сервер просит повторить позже${code}`);
  if (e.status === "5.4.5") return fail(`Исчерпан суточный лимит писем этого ящика${code} — письма снова пойдут завтра`);
  switch (e.stage) {
    case "auth":
      return fail(`Почтовый сервер не принял логин или пароль${code} — нужен пароль приложения (Gmail, Яндекс, Mail.ru), а не обычный пароль ящика`);
    case "from":
      return fail(`Почтовый сервер не принял отправителя${code} — EMAIL_FROM должен быть адресом этого ящика (EMAIL_SMTP_USER)`);
    case "rcpt":
      return fail(`Почтовый сервер не принял адрес получателя${code}`);
    case "data":
    case "message":
      return fail(`Почтовый сервер отклонил письмо${code}`);
    default:
      return fail(`Почтовый сервер отказал${code}`);
  }
}
