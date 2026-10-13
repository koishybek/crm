// Правила пароля, который человек задаёт себе сам (аудит M-8, L-1, E30) — одни для сервера (users.changeMyPassword)
// и для формы «Смените пароль», чтобы подсказка в форме и отказ сервера совпадали.
import type { Role } from "./types";

/** Самый длинный пароль: защита от «пароля» на мегабайт, который сервер хешировал бы Scrypt. */
export const PASSWORD_MAX = 128;

/** Владельцу — от 12 символов: его аккаунт открывает всё; остальным — от 10. */
export const passwordMin = (role: Role | undefined): number => (role === "owner" ? 12 : 10);

/** Что не так с новым паролем; null — подходит. */
export function passwordProblem(next: string, role: Role | undefined, current?: string): string | null {
  const min = passwordMin(role);
  if (next.length < min) return `Пароль — не короче ${min} символов`;
  if (next.length > PASSWORD_MAX) return `Пароль — не длиннее ${PASSWORD_MAX} символов`;
  if (!next.trim()) return "Пароль не может состоять из одних пробелов";
  if (current !== undefined && next === current) return "Новый пароль должен отличаться от текущего";
  return null;
}
