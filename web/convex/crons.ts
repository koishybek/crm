import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ТЗ п.15: напоминание о сроке, просрочка, эскалация руководителю.
crons.interval("deadline reminders", { minutes: 15 }, internal.reminders.run, {});

// Утренняя сводка в Telegram: 04:00 UTC = 9:00 по Алматы.
crons.cron("morning digest", "0 4 * * *", internal.digest.run, {});

// OLX: push-уведомлений у Partner API нет — раз в минуту забираем новые сообщения. Без подключения ничего не делает.
crons.interval("olx sync", { minutes: 1 }, internal.channels.olx.sync, {});

// ТЗ п.15, п.23: регламенты раз в 5 минут — автораспределение (выключено — ничего не делает), возвращение мастеров
// на смену после «недоступен до», затем эскалации: заказ без исполнителя, неподтверждённое назначение, просрочка,
// заявка без ответа, пропущенный без перезвона (escalations.ts). Порядок важен — шаги идут по очереди.
crons.interval("operations", { minutes: 5 }, internal.escalations.run, {});

// ТЗ п.20, п.26: резервная копия данных каждую ночь — 21:00 UTC = 02:00 по Алматы.
crons.cron("daily backup", "0 21 * * *", internal.backup.run, {});

// ТЗ п.26.5: оповещения владельцу — подсистема давно не отрабатывала или сбой после часовой паузы (convex/alerts.ts).
crons.interval("system alerts", { minutes: 10 }, internal.alerts.check, {});

// ТЗ п.26.4: срок хранения записей звонков и расшифровок — 22:00 UTC = 03:00 по Алматы (convex/retention.ts).
crons.cron("call records retention", "0 22 * * *", internal.retention.run, {});

// Выгрузки CSV живут сутки: старше — удаляются вместе с файлом (convex/exports.ts).
crons.interval("exports cleanup", { hours: 1 }, internal.exports.cleanup, {});

// ТЗ п.12.6: история мастеров за 90 дней для подбора (кеш executors.stats90) — окно сдвигается раз в час.
crons.interval("executor stats", { hours: 1 }, internal.executorStats.refreshBatch, {});

// Уборка служебных таблиц: отжившие счётчики лимитов и принятые обновления Telegram.
crons.interval("cleanup service tables", { hours: 1 }, internal.maintenance.cleanup, {});

// Файлы: ключ подписи ссылок на месте и неприкреплённые загрузки старше суток удалены (convex/files.ts).
crons.interval("files maintenance", { minutes: 10 }, internal.files.maintain, {});

// ТЗ §26.6: показатели «Аналитики» и «Главной» — очередь изменившихся заказов и заявок раз в минуту (convex/stats.ts);
// ночью — сверка счётчиков заказов в работе у мастеров: 22:00 UTC = 03:00 по Алматы.
crons.interval("stats", { minutes: 1 }, internal.stats.tick, {});
crons.cron("executor loads", "0 22 * * *", internal.stats.reconcileLoads, {});

// ТЗ §24: подписка компаний — напоминания за 7 и 1 день до «оплачено до», после льготных дней — приостановка
// (convex/billing.ts). 03:30 UTC = 08:30 по Алматы.
crons.cron("subscriptions", "30 3 * * *", internal.billing.run, {});

export default crons;
