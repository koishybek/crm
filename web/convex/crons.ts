import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ТЗ п.15: напоминание о сроке, просрочка, эскалация руководителю.
crons.interval("deadline reminders", { minutes: 15 }, internal.reminders.run, {});

// Утренняя сводка в Telegram: 04:00 UTC = 9:00 по Алматы.
crons.cron("morning digest", "0 4 * * *", internal.digest.run, {});

// OLX: push-уведомлений у Partner API нет — раз в минуту забираем новые сообщения. Без подключения ничего не делает.
crons.interval("olx sync", { minutes: 1 }, internal.channels.olx.sync, {});

export default crons;
