import { ConvexReactClient } from "convex/react";
import { ConvexError } from "convex/values";

const url = import.meta.env.VITE_CONVEX_URL as string | undefined;
if (!url) throw new Error("VITE_CONVEX_URL не задан — запустите `npx convex dev` или пропишите адрес в .env.local");

export const convex = new ConvexReactClient(url);

export type Result<T = void> = { ok: true; value: T } | { ok: false; error: string };

/** Текст ошибки для человека: ConvexError несёт наш текст, остальное — общий ответ. */
export function errorText(e: unknown): string {
  if (e instanceof ConvexError) return typeof e.data === "string" ? e.data : "Не получилось";
  if (e instanceof Error && /network|fetch|connection/i.test(e.message)) return "Нет связи с сервером — проверьте интернет";
  return "Что-то пошло не так. Попробуйте ещё раз";
}

/** Любой вызов сервера → Result, чтобы экраны одинаково показывали ошибки. */
export async function run<T>(p: Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    // Ожидаемые отказы (ConvexError с текстом для человека) не шумят в консоли.
    if (!(e instanceof ConvexError)) console.error(e);
    return { ok: false, error: errorText(e) };
  }
}
