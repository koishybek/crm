// Подбор исполнителя (ТЗ п.12.3, 12.6, 12.7, 14.5): районы городов, ставки мастера, AI-подбор.
// Функции — convex/districts.ts, convex/executorRates.ts, convex/aiMatch.ts. Каждое действие возвращает Result.
import { useQuery } from "convex/react";
import { useMemo } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { AiMatchResult } from "./aiMatch";
import { DEFAULT_DISTRICTS, districtsOf, fromDistrictList, toDistrictList, type DistrictMap } from "./cities";
import { convex, run, type Result } from "./convex";
import type { ExecutorRates } from "./types";

const FALLBACK: DistrictMap = Object.fromEntries(Object.entries(DEFAULT_DISTRICTS).map(([city, list]) => [city, [...list]]));

/** Справочник районов с сервера (только сотрудникам); пока грузится — районы по умолчанию. */
export function useDistricts(): DistrictMap {
  const list = useQuery(api.districts.list);
  return useMemo(() => (list ? fromDistrictList(list) : FALLBACK), [list]);
}

/** Районы города по справочнику. */
export function useCityDistricts(city: string): string[] {
  return districtsOf(useDistricts(), city);
}

/** Сохранить справочник районов (владелец); null — вернуть районы по умолчанию. */
export async function saveDistricts(map: DistrictMap | null): Promise<Result<DistrictMap>> {
  const r = await run(convex.mutation(api.districts.save, { list: map ? toDistrictList(map) : null }));
  return r.ok ? { ok: true, value: fromDistrictList(r.value) } : r;
}

/** Ставки мастера (владелец); null — ставка услуги. */
export const saveExecutorRates = (id: string, rates: ExecutorRates | null): Promise<Result<null>> =>
  run(convex.mutation(api.executorRates.set, { id: id as Id<"executors">, rates }));

/** «Спросить AI»: порядок кандидатов с объяснением; при сбое сервер сам вернёт рекомендацию по правилам. */
export const askAiMatch = (orderId: string): Promise<Result<AiMatchResult>> => run(convex.action(api.aiMatch.recommend, { orderId: orderId as Id<"orders"> }));

/** Разрешить или запретить AI-подбор (передачу обезличенных данных в LLM) — владелец. */
export const saveAiMatch = (enabled: boolean) => run(convex.mutation(api.aiMatch.configure, { enabled }));
