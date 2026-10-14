// Действия экрана «Платформа»: компании клиентов и оплаты подписки (convex/platform.ts, convex/billing.ts).
import { api } from "../../convex/_generated/api";
import { convex, run, type Result } from "./convex";
import type { PayMethod, PlatformSettings, SubscriptionPaymentRow } from "./billing";
import type { Plan } from "./plans";
import type { Id } from "../../convex/_generated/dataModel";

export interface NewCompany {
  company: string;
  slug: string;
  city: string;
  plan: Plan;
  ownerName: string;
  login: string;
  paidUntil?: string;
}
/** Пароль владельца в ответе — временный, показать один раз. */
export const createCompany = (input: NewCompany): Promise<Result<{ slug: string; login: string; password: string }>> => run(convex.action(api.platform.createCompany, input));

export interface NewPayment {
  slug: string;
  amount: number;
  method: PayMethod;
  months?: number;
  until?: string;
  note?: string;
}
export const acceptPayment = (input: NewPayment) => run(convex.mutation(api.billing.acceptPayment, input));
export const undoPayment = (slug: string, id: string) => run(convex.mutation(api.billing.undoPayment, { slug, id: id as Id<"subscriptionPayments"> }));
export const savePlatformSettings = (s: PlatformSettings) => run(convex.mutation(api.billing.saveSettings, s));
export const loadAllPayments = (): Promise<Result<SubscriptionPaymentRow[]>> => run(convex.query(api.billing.exportPayments, {}));
