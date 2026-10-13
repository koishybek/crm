// «Взять заказ №…?» — шторка подтверждения. Исход решает сервер: успел, не успел (взял другой мастер),
// приём выключен (включим и возьмём), заказ не подходит, нет связи. Данные заказа живые: если выплата
// изменилась, пока шторка открыта, показываем «было → стало» и на секунду блокируем кнопку.
import { CircleCheck, CircleX, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { serviceById } from "../../data/catalog";
import { toast } from "../../data/store";
import type { WorkerOrder } from "../../data/types";
import { takeWithShift } from "../../data/workerActions";
import { refusalOf } from "../../data/workerStatus";
import { dueLabel, isPast } from "../../data/workerTime";
import { useNow } from "../../data/hooks";
import { money } from "../../lib/format";
import { ServiceTile } from "../icons";
import { MUTED, WButton, busyLabel, useBusy } from "./kit";
import { useNet } from "./net";
import { Sheet } from "./Sheet";

type Phase = "ask" | "ok" | "taken" | "not_fit";

export type TakeOrder = Pick<WorkerOrder, "id" | "number" | "serviceId" | "city" | "deadline" | "payout" | "priority">;

interface TakeSheetProps {
  order: TakeOrder;
  /** Заказ пропал из ленты, пока шторка открыта (взял другой мастер, сняли с ленты). */
  gone: boolean;
  /** Мастер принимает заказы. */
  available: boolean;
  onClose: () => void;
  /** Заказ стал вашим — перейти к нему. */
  onTaken: (id: string) => void;
}

export function TakeSheet({ order, gone, available, onClose, onTaken }: TakeSheetProps) {
  const now = useNow();
  const offline = useNet((s) => s.offline);
  const { busy, slow, run } = useBusy();
  const [phase, setPhase] = useState<Phase>("ask");
  const [error, setError] = useState<string | null>(null);
  // Сервер сказал «приём выключен», хотя экран ещё не обновился, — тоже предлагаем включить.
  const [shiftOff, setShiftOff] = useState(false);
  const needShift = !available || shiftOff;

  const [firstPayout] = useState(order.payout);
  const [lastPayout, setLastPayout] = useState(order.payout);
  const [cooldown, setCooldown] = useState(false);
  if (order.payout !== lastPayout) {
    setLastPayout(order.payout);
    setCooldown(true);
  }
  useEffect(() => {
    if (!cooldown) return;
    const t = setTimeout(() => setCooldown(false), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // «Готово» видно 400 мс, затем переход к заказу. Колбэк — через ref: живые обновления не сбивают таймер.
  const taken = useRef(onTaken);
  useLayoutEffect(() => {
    taken.current = onTaken;
  });
  useEffect(() => {
    if (phase !== "ok") return;
    const t = setTimeout(() => taken.current(order.id), 400);
    return () => clearTimeout(t);
  }, [phase, order.id]);

  // Свой успешный запрос тоже убирает заказ из ленты — «пропал» считаем только вне отправки.
  const vanished = phase === "ask" && gone && !busy;

  const take = () =>
    run(async () => {
      setError(null);
      const r = await takeWithShift(order.id, needShift);
      if (r.ok) {
        toast(`Заказ №${order.number} ваш. Позвоните клиенту`);
        setPhase("ok");
        return;
      }
      const kind = refusalOf(r.error);
      if (kind === "mine") {
        toast(`Заказ №${order.number} уже ваш`, "info");
        setPhase("ok");
      } else if (kind === "taken") setPhase("taken");
      else if (kind === "not_fit") setPhase("not_fit");
      else if (kind === "off_shift") {
        setShiftOff(true);
        setError("Сейчас приём заказов выключен. Нажмите ещё раз — включим приём и возьмём заказ.");
      } else setError(kind === "network" || offline ? "Нет связи. Проверьте интернет и попробуйте ещё раз." : "Не получилось взять заказ. Проверьте интернет и попробуйте ещё раз.");
    });

  const s = serviceById(order.serviceId);
  const late = isPast(order.deadline, now);

  if (phase === "taken" || vanished)
    return (
      <Sheet
        open
        onClose={onClose}
        title="Не успели"
        footer={
          <WButton size="lg" full onClick={onClose}>
            Смотреть другие заказы
          </WButton>
        }
      >
        <div className="flex flex-col items-center py-4 text-center">
          <CircleX size={44} className="text-[#6b675f]" aria-hidden />
          <p className="mt-3 text-[16px] text-ink-2">{phase === "taken" ? "Этот заказ уже взял другой мастер." : "Заказ больше недоступен."}</p>
        </div>
      </Sheet>
    );

  if (phase === "not_fit")
    return (
      <Sheet
        open
        onClose={onClose}
        title="Заказ вам не подходит"
        footer={
          <WButton size="lg" full onClick={onClose}>
            Понятно
          </WButton>
        }
      >
        <p className="text-[16px] text-ink-2">Заказ не подходит под ваши услуги, навыки или город. Если это ошибка — позвоните в офис.</p>
      </Sheet>
    );

  const primaryText = phase === "ok" ? "Готово" : needShift ? "Включить приём и взять" : "Да, беру заказ";

  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy || phase === "ok"}
      title={`Взять заказ №${order.number}?`}
      footer={
        <>
          <WButton variant="ghost" full onClick={onClose} disabled={busy || phase === "ok"}>
            Отмена
          </WButton>
          <WButton
            size="lg"
            full
            icon={phase === "ok" ? CircleCheck : undefined}
            busy={busy}
            busyText={busyLabel(slow, "Берём заказ…")}
            disabled={offline || cooldown || phase === "ok"}
            onClick={() => void take()}
          >
            {offline ? "Нет связи" : error ? "Повторить" : primaryText}
          </WButton>
          {error && (
            <p role="alert" className="text-center text-[14px] font-medium text-[#c41d3a]">
              {error}
            </p>
          )}
        </>
      }
    >
      <div className="rounded-[12px] bg-[#faf8f3] p-3.5">
        <div className="flex items-center gap-3">
          <ServiceTile serviceId={order.serviceId} size={44} />
          <span className="min-w-0 text-[16px] leading-snug font-semibold text-ink">{s.label}</span>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1.5 text-[15px]">
          <dt className={MUTED}>Срок</dt>
          <dd className={late ? "font-semibold text-[#c41d3a]" : "text-ink"}>{dueLabel(order.deadline, now)}</dd>
          <dt className={MUTED}>Где</dt>
          <dd className="text-ink">{order.city}</dd>
          <dt className={MUTED}>Вы получите</dt>
          <dd className="text-[24px] font-bold whitespace-nowrap text-ink tabular-nums">{money(order.payout)}</dd>
        </dl>
      </div>
      {order.payout !== firstPayout && (
        <p className="mt-3 rounded-[12px] bg-warn-bg px-3.5 py-2.5 text-[14.5px] font-medium text-[#9a5b00]" role="status">
          Оплата изменилась: было {money(firstPayout)}, стало {money(order.payout)}
        </p>
      )}
      <p className={`mt-3 text-[14.5px] ${MUTED}`}>
        Заказ сразу станет вашим — откроются адрес и телефон клиента. Если передумаете, откажитесь как можно раньше: заказ вернётся в ленту.
      </p>
      {needShift && (
        <p className="mt-3 flex gap-2 rounded-[12px] bg-slate-bg px-3.5 py-2.5 text-[14.5px] text-ink-2">
          <Lock size={18} className="mt-0.5 shrink-0" aria-hidden />
          Сейчас приём заказов выключен. Включим его — и заказ станет вашим.
        </p>
      )}
      {late && <Warn>Срок по заказу уже прошёл — время приезда согласуйте с оператором.</Warn>}
      {order.priority === "urgent" && <Warn>Срочный заказ — позвоните клиенту сразу после того, как возьмёте.</Warn>}
    </Sheet>
  );
}

function Warn({ children }: { children: string }) {
  return (
    <p className="mt-3 flex gap-2 rounded-[12px] bg-warn-bg px-3.5 py-2.5 text-[14.5px] font-medium text-[#9a5b00]">
      <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
      {children}
    </p>
  );
}
