import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ТЗ п.15: напоминание о сроке, просрочка, эскалация руководителю.
crons.interval("deadline reminders", { minutes: 15 }, internal.reminders.run, {});

// Утренняя сводка в Telegram: 04:00 UTC = 9:00 по Алматы.
crons.cron("morning digest", "0 4 * * *", internal.digest.run, {});

// OLX: push-уведомлений у Partner API нет — раз в минуту забираем новые сообщения. Без подключения ничего не делает.
crons.interval("olx sync", { minutes: 1 }, internal.channels.olx.sync, {});

// ТЗ п.23: автораспределение — заказ, который никто не взял из ленты, система назначает сама. Выключено — ничего не делает.
crons.interval("auto assign", { minutes: 5 }, internal.autoAssign.run, {});

// ТЗ п.20, п.26: резервная копия данных каждую ночь — 21:00 UTC = 02:00 по Алматы.
crons.cron("daily backup", "0 21 * * *", internal.backup.run, {});

// Уборка служебных таблиц: отжившие счётчики лимитов и принятые обновления Telegram.
crons.interval("cleanup service tables", { hours: 1 }, internal.maintenance.cleanup, {});

// Файлы: ключ подписи ссылок на месте и неприкреплённые загрузки старше суток удалены (convex/files.ts).
crons.interval("files maintenance", { minutes: 10 }, internal.files.maintain, {});

export default crons;
