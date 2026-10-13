// Действия безопасности из интерфейса: смена своего пароля (аудит M-8) и показ ключа АТС владельцу (аудит M-11).
import { api } from "../../convex/_generated/api";
import { convex, run } from "./convex";

/** Смена своего пароля — и обязательная после временного, и по желанию из меню профиля. */
export const changeMyPassword = (current: string, next: string) => run(convex.action(api.users.changeMyPassword, { current, next }));

/** Ключ АТС целиком: каждый показ записывается в журнал. */
export const revealPbxSecret = () => run(convex.mutation(api.calls.revealPbxSecret, {}));
