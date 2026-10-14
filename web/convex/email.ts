// Email (ТЗ п.18, п.19): отправка писем через Resend REST API или через обычный ящик компании по SMTP
// (emailSmtp.ts, рантайм Node), карточка владельца и переключатель сотрудника. Транспорт выбирает lib/mail.ts:
// ключ Resend → Resend, иначе EMAIL_SMTP_* → SMTP. Письма ставит notify (lib/domain.ts → lib/mail.ts). Без настроек
// письма не ставятся, а send честно отвечает «не настроено» — успеха без отправки не бывает.
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalAction, internalQuery, query, type ActionCtx } from "./lib/functions";
import { currentUser, OWNER, requireRole } from "./lib/access";
import { backoff, emailConfig, emailMissing, emailRecipient, emailTransport, loginEmail, normalizeEmail, renderEmail, RETRY_MS, type EmailConfig, type Outcome } from "./lib/mail";
import { smtpServer } from "./lib/smtp";
import { env } from "./env";
import { APP_NAME } from "../src/data/catalog";
import type { EmailSettings, MyEmail } from "../src/data/notifyRules";
import { shortName } from "../src/lib/format";

const ENDPOINT = "https://api.resend.com/emails";
/** Без User-Agent Resend отвечает 403. */
const USER_AGENT = "home-max-service/1.0";
const TIMEOUT_MS = 15_000;

interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Вид события — метка письма в Resend (только латиница, цифры и «_»). */
  kind?: string;
  /** Ключ идемпотентности: один на письмо, одинаковый во всех попытках. */
  key?: string;
  attempt?: number;
}

export type SendResult = { status: "sent" } | { status: "skipped"; reason: string } | { status: "retry"; attempt: number } | { status: "failed"; reason: string };

/** name из тела ошибки Resend ({ statusCode, name, message }); тело бывает и не JSON. message не берём: в нём бывает адрес. */
async function errorName(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    const name = body && typeof body === "object" ? (body as { name?: unknown }).name : undefined;
    return typeof name === "string" ? name.slice(0, 60) : "unknown";
  } catch {
    return "non_json_body";
  }
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get("retry-after");
  const sec = Number(raw);
  return raw !== null && Number.isFinite(sec) && sec >= 0 ? Math.min(sec, 3600) * 1000 : null;
}

/** Ответ Resend → что делать дальше; note — понятный владельцу текст для мониторинга (без адреса и текста письма). */
async function outcomeOf(res: Response, attempt: number): Promise<Outcome> {
  if (res.ok) return { kind: "sent" };
  const name = await errorName(res);
  const code = `HTTP ${res.status} ${name}`;
  if (res.status === 429) {
    if (name === "daily_quota_exceeded") return { kind: "fail", note: "Исчерпан суточный лимит писем Resend — письма снова пойдут после 05:00 по Алматы" };
    if (name === "monthly_quota_exceeded") return { kind: "fail", note: "Исчерпан месячный лимит писем Resend — нужен тариф побольше" };
    return { kind: "retry", delayMs: (retryAfterMs(res) ?? 1000) + Math.floor(Math.random() * 3000), note: `Resend просит подождать (${code})` };
  }
  // Тот же ключ с другим телом — ошибка в письме; остальные 409 (параллельный запрос с тем же ключом) временные.
  if (res.status === 409 && name !== "invalid_idempotent_request") return { kind: "retry", delayMs: 10_000, note: `Resend занят этим письмом (${code})` };
  if (res.status === 403 && name === "validation_error") return { kind: "fail", note: `Resend не принял отправителя (${code}) — подтвердите в Resend домен из EMAIL_FROM` };
  if (res.status === 401 || res.status === 403) return { kind: "fail", note: `Resend не принял ключ (${code}) — проверьте EMAIL_API_KEY` };
  if (res.status >= 500) return { kind: "retry", delayMs: backoff(attempt), note: `Сбой на стороне Resend (${code})` };
  return { kind: "fail", note: `Resend отклонил письмо (${code})` };
}

async function post(cfg: Extract<EmailConfig, { transport: "resend" }>, a: Mail, key: string, attempt: number): Promise<Outcome> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json", "User-Agent": USER_AGENT, "Idempotency-Key": key },
      body: JSON.stringify({
        from: cfg.from,
        to: [cfg.redirectTo ?? a.to],
        subject: a.subject,
        html: a.html,
        text: a.text,
        ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}),
        // Разные уведомления — разные письма, а не одна цепочка в Gmail; автоответчики на них не отвечают.
        headers: { "X-Entity-Ref-ID": key, "Auto-Submitted": "auto-generated" },
        ...(a.kind && /^[A-Za-z0-9_-]{1,64}$/.test(a.kind) ? { tags: [{ name: "kind", value: a.kind }] } : {}),
      }),
      signal: ctrl.signal,
    });
    return await outcomeOf(res, attempt);
  } catch (e) {
    // Ответа нет — письмо могло уйти: повтор безопасен только с тем же ключом и тем же телом.
    const timeout = e instanceof Error && e.name === "AbortError";
    return { kind: "retry", delayMs: backoff(attempt), note: timeout ? "Resend не ответил вовремя" : "Нет связи с Resend" };
  } finally {
    clearTimeout(timer);
  }
}

