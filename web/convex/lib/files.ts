// Файлы в хранилище Convex: удаление без падения, если файла уже нет.
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Удалить файл; уже удалённый — не ошибка (на один файл бывает несколько ссылок). true — файл был и удалён. */
export async function dropFile(ctx: MutationCtx, id: Id<"_storage">): Promise<boolean> {
  try {
    await ctx.storage.delete(id);
    return true;
  } catch {
    return false;
  }
}
