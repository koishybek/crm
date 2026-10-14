// «Состояние системы» и «Резервные копии» у владельца (ТЗ п.20 «мониторинг», п.26): типы ответов сервера
// и правила цвета подсистемы. Правила — здесь, а не на сервере: «давно не работало» зависит от текущего времени,
// которое экран обновляет сам.
import type { Tone } from "./catalog";

export type SubsystemKey = "ai" | "telegram" | "whatsapp" | "olx" | "pbx" | "email" | "site" | "api" | "backup" | "reminders" | "escalations" | "offsite";

/** Отметки подсистемы: когда последний раз отработала и последняя ошибка. */
export interface HealthMark {
  okAt?: string;
  okNote?: string;
  errorAt?: string;
  error?: string;
}

export interface SubsystemInfo {
  key: SubsystemKey;
  /** false — не подключено или не используется (серый). */
  configured: boolean;
  /** Чего не хватает, если не подключено. */
  hint?: string;
  /** Что сломано прямо сейчас по данным интеграции (статус «ошибка»), даже без отметок. */
  issue?: string;
  /** Работает не полностью (например, разбор есть, а расшифровки звонков нет) — жёлтый. */
  warning?: string;
  mark?: HealthMark;
}

export interface SystemOverview {
  subsystems: SubsystemInfo[];
}

export interface BackupItem {
  id: string;
  at: string;
  size: number;
  docs: number;
  /** Запущена владельцем вручную, а не ночным расписанием. */
  manual: boolean;
  url?: string;
  /** Та же копия есть во внешнем хранилище. */
  offsite?: boolean;
}

export interface BackupList {
  keep: number;
  items: BackupItem[];
  /** Последняя попытка не удалась (и после неё удачной не было). */
  lastError?: { at: string; text: string };
}

export type HealthState = "ok" | "warn" | "bad" | "off";

export const HEALTH_STATE: Record<HealthState, { label: string; tone: Tone }> = {
  ok: { label: "Работает", tone: "green" },
  warn: { label: "Внимание", tone: "amber" },
  bad: { label: "Сбой", tone: "red" },
  off: { label: "Не подключено", tone: "gray" },
};

const MIN = 60_000;

/** Подписи подсистем; staleMs — для регулярных задач: дольше без успешного запуска — сбой. */
export const SUBSYSTEMS: Record<SubsystemKey, { label: string; staleMs?: number; idle: string }> = {
  reminders: { label: "Напоминания о сроках", staleMs: 30 * MIN, idle: "Ещё не запускались" },
  escalations: { label: "Эскалации и автораспределение", staleMs: 20 * MIN, idle: "Ещё не запускались" },
  backup: { label: "Резервные копии", staleMs: 26 * 60 * MIN, idle: "Копий ещё нет — первая будет ночью" },
  offsite: { label: "Внешнее хранилище копий", idle: "Копий во внешнем хранилище ещё нет — первая уйдёт ночью" },
  ai: { label: "AI: расшифровка и разбор", idle: "Ещё не использовался" },
  pbx: { label: "Телефония (АТС)", idle: "Событий от АТС ещё не было" },
  telegram: { label: "Telegram-бот", idle: "Ответов клиентам через бота ещё не было" },
  whatsapp: { label: "WhatsApp", idle: "Вебхуков от Meta ещё не было" },
  olx: { label: "OLX", staleMs: 45 * MIN, idle: "Синхронизаций ещё не было" },
  email: { label: "Email", idle: "Писем ещё не было" },
  site: { label: "Форма заявки на сайте", idle: "Заявок с сайта ещё не было" },
  api: { label: "Публичный API", idle: "Запросов к API ещё не было" },
};

export interface SubsystemView {
  key: SubsystemKey;
  label: string;
  state: HealthState;
  /** Главная строка состояния: что не так или когда работало. */
  detail: string;
  okAt?: string;
  errorAt?: string;
  error?: string;
}

const time = (iso: string | undefined) => (iso ? Date.parse(iso) : NaN);

/**
 * Цвет подсистемы. Серый — не подключена. Красный — последнее событие — ошибка, интеграция в ошибке
 * или регулярная задача давно не отрабатывала. Жёлтый — работает не полностью или успешных событий ещё не было.
 */
export function subsystemView(s: SubsystemInfo, now: number): SubsystemView {
  const meta = SUBSYSTEMS[s.key];
  const m = s.mark ?? {};
  const base = { key: s.key, label: meta.label, okAt: m.okAt, errorAt: m.errorAt, error: m.error };
  if (!s.configured) return { ...base, state: "off", detail: s.hint ?? "Не подключено" };
  if (s.issue) return { ...base, state: "bad", detail: s.issue };
  const ok = time(m.okAt);
  const err = time(m.errorAt);
  if (!Number.isNaN(err) && (Number.isNaN(ok) || err >= ok)) return { ...base, state: "bad", detail: m.error ?? "Ошибка" };
  if (Number.isNaN(ok)) return { ...base, state: "warn", detail: meta.idle };
  if (meta.staleMs && now - ok > meta.staleMs) return { ...base, state: "bad", detail: "Давно не запускалось — проверьте расписание задач Convex" };
  if (s.warning) return { ...base, state: "warn", detail: s.warning };
  return { ...base, state: "ok", detail: m.okNote ?? "Работает" };
}

const ORDER: Record<HealthState, number> = { bad: 0, warn: 1, ok: 2, off: 3 };

/** Все подсистемы: сначала сбои, затем «внимание», рабочие и неподключённые — в конце. */
export function systemViews(o: SystemOverview, now: number): SubsystemView[] {
  return o.subsystems.map((s) => subsystemView(s, now)).sort((a, b) => ORDER[a.state] - ORDER[b.state]);
}

/** «512 КБ», «2,4 МБ». */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
}
