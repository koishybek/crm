// Адаптеры интеграций (ТЗ п.19.1, п.19.7, п.19.8, п.19.9): вызовы сервера для АТС, онлайн-оплаты и документов.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run } from "./convex";
import type { DocumentKind, CompanyRequisites } from "./documents";
import type { OnlineProvider, PayProvider } from "./payIntents";
import type { PbxProvider } from "./pbx";

// ── Телефония ──
export const savePbx = (provider: PbxProvider, fields: Record<string, string>) => run(convex.action(api.pbx.save, { provider, fields }));
export const disablePbx = () => run(convex.mutation(api.pbx.disable, {}));
export const checkPbx = () => run(convex.action(api.pbx.check, {}));
export const setPbxExtension = (userId: string, extension: string) => run(convex.mutation(api.pbx.setExtension, { userId: userId as Id<"users">, extension }));
export interface DialContext {
  orderId?: string;
  leadId?: string;
  clientId?: string;
}
export const dialViaPbx = (phone: string, c: DialContext = {}) =>
  run(
    convex.action(api.calls.dial, {
      phone,
      orderId: c.orderId as Id<"orders"> | undefined,
      leadId: c.leadId as Id<"leads"> | undefined,
      clientId: c.clientId as Id<"clients"> | undefined,
    }),
  );

// ── Онлайн-оплата ──
export const savePay = (provider: OnlineProvider, fields: Record<string, string>) => run(convex.action(api.payments.save, { provider, fields }));
export const disablePay = () => run(convex.mutation(api.payments.disable, {}));
export const saveKaspiTemplate = (template: string) => run(convex.mutation(api.payments.setKaspi, { template }));
export const createPayLink = (orderId: string, provider: PayProvider, amount?: number) => run(convex.action(api.payments.createLink, { orderId: orderId as Id<"orders">, provider, amount }));
export const cancelPayLink = (id: string) => run(convex.mutation(api.payments.cancel, { id: id as Id<"paymentIntents"> }));
export const sendPayLink = (id: string) => run(convex.mutation(api.payments.send, { id: id as Id<"paymentIntents"> }));

// ── Документы ──
export const saveRequisites = (requisites: CompanyRequisites) => run(convex.mutation(api.documents.saveRequisites, { requisites }));
export const issueDocument = (orderId: string, kind: DocumentKind, reissue?: boolean) => run(convex.mutation(api.documents.issue, { orderId: orderId as Id<"orders">, kind, reissue }));
export const shareDocument = (id: string, send: boolean) => run(convex.mutation(api.documents.share, { id: id as Id<"documents">, send }));
