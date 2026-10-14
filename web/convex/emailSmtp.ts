"use node";
// Отправка письма через обычный ящик компании по SMTP (ТЗ п.18): Gmail, Яндекс, Mail.ru или свой домен — логин и
// пароль приложения в EMAIL_SMTP_*. Рантайм Node: в V8 Convex нет TCP-соединений. Зовёт только email.ts (deliver),
// повторы и отметки мониторинга — там же, как у Resend. Пароль читается здесь из окружения и в аргументы не попадает.
import { v } from "convex/values";
import { internalAction } from "./lib/functions";
import { backoff, emailConfig, type Outcome } from "./lib/mail";
import { smtpOutcome, smtpSend } from "./lib/smtp";
import { nodeDialer } from "./lib/smtpSocket";

export const post = internalAction({
  args: { to: v.string(), subject: v.string(), text: v.string(), html: v.string(), key: v.string(), attempt: v.number() },
  handler: async (_ctx, a): Promise<Outcome> => {
    const cfg = emailConfig();
    if (cfg?.transport !== "smtp") return { kind: "fail", note: "Почтовый ящик (EMAIL_SMTP_*) не настроен" };
    try {
      await smtpSend(nodeDialer, cfg.smtp, { from: cfg.sender, to: a.to, ...(cfg.replyTo ? { replyTo: cfg.replyTo } : {}), subject: a.subject, text: a.text, html: a.html, key: a.key });
      return { kind: "sent" };
    } catch (e) {
      return smtpOutcome(e, backoff(a.attempt));
    }
  },
});
