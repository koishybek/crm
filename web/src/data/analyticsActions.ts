// Аналитика: действия интерфейса → convex/analytics.ts. Возвращают Result, текст ошибки — для тоста.
import { api } from "../../convex/_generated/api";
import { convex, run } from "./convex";
import type { SourceId } from "./types";

/** Расходы на рекламу за месяц (YYYY-MM) по источникам; 0 — расходов не было. */
export const saveAdSpend = (month: string, items: { source: SourceId; amount: number }[]) => run(convex.mutation(api.analytics.setAdSpend, { month, items }));
