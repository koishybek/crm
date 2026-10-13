// Уведомления наружу: свой переключатель «Дублировать на email», проверка отправки и «Уведомлять клиентов» владельца.
import { api } from "../../convex/_generated/api";
import { convex, run, type Result } from "./convex";

export const setNotifyEmail = (on: boolean) => run(convex.mutation(api.users.setNotifyEmail, { on }));
export const setClientNotify = (enabled: boolean) => run(convex.mutation(api.clientNotify.setEnabled, { enabled }));

/** Проверочное письмо владельцу: успех — только если Resend письмо принял. */
export async function sendTestEmail(): Promise<Result> {
  const r = await run(convex.action(api.email.sendTest, {}));
  if (!r.ok) return r;
  const s = r.value;
  if (s.status === "sent") return { ok: true, value: undefined };
  return { ok: false, error: s.status === "skipped" || s.status === "failed" ? s.reason : "Письмо не отправлено — попробуйте ещё раз" };
}
