// Автораспределение заказов («AI-подбор», ТЗ п.23): настройки, границы и объяснение выбора —
// общие для сервера (convex/autoAssign.ts) и карточки в «Настройках».
import { EXEC_STATE, type Candidate } from "./logic";

/** Сколько минут заказ ждёт в ленте и сколько мастер думает над назначением; по умолчанию — полчаса. */
export const AUTO_ASSIGN = { min: 5, max: 1440, defaultMinutes: 30 } as const;

export interface AutoAssignSettings {
  enabled: boolean;
  minutes: number;
}

/** Правила выбора — те же, что у подбора при ручном назначении (rankExecutors); показываем их владельцу как есть. */
export const AUTO_ASSIGN_RULES = [
  "Кому: мастер на смене, из города заказа, с направлением заказа и всеми требуемыми навыками",
  "Кто первый: свободные раньше занятых, затем у кого меньше заказов в работе, затем выше рейтинг",
  "Не подтвердил вовремя или отказался — заказ возвращается в ленту и уходит следующему",
  "Предлагать больше некому — владелец и руководитель направления получат уведомление",
] as const;

const rating = (r: number) => String(Math.round(r * 10) / 10).replace(".", ",");

/** Почему система выбрала мастера — для истории заказа и журнала: «свободен, заказов в работе: 0, рейтинг 4,9». */
export function autoAssignWhy(c: Pick<Candidate, "state" | "load"> & { e: { rating: number } }): string {
  return `${EXEC_STATE[c.state].label.toLowerCase()}, заказов в работе: ${c.load}, рейтинг ${rating(c.e.rating)}`;
}
