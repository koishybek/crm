// OLX: действия владельца в карточке «OLX» (подключение через страницу OLX, синхронизация, отключение)
// и итог возврата с OLX в настройки (/settings?olx=connected|error&reason=…).
import { api } from "../../convex/_generated/api";
import { convex, run, type Result } from "./convex";

const OLX_LOGIN = "https://www.olx.kz/";

/** Адрес входа OLX — от сервера; уводим браузер только на olx.kz. */
export async function startOlxConnect(): Promise<Result> {
  const r = await run(convex.mutation(api.channels.olx.connectUrl, {}));
  if (!r.ok) return r;
  if (!r.value.startsWith(OLX_LOGIN)) return { ok: false, error: "Сервер вернул неожиданный адрес — подключение отменено" };
  window.location.assign(r.value);
  return { ok: true, value: undefined };
}

export const syncOlxNow = () => run(convex.mutation(api.channels.olx.syncNow, {}));
export const disconnectOlx = () => run(convex.mutation(api.channels.olx.disconnect, {}));

/** Короткие коды причин из адреса возврата → текст для владельца. */
const RETURN_ERRORS: Record<string, string> = {
  state: "Ссылка подключения устарела или уже использована — нажмите «Подключить OLX» ещё раз",
  expired: "Подключение заняло больше 10 минут — нажмите «Подключить OLX» ещё раз",
  denied: "Доступ не выдан: на странице OLX отказались. Нажмите «Подключить OLX» и выберите «Разрешить»",
  code: "Код подключения от OLX устарел — попробуйте ещё раз",
  exchange: "OLX не выдал доступ — попробуйте подключить ещё раз",
  client: "OLX не принял ключи приложения — проверьте OLX_CLIENT_ID, OLX_CLIENT_SECRET и статус приложения на developer.olx.kz",
  scope: "OLX выдал не все права (нужны чтение, ответы и API v2) — проверьте настройки приложения на developer.olx.kz",
  account: "Не удалось получить данные аккаунта OLX — попробуйте ещё раз",
  blocked: "OLX временно ограничил запросы — попробуйте через полчаса",
  config: "OLX ещё не настроен на сервере: нет ключей приложения",
  key: "Не задан ключ шифрования INTEGRATIONS_KEY — токены OLX сохранить нельзя. Задайте его в окружении Convex и подключите OLX ещё раз",
};

/** Тост после возврата с OLX; null — в адресе нет итога подключения. */
export function olxReturnMessage(result: string | null, reason: string | null): { text: string; tone: "ok" | "bad" } | null {
  if (result === "connected") return { text: "OLX подключён — сообщения покупателей появятся в «Сообщениях» в течение минуты", tone: "ok" };
  if (result !== "error") return null;
  const text = reason && Object.hasOwn(RETURN_ERRORS, reason) ? RETURN_ERRORS[reason] : undefined;
  return { text: text ?? "OLX не подключён — попробуйте ещё раз", tone: "bad" };
}
