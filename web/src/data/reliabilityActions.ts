// Надёжность (ТЗ п.20.10, п.26.4): внешнее хранилище копий и срок хранения записей звонков → convex/offsite.ts,
// convex/retention.ts. Каждое действие возвращает Result, текст ошибки — для тоста.
import { api } from "../../convex/_generated/api";
import { convex, run } from "./convex";

/** Копировать ли во внешнее хранилище сами файлы (записи звонков, фото, вложения). */
export const setOffsiteFiles = (on: boolean) => run(convex.mutation(api.offsite.setCopyFiles, { on }));

/** Сроки хранения записей звонков и расшифровок, дней (0 — бессрочно). */
export const saveRetention = (recordingsDays: number, transcriptsDays: number) => run(convex.mutation(api.retention.configure, { recordingsDays, transcriptsDays }));
