// Подписка своей компании (ТЗ §24): строка в карточке «Компания», плашка на «Главной» за 7 дней до конца и причина
// на экране «Доступ отключён». Правила сроков — src/data/billing.ts.
import { useQuery } from "convex/react";
import { CalendarClock } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { dayText, daysText, statusText } from "../data/billing";
import { PLAN_INFO } from "../data/plans";

/** «Подписка: тариф «Стандарт», оплачено до 14.11.2026» — в карточке «Компания» (только владельцу). */
export function SubscriptionLine() {
  const s = useQuery(api.billing.mine);
  if (!s) return null;
  const tone = s.status.state === "expired" ? "text-bad-ink" : s.status.state === "ending" ? "text-[#b07200]" : "text-ink";
  return (
    <div>
      <div className="text-[12.5px] font-medium text-muted">Подписка</div>
      <div className="mt-0.5 text-[14px] text-ink">
        тариф «{PLAN_INFO[s.plan].label}», {s.paidUntil ? `оплачено до ${dayText(s.paidUntil)}` : "бессрочно"}
        {s.paidUntil && s.status.state !== "paid" && <span className={`font-semibold ${tone}`}> — {statusText(s.status, s.paidUntil)}</span>}
      </div>
      {s.status.state !== "paid" && s.status.state !== "unlimited" && s.howToPay && <p className="mt-1 text-[12.5px] whitespace-pre-line text-muted">Как оплатить: {s.howToPay}</p>}
    </div>
  );
}

/** Плашка на «Главной» владельцу: до конца подписки 7 дней или меньше (или она уже закончилась). */
export function SubscriptionBanner() {
  const s = useQuery(api.billing.mine);
  if (!s || !s.paidUntil || (s.status.state !== "ending" && s.status.state !== "expired")) return null;
  const left = s.status.daysLeft ?? 0;
  const text =
    left < 0
      ? `Подписка закончилась ${dayText(s.paidUntil)} — ${daysText(-left)} назад. Продлите, чтобы работа компании не остановилась.`
      : `Подписка оплачена до ${dayText(s.paidUntil)} — ${left === 0 ? "сегодня последний день" : `осталось ${daysText(left)}`}. Продлите — напишите нам.`;
  return (
    <div role="status" className="mb-4 flex items-start gap-3 rounded-[14px] border border-[#ffd36b] bg-[#fff6d9] px-4 py-3 text-[14px] text-ink">
      <CalendarClock size={20} className="mt-0.5 shrink-0 text-[#b07200]" aria-hidden />
      <div className="min-w-0">
        <div className="font-semibold">{text}</div>
        {s.howToPay ? <div className="mt-0.5 whitespace-pre-line text-ink-2">Как оплатить: {s.howToPay}</div> : null}
        <Link to="/settings" className="mt-1 inline-block font-medium text-[#b07200] hover:underline">
          Тариф и подписка
        </Link>
      </div>
    </div>
  );
}

/** Почему отключён доступ: работа компании приостановлена (за неоплату — с текстом «Как оплатить»). Иначе — fallback. */
export function BlockedReason({ fallback }: { fallback: ReactNode }) {
  const b = useQuery(api.billing.blocked);
  if (!b) return <>{fallback}</>;
  return (
    <div className="max-w-sm text-[14.5px] text-muted">
      <p>
        {b.unpaid
          ? `Работа компании «${b.company}» приостановлена: подписка не оплачена${b.paidUntil ? ` (была до ${dayText(b.paidUntil)})` : ""}. Все данные сохранены — после оплаты доступ вернётся сам.`
          : `Работа компании «${b.company}» приостановлена администратором платформы. Данные сохранены.`}
      </p>
      <p className="mt-2 whitespace-pre-line text-ink">{b.unpaid && b.howToPay ? `Как оплатить: ${b.howToPay}` : "Свяжитесь с администратором платформы."}</p>
    </div>
  );
}
