import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// ТЗ п.15: напоминание о сроке, просрочка, эскалация руководителю.
crons.interval("deadline reminders", { minutes: 15 }, internal.reminders.run, {});

// Утренняя сводка в Telegram: 04:00 UTC = 9:00 по Алматы.
crons.cron("morning digest", "0 4 * * *", internal.digest.run, {});

export default crons;