/** Одна попытка отправки; при временной ошибке — повтор по расписанию (retry), иначе итог в мониторинг. */
async function deliver(ctx: ActionCtx, a: Mail, opts: { retry: boolean }): Promise<SendResult> {
  const cfg = emailConfig();
  if (!cfg) return { status: "skipped", reason: `Email не настроен: не заданы ${emailMissing().join(", ")}` };
  if (!normalizeEmail(a.to)) return { status: "failed", reason: "Неверный адрес получателя" };
  const key = a.key ?? `email/${crypto.randomUUID()}`;
  const attempt = Math.max(1, Math.floor(a.attempt ?? 1));
  // Повтор Resend — с тем же Idempotency-Key (Resend помнит его 24 часа). Пароль SMTP в аргументы не идёт: его читает
  // само действие из окружения (аргументы видны в журнале функций Convex).
  const r =
    cfg.transport === "resend"
      ? await post(cfg, a, key, attempt)
      : await ctx.runAction(internal.emailSmtp.post, { to: cfg.redirectTo ?? a.to, subject: a.subject, text: a.text, html: a.html, key, attempt });
  if (r.kind === "sent") {
    await ctx.runMutation(internal.health._mark, { key: "email", ok: true, note: "Письмо отправлено" });
    return { status: "sent" };
  }
  // Адрес, тему и текст письма в лог не пишем — только ключ письма и итог.
  if (r.kind === "retry" && opts.retry && attempt <= RETRY_MS.length) {
    console.warn(`email: письмо ${key} не отправлено (${r.note}), повтор №${attempt}`);
    await ctx.scheduler.runAfter(r.delayMs, internal.email.send, { ...a, key, attempt: attempt + 1 });
    return { status: "retry", attempt };
  }
  console.error(`email: письмо ${key} не отправлено: ${r.note}`);
  await ctx.runMutation(internal.health._mark, { key: "email", ok: false, note: r.note });
  return { status: "failed", reason: r.note };
}

/** Отправка из планировщика. html собран заранее (lib/mail.ts renderEmail) — всё пользовательское в нём экранировано. */
export const send = internalAction({
  args: { to: v.string(), subject: v.string(), text: v.string(), html: v.string(), kind: v.optional(v.string()), key: v.optional(v.string()), attempt: v.optional(v.number()) },
  handler: (ctx, a): Promise<SendResult> => deliver(ctx, a, { retry: true }),
});

/** Адрес владельца для проверочного письма; null — смотрит не владелец. */
export const _ownerEmail = internalQuery({
  args: {},
  handler: async (ctx): Promise<{ email: string | null } | null> => {
    const me = await currentUser(ctx);
    return me?.role === "owner" ? { email: loginEmail(me) } : null;
  },
});

/** Владелец проверяет настройку: письмо себе на email из логина, итог — сразу в ответ и в мониторинг. */
export const sendTest = action({
  args: {},
  handler: async (ctx): Promise<SendResult> => {
    const me = await ctx.runQuery(internal.email._ownerEmail, {});
    if (!me) throw new ConvexError("Нет доступа");
    if (!me.email) throw new ConvexError("Ваш логин — не email: проверочное письмо некуда отправить");
    const mail = renderEmail(`Проверка: письма из ${APP_NAME} доходят. Если вы читаете это письмо — отправка настроена.`, "/settings");
    return deliver(ctx, { to: me.email, ...mail, kind: "test" }, { retry: false });
  },
});

/** Карточка «Email» владельца: чем отправляем, настроено ли, от кого письма, кто получает, последняя ошибка. Ключ и пароль не отдаём. */
export const settings = query({
  args: {},
  handler: async (ctx): Promise<EmailSettings> => {
    await requireRole(ctx, OWNER);
    const [users, health] = await Promise.all([
      ctx.db.query("users").collect(),
      ctx.db
        .query("systemStatus")
        .withIndex("by_key", (q) => q.eq("key", "email"))
        .unique(),
    ]);
    const transport = emailTransport();
    const server = transport === "smtp" ? smtpServer() : null;
    const cfg = emailConfig();
    return {
      configured: !!cfg,
      transport,
      missing: emailMissing(),
      from: cfg?.from ?? env("EMAIL_FROM"),
      ...(server ? { smtp: { host: server.host, port: server.port, security: server.secure ? "SSL" : "STARTTLS", user: server.user } } : {}),
      replyTo: env("EMAIL_REPLY_TO"),
      redirectTo: env("EMAIL_REDIRECT_TO"),
      subscribers: users.filter((u) => emailRecipient(u)).map((u) => shortName(u.name || u.email || "без имени")),
      health: health ? { okAt: health.okAt, okNote: health.okNote, errorAt: health.errorAt, error: health.error } : undefined,
    };
  },
});

/** Переключатель «Дублировать на email» в меню профиля. */
export const mine = query({
  args: {},
  handler: async (ctx): Promise<MyEmail | null> => {
    const me = await currentUser(ctx);
    if (!me) return null;
    return { configured: !!emailConfig(), canUse: !!loginEmail(me), on: me.notifyEmail === true };
  },
});
