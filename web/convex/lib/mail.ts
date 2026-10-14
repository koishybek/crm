// Email-копии важных уведомлений (ТЗ п.18, п.19): правило «кому», адрес, само письмо и постановка в отправку.
// Здесь — то, что нужно мутациям (notify в lib/domain.ts): выбор транспорта (Resend или свой ящик по SMTP) и его
// настройки из окружения. Отправка — convex/email.ts (Resend) и convex/emailSmtp.ts (SMTP, рантайм Node).
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "./functions";
import { env } from "../env";
import { APP_NAME } from "../../src/data/catalog";
import type { EmailKind } from "../../src/data/notifyRules";
import { smtpChosen, smtpServer, smtpServerMissing, SMTP_ENV, type Sender, type SmtpServer } from "./smtp";

/** Ключ Resend. RESEND_API_KEY — то же значение под именем из исследования провайдера. */
const apiKey = (): string | undefined => env("EMAIL_API_KEY") ?? env("RESEND_API_KEY");

/**
 * Чем отправляем: Resend, если задан его ключ; иначе обычный ящик по SMTP, если задана хоть одна EMAIL_SMTP_*;
 * иначе — ничем (null).
 */
export type EmailTransport = "resend" | "smtp";

export const emailTransport = (): EmailTransport | null => (apiKey() ? "resend" : smtpChosen() ? "smtp" : null);

interface EmailCommon {
  /** От кого — как в заголовке: «Home Max Service <noreply@notify.домен>». */
  from: string;
  replyTo?: string;
  /** Тестовый деплоймент: все письма — на этот адрес, а не сотрудникам. */
  redirectTo?: string;
}

export type EmailConfig =
  | (EmailCommon & { transport: "resend"; apiKey: string })
  | (EmailCommon & { transport: "smtp"; smtp: SmtpServer; sender: Sender });

/** Итог одной попытки отправки (общий для Resend и SMTP); note — текст для мониторинга, без адресов и писем. */
export type Outcome = { kind: "sent" } | { kind: "retry"; delayMs: number; note: string } | { kind: "fail"; note: string };

/** Паузы перед повторами (сеть, таймаут, 5xx/4xx, 429): у Resend повтор — с тем же Idempotency-Key, у SMTP — с тем же Message-ID. */
export const RETRY_MS = [30_000, 120_000, 600_000];
export const backoff = (attempt: number): number => RETRY_MS[Math.min(Math.max(attempt, 1), RETRY_MS.length) - 1]!;

/** Тестовый адрес задан, но с ошибкой: письма не шлём совсем — иначе они ушли бы настоящим сотрудникам. */
const badRedirect = (): boolean => !!env("EMAIL_REDIRECT_TO") && !normalizeEmail(env("EMAIL_REDIRECT_TO"));

/** «Имя <адрес>» или просто адрес → отправитель; null — адрес с ошибкой. */
export function parseSender(raw: string): Sender | null {
  const m = /^\s*(?:"?([^"<>]*?)"?\s*)?<([^<>\s]+)>\s*$/.exec(raw);
  const address = normalizeEmail(m ? m[2] : raw);
  if (!address) return null;
  const name = m?.[1]?.trim();
  return name ? { address, name } : { address };
}

/** Отправитель SMTP: EMAIL_FROM, а без него — сам ящик (логин) от имени компании. */
function smtpSender(): Sender | null {
  const from = env("EMAIL_FROM");
  if (from) return parseSender(from);
  const address = normalizeEmail(env("EMAIL_SMTP_USER"));
  return address ? { address, name: APP_NAME } : null;
}

/** Какие переменные не заданы (или заданы с ошибкой) — имена, без значений. Ничего не выбрано — подсказываем SMTP. */
export function emailMissing(): string[] {
  const redirect = badRedirect() ? ["EMAIL_REDIRECT_TO"] : [];
  if (emailTransport() === "resend") return [...(env("EMAIL_FROM") ? [] : ["EMAIL_FROM"]), ...redirect];
  if (emailTransport() === null) return [...SMTP_ENV, ...redirect];
  const sender = env("EMAIL_FROM") || !env("EMAIL_SMTP_USER") || smtpSender() ? [] : ["EMAIL_FROM (логин ящика — не email, укажите адрес отправителя)"];
  const badFrom = env("EMAIL_FROM") && !smtpSender() ? ["EMAIL_FROM (адрес с ошибкой)"] : [];
  return [...smtpServerMissing(), ...sender, ...badFrom, ...redirect];
}

/** null — email не настроен: письма не ставятся и не отправляются. */
export function emailConfig(): EmailConfig | null {
  if (emailMissing().length) return null;
  const common = { replyTo: normalizeEmail(env("EMAIL_REPLY_TO")) ?? undefined, redirectTo: normalizeEmail(env("EMAIL_REDIRECT_TO")) ?? undefined };
  if (emailTransport() === "resend") return { transport: "resend", apiKey: apiKey()!, from: env("EMAIL_FROM")!, ...common };
  const smtp = smtpServer();
  const sender = smtpSender();
  if (!smtp || !sender) return null;
  return { transport: "smtp", smtp, sender, from: sender.name ? `${sender.name} <${sender.address}>` : sender.address, ...common };
}

