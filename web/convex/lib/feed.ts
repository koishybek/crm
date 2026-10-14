// Заказ снова в ленте (ТЗ п.18.1, E8): мастер снят с заказа, он узнаёт об этом, остальные подходящие мастера —
// что заказ снова свободен. Один путь для «не подтвердил назначение вовремя» — у автораспределения и у эскалации.
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { Actor } from "../../src/data/types";
import { announceOrder } from "../worker";
import { executorUser, notify, setStatus } from "./domain";
import { suitableUsers } from "./matching";
import { baseTerms } from "./rates";
import { recordRefusal } from "./stats";

const SYSTEM: Actor = { type: "system" };

/** history — запись в истории заказа, executor — что сказать снятому мастеру. Возвращает заказ после изменения. */
export async function releaseToFeed(ctx: MutationCtx, o: Doc<"orders">, text: { history: string; executor: string }): Promise<Doc<"orders">> {
  const u = o.executorId ? await executorUser(ctx, o.executorId) : null;
  // Условия выплаты — снова заказа: ставка снятого мастера к следующему не относится. Не подтвердил вовремя — это
  // отказ в его истории за 90 дней (ТЗ п.12.6).
  await setStatus(ctx, o, "awaiting_executor", SYSTEM, text.history, { executorId: undefined, assignedAt: undefined, ...baseTerms(o) });
  await recordRefusal(ctx, o.executorId);
  await notify(ctx, [u?._id], text.executor, { link: "/w", tone: "warn" });
  const fresh = (await ctx.db.get(o._id))!;
  // Снятому мастеру уже сказали — «Снова свободен» ему не шлём.
  await announceOrder(ctx, fresh, (await suitableUsers(ctx, fresh)).filter((id) => id !== u?._id), { again: true });
  return fresh;
}
