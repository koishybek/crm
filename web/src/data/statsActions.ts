// Предрасчёт аналитики: действия владельца → convex/stats.ts. Возвращают Result, текст ошибки — для тоста.
import { api } from "../../convex/_generated/api";
import { convex, run } from "./convex";

/** Пересчитать все показатели заново: несколько минут, экраны до конца пересчёта показывают прежние цифры. */
export const rebuildStats = () => run(convex.mutation(api.stats.rebuild, {}));
