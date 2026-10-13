// Действия «Регламентов»: заявку — в работу, сроки реакции (эскалации), смена и недоступность мастера, лимит заказов.
// Функции — convex/leads.ts, convex/escalations.ts, convex/executors.ts, convex/worker.ts. Каждое возвращает Result.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run, type Result } from "./convex";
import type { SlaSettings } from "./escalations";

/** «Взять в работу»: заявка из канала становится вашей и переходит в «Квалификацию». */
export const takeLead = (id: string): Promise<Result<null>> => run(convex.mutation(api.leads.take, { id: id as Id<"leads"> }));

/** Пороги эскалаций — только владелец. */
export const saveSla = (s: SlaSettings): Promise<Result<SlaSettings>> => run(convex.mutation(api.escalations.configure, s));

/** Смена мастера: на смене; выходной; until — «недоступен до» (вернётся на смену сам), reason — почему. */
export interface ShiftInput {
  available: boolean;
  until?: string;
  reason?: string;
}

/** Смену мастера меняет сотрудник (руководитель — в своём направлении). */
export const setExecutorShift = (id: string, s: ShiftInput): Promise<Result<null>> => run(convex.mutation(api.executors.setAvailable, { id: id as Id<"executors">, ...s }));

/** Лимит заказов в работе — только владелец; null — по умолчанию. */
export const setExecutorLimit = (id: string, max: number | null): Promise<Result<null>> => run(convex.mutation(api.executors.setMaxActive, { id: id as Id<"executors">, max }));

/** Мастер сам: «Принимаю заказы» / «Не принимаю» / «Не принимаю до …». */
export const setMyShift = (s: ShiftInput): Promise<Result<null>> => run(convex.mutation(api.worker.setAvailable, s));
