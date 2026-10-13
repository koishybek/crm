// Плашка «Оплата изменилась: было…, стало…» на экране своего заказа: сравниваем с тем, что мастер видел
// в прошлый раз. Заказ открыт впервые (или только что стал своим) — с тем, что на экране сейчас: правки
// оператора, пока экран открыт, видны сразу (данные заказа живые). Снимок запоминаем при первом
// просмотре, при уходе с экрана и по «Понятно».
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { WorkerOrder } from "../../data/types";
import { isActiveWork } from "../../data/workerStats";
import { changeOf, readSeen, seenBase, seenOf, writeSeen, type OrderChange, type SeenOrder } from "../../data/workerSeen";

/** База сравнения — для какого заказа (null — заказ не свой, сравнивать нечего) и сам снимок. */
type Base = { id: string | null; seen: SeenOrder | null };

const baseFor = (id: string | null, current: SeenOrder): Base => ({ id, seen: id === null ? null : seenBase(id, current) });

export function useOrderChange(o: WorkerOrder, mine: boolean): { change: OrderChange | null; ack: () => void } {
  const current = seenOf(o);
  const id = mine ? o.id : null;
  const [base, setBase] = useState<Base>(() => baseFor(id, current));
  // Свободный заказ стал своим, пока экран открыт (взял его здесь или в Telegram), — новая база.
  if (base.id !== id) setBase(baseFor(id, current));

  const latest = useRef({ current, mine });
  useLayoutEffect(() => {
    latest.current = { current, mine };
  });

  useEffect(() => {
    const orderId = o.id;
    if (latest.current.mine && readSeen(orderId) === null) writeSeen(orderId, latest.current.current);
    return () => {
      if (latest.current.mine) writeSeen(orderId, latest.current.current);
    };
  }, [o.id, mine]);

  const change = base.id !== null && base.id === id && base.seen ? changeOf(base.seen, current, isActiveWork(o)) : null;
  const ack = () => {
    writeSeen(o.id, current);
    setBase({ id, seen: current });
  };
  return { change, ack };
}
