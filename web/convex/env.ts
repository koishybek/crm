/** Переменные окружения деплоймента. Через этот модуль — чтобы фронт, который видит типы convex/, не требовал типов Node. */
export function env(key: string): string | undefined {
  const p = (globalThis as { process?: { env: Record<string, string | undefined> } }).process;
  const value = p?.env[key];
  return value && value.trim() ? value.trim() : undefined;
}