/** ASCII-адрес: локальная часть ≤ 64, домен с точкой, всего ≤ 254. Телефон-логин и кириллические адреса — null. */
export function normalizeEmail(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  if (!s || s.length > 254) return null;
  const m = /^([a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/.exec(s);
  const local = m?.[1];
  if (!local || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return s;
}

/** Для текста и атрибутов HTML (в отличие от esc из lib/tg.ts экранирует и кавычки). */
export const escHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Тема письма: одна строка без управляющих символов (CR/LF — внедрение заголовков), не длиннее 200. */
export const cleanSubject = (s: string): string =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);

/** Адрес для писем — логин сотрудника, если это email. */
export const loginEmail = (u: Pick<Doc<"users">, "email">): string | null => normalizeEmail(u.email);

/**
 * Правило email — одно на всю систему. Копия уведомления уходит, только если:
 * событие важное (вызов notify пометил его opts.email — список в src/data/notifyRules.ts), сотрудник сам включил
 * «Дублировать на email», доступ не отключён и логин — email. Иначе — только колокольчик и Telegram.
 */
export function emailRecipient(u: Doc<"users">): string | null {
  if (u.active === false || !u.role || u.notifyEmail !== true) return null;
  return loginEmail(u);
}

export interface EmailEvent {
  kind: EmailKind;
  /**
   * Текст письма, если в тексте уведомления есть данные клиента (имя, его слова): письма хранит почтовый сервис
   * за рубежом, поэтому в них — только номер, услуга и ссылка в приложение.
   */
  text?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const appUrl = (): string | null => {
  const u = env("APP_URL")?.replace(/\/+$/, "");
  return u && /^https?:\/\//.test(u) ? u : null;
};

const buttonLabel = (link: string) => (link.startsWith("/leads") ? "Открыть заявку" : link.includes("/orders/") ? "Открыть заказ" : "Открыть");

/** Письмо из текста уведомления: тема — суть события, тело — она же и кнопка в приложение. Всё экранируется. */
export function renderEmail(body: string, link: string | undefined): RenderedEmail {
  const text = body.replace(/\u0000/g, "").trim();
  const subject = cleanSubject(text) || APP_NAME;
  const app = appUrl();
  const url = app && link?.startsWith("/") ? `${app}${link}` : null;
  const footer = `Письмо отправлено автоматически: в ${APP_NAME} у вас включено «Дублировать на email». Отключить можно в меню профиля.`;
  const plain = [text, ...(url ? ["", `${buttonLabel(link!)}: ${url}`] : []), "", "—", footer].join("\n");
  const button = url
    ? `<p style="margin:0 0 24px"><a href="${escHtml(url)}" style="display:inline-block;padding:12px 20px;background:#ffc629;color:#1c1c1e;text-decoration:none;border-radius:8px;font-weight:bold">${escHtml(buttonLabel(link!))}</a></p>`
    : "";
  const html =
    `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${escHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;background:#f6f4ef;font-family:Arial,Helvetica,sans-serif;color:#1c1c1e">` +
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">` +
    `<p style="margin:0 0 8px;font-size:13px;color:#7a7568">${escHtml(APP_NAME)}</p>` +
    `<p style="margin:0 0 20px;font-size:16px;line-height:1.5;white-space:pre-line">${escHtml(text)}</p>` +
    button +
    `<p style="margin:0;font-size:12px;line-height:1.5;color:#7a7568">${escHtml(footer)}</p>` +
    `</div></body></html>`;
  return { subject, text: plain, html };
}

/** Пауза между письмами одного notify: у Resend не больше 10 запросов в секунду на всю команду; почтовым ящикам тоже не нравятся пачки. */
const SPACING_MS = 150;

/**
 * Копия уведомления на email (зовёт notify). Письмо собирается здесь, один раз: повтор отправки уходит с тем же
 * телом и тем же ключом идемпотентности — дубля не будет. order — номер письма в этом notify, для разноса по времени.
 */
export async function queueEmail(
  ctx: MutationCtx,
  u: Doc<"users">,
  notificationId: Id<"notifications">,
  a: { text: string; link?: string; event: EmailEvent },
  order: number,
): Promise<boolean> {
  const to = emailRecipient(u);
  if (!to || !emailConfig()) return false;
  const mail = renderEmail(a.event.text ?? a.text, a.link);
  await ctx.scheduler.runAfter(order * SPACING_MS, internal.email.send, { to, ...mail, kind: a.event.kind, key: `notification/${notificationId}` });
  return true;
}
