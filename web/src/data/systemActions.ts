// Резервные копии, автораспределение и удаление данных клиента: действия интерфейса →
// convex/backup.ts, convex/autoAssign.ts, convex/clients.ts. Каждое возвращает Result, текст ошибки — для тоста.
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run } from "./convex";

/** Резервная копия сейчас — создаётся в фоне, в списке появится через минуту. */
export const backupNow = () => run(convex.mutation(api.backup.runNow, {}));

/** Автораспределение заказов: включено ли и сколько минут ждать (в ленте и подтверждения мастера). */
export const saveAutoAssign = (enabled: boolean, minutes: number) => run(convex.mutation(api.autoAssign.configure, { enabled, minutes }));

/** Удалить персональные данные клиента по его запросу; confirmPhone — его телефон, набранный владельцем. */
export const anonymizeClient = (clientId: string, confirmPhone: string) => run(convex.mutation(api.clients.anonymize, { clientId: clientId as Id<"clients">, confirmPhone }));
