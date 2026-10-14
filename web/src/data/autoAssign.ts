// Автораспределение заказов («Автоподбор по правилам», ТЗ п.23): настройки, границы и объяснение выбора —
// общие для сервера (convex/autoAssign.ts) и карточки в «Настройках». AI здесь не участвует: он только советует
// в карточке заказа («Рекомендация AI», convex/aiMatch.ts).
import { EXEC_STATE, HISTORY, historyLine, type Candidate } from "./logic";
import type { ExecutorStats90 } from "./types";

/** Сколько минут заказ ждёт в ленте и сколько мастер думает над назначением; по умолчанию — полчаса. */
export const AUTO_ASSIGN = { min: 5, max: 1440, defaultMinutes: 30 } as const;

export interface AutoAssignSettings {
  enabled: boolean;
  minutes: number;
}

/** Правила выбора — те же, что у подбора при ручном назначении (rankExecutors); показываем их владельцу как есть. */
export const AUTO_ASSIGN_RULES = [
  "Кому: мастер на смене, из города заказа (и его района, если у мастера заданы районы), с направлением заказа и всеми требуемыми навыками",
  "Кто первый: свободные раньше занятых, затем у кого меньше заказов в работе, затем больше баллов качества",
  `Баллы качества: рейтинг × ${HISTORY.perStar} + доля заказов, сданных в срок за ${HISTORY.days} дней (новичку — ${HISTORY.neutralOnTime}%), − ${HISTORY.perRefusal} за каждый отказ`,
  "Выплата — по ставке назначенного мастера; чья ставка больше цены клиента, того система не назначает",
  "Не подтвердил вовремя или отказался — заказ возвращается в ленту и уходит следующему",
  "Предлагать больше некому — владелец и руководитель направления получат уведомление",
] as const;

const rating = (r: number) => String(Math.round(r * 10) / 10).replace(".", ",");

/** Почему система выбрала мастера — для истории заказа и журнала: «свободен, заказов в работе: 0, рейтинг 4,9». */
export function autoAssignWhy(c: Pick<Candidate, "state" | "load"> & { e: { rating: number; stats90?: ExecutorStats90 } }): string {
  const history = historyLine(c.e.stats90);
  return `${EXEC_STATE[c.state].label.toLowerCase()}, заказов в работе: ${c.load}, рейтинг ${rating(c.e.rating)}${history ? `, ${history}` : ""}`;
}
