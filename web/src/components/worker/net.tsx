// Есть ли связь с сервером. Признаки: браузер говорит «офлайн» или сокет Convex отвалился дольше 3 секунд
// (короткие обрывы при сворачивании приложения не мигают плашкой). Пока связи нет, главные кнопки
// не начинают новых мутаций: Convex выполнил бы их позже, когда мастер уже ушёл с экрана.
import { useConvexConnectionState } from "convex/react";
import { CircleCheck, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { cn } from "../../lib/format";

const GRACE_MS = 3000;
const RESTORED_MS = 2000;

export const useNet = create<{ offline: boolean; set: (offline: boolean) => void }>()((set) => ({
  offline: false,
  set: (offline) => set({ offline }),
}));

/** Один на кабинет: следит за сетью и сокетом, пишет признак в useNet. */
export function NetWatcher() {
  const conn = useConvexConnectionState();
  const [browserOnline, setBrowserOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  const socketDown = conn.hasEverConnected && !conn.isWebSocketConnected;
  const setOffline = useNet((s) => s.set);

  useEffect(() => {
    const up = () => setBrowserOnline(true);
    const down = () => setBrowserOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);

  useEffect(() => {
    if (!browserOnline) {
      setOffline(true);
      return;
    }
    if (!socketDown) {
      setOffline(false);
      return;
    }
    const t = setTimeout(() => setOffline(true), GRACE_MS);
    return () => clearTimeout(t);
  }, [browserOnline, socketDown, setOffline]);

  return null;
}

/**
 * Плашка под шапкой: «Нет интернета…», после восстановления 2 секунды — «Связь восстановлена».
 * Ставится внутрь закреплённой шапки (своей у вкладок и у экрана заказа), поэтому сама не sticky.
 */
export function OfflineBanner({ className }: { className?: string }) {
  const offline = useNet((s) => s.offline);
  const [restored, setRestored] = useState(false);
  const [wasOffline, setWasOffline] = useState(offline);

  if (offline !== wasOffline) {
    setWasOffline(offline);
    setRestored(!offline);
  }

  useEffect(() => {
    if (!restored) return;
    const t = setTimeout(() => setRestored(false), RESTORED_MS);
    return () => clearTimeout(t);
  }, [restored]);

  if (!offline && !restored) return null;
  return (
    <div
      role="status"
      className={cn("flex min-h-11 items-center gap-2.5 px-4 py-2 text-[14.5px] font-medium", offline ? "bg-warn-bg text-[#9a5b00]" : "bg-ok-bg text-[#067a46]", className)}
    >
      {offline ? <WifiOff size={18} aria-hidden className="shrink-0" /> : <CircleCheck size={18} aria-hidden className="shrink-0" />}
      {offline ? "Нет интернета. Показываем последние данные" : "Связь восстановлена"}
    </div>
  );
}
