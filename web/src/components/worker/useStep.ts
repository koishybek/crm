// Шаги одним нажатием — «Подтвердить заказ», «Начать работу», «Снять паузу» (без шторки:
// ошибиться дёшево, а мастер на объекте). Общие для экрана заказа и карточки «Следующий заказ».
import { executorAction, toast } from "../../data/store";
import { refusalOf } from "../../data/workerStatus";
import { useBusy } from "./kit";
import { useNet } from "./net";

export type QuickStep = "accept" | "start" | "resume";

const DONE_TEXT: Record<QuickStep, string> = {
  accept: "Заказ подтверждён. Адрес и телефон открыты",
  start: "Работа начата",
  resume: "Продолжаем работу",
};

export function useStep() {
  const { busy, slow, run } = useBusy();
  const offline = useNet((s) => s.offline);
  const step = (id: string, action: QuickStep) =>
    run(async () => {
      const r = await executorAction(id, action);
      if (r.ok) return toast(DONE_TEXT[action]);
      const kind = refusalOf(r.error);
      if (kind === "changed" || kind === "not_yours") toast("Статус заказа уже изменился — экран обновлён", "info");
      else toast(offline || kind === "network" ? "Нет связи с сервером — проверьте интернет" : "Что-то пошло не так. Попробуйте ещё раз", "bad");
    });
  return { busy, slow, step };
}
