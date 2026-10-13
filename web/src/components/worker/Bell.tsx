// Колокольчик мастера: уведомления открываются шторкой снизу — выпадающий список шириной 360 px
// не помещается на экране телефона.
import { useQuery } from "convex/react";
import { Bell } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../../../convex/_generated/api";
import { useNow } from "../../data/hooks";
import { markAllRead } from "../../data/store";
import { whenLabel } from "../../data/workerTime";
import { cn } from "../../lib/format";
import { MUTED, WButton } from "./kit";
import { Sheet } from "./Sheet";

const DOT = { info: "bg-[#1767c2]", ok: "bg-[#067a46]", warn: "bg-[#9a5b00]", bad: "bg-[#c41d3a]" } as const;

export function WorkerBell() {
  const now = useNow(60_000);
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const data = useQuery(api.notifications.mine, { now: Math.floor(now / 60_000) * 60_000 });
  const items = data?.items ?? [];
  const alerts = data?.alerts ?? [];
  const unread = items.filter((n) => !n.read).length + alerts.length;

  const go = (link?: string) => {
    setOpen(false);
    if (link) nav(link);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unread ? `Уведомления, новых: ${unread}` : "Уведомления"}
        className="relative inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-ink-2 hover:bg-[#f4f2ec]"
      >
        <Bell size={23} strokeWidth={1.8} aria-hidden />
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#c41d3a] px-1 text-[11px] font-bold text-white" aria-hidden>
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title="Уведомления"
        footer={
          items.some((n) => !n.read) ? (
            <WButton variant="secondary" full onClick={() => void markAllRead()}>
              Отметить все прочитанными
            </WButton>
          ) : undefined
        }
      >
        {!alerts.length && !items.length ? (
          <p className={cn("py-8 text-center text-[15px]", MUTED)}>Пока тихо. Новые заказы и сообщения появятся здесь.</p>
        ) : (
          <ul className="-mx-2">
            {alerts.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => go(a.link)} className="flex min-h-12 w-full items-start gap-3 rounded-[12px] px-2 py-2.5 text-left hover:bg-[#f7f4ec]">
                  <span className={cn("mt-2 h-2.5 w-2.5 shrink-0 rounded-full", DOT[a.tone])} aria-hidden />
                  <span className="text-[15px] font-semibold text-ink">{a.text}</span>
                </button>
              </li>
            ))}
            {items.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => go(n.link)} className="flex min-h-12 w-full items-start gap-3 rounded-[12px] px-2 py-2.5 text-left hover:bg-[#f7f4ec]">
                  <span className={cn("mt-2 h-2.5 w-2.5 shrink-0 rounded-full", n.read ? "bg-line-strong" : DOT[n.tone])} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block text-[15px]", n.read ? "text-ink-2" : "font-semibold text-ink")}>{n.text}</span>
                    <span className={cn("text-[13px]", MUTED)}>{whenLabel(n.at, now)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
    </>
  );
}
