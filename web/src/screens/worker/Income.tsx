// «Доход»: сколько заработано за месяц (по Алматы), сколько компания должна («К выплате»), сколько ждёт оплаты
// клиента, разбивка по неделям (пн–вс по Алматы) и список сданных заказов месяца.
import { useQuery } from "convex/react";
import { Phone, Wallet } from "lucide-react";
import { useMemo } from "react";
import { useSearchParams } from "react-router";
import { api } from "../../../convex/_generated/api";
import { useNow } from "../../data/hooks";
import { SUPPORT_PHONE, SUPPORT_TEL } from "../../data/workerLinks";
import { earnedAt, isEarning, monthIncome, payoutBalance, weeklyIncome, type WeekIncome } from "../../data/workerStats";
import { dayMonthShort, monthKeyAlmaty, monthPrepositional, shiftMonth, weekRangeLabel, weekStartAlmaty } from "../../data/workerTime";
import { cn, money, moneyShort, plural } from "../../lib/format";
import { Segmented } from "../../components/ui";
import { Empty, ListSkeleton, MUTED, ScreenTitle } from "../../components/worker/kit";
import { DoneRow } from "../../components/worker/parts";
import { PayoutHistory } from "../../components/worker/PayoutHistory";

export function Income() {
  const data = useQuery(api.worker.mine);
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const which = params.get("m") === "prev" ? "prev" : "cur";
  const current = monthKeyAlmaty(now);
  const month = which === "cur" ? current : shiftMonth(current, -1);
  // Пересчёт — когда меняются заказы, месяц или неделя, а не на каждый тик часов.
  const week = weekStartAlmaty(now);
  const orders = data?.orders;
  const income = useMemo(() => monthIncome(orders ?? [], month), [orders, month]);
  const balance = useMemo(() => payoutBalance(orders ?? []), [orders]);
  const weeks = useMemo(() => weeklyIncome(orders ?? [], week, 6), [orders, week]);
  const list = useMemo(
    () => (orders ?? []).filter((o) => isEarning(o) && monthKeyAlmaty(earnedAt(o)) === month).sort((a, b) => earnedAt(b).localeCompare(earnedAt(a))),
    [orders, month],
  );

  if (data === undefined) return <ListSkeleton count={2} />;

  return (
    <div className="mx-auto max-w-[760px] lg:max-w-[1000px]">
      <ScreenTitle title="Доход" />
      <div className="lg:max-w-[420px]">
        <Segmented
          options={[
            { value: "cur", label: "Этот месяц" },
            { value: "prev", label: "Прошлый месяц" },
          ]}
          value={which}
          onChange={(v) => setParams(v === "prev" ? { m: "prev" } : {}, { replace: true })}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <section className="card col-span-2 p-5 lg:col-span-1">
          <h2 className="text-[15px] text-ink-2">Заработано в {monthPrepositional(month)}</h2>
          <div className="mt-0.5 text-[32px] leading-tight font-bold tracking-[-0.02em] text-ink tabular-nums">{money(income.earned)}</div>
          <div className={cn("mt-0.5 text-[14.5px]", MUTED)}>
            {income.count} {plural(income.count, "заказ", "заказа", "заказов")}
          </div>
        </section>
        <Tile title="К выплате" value={balance.toPay} caption="клиент оплатил" />
        <Tile title="Ждёт оплаты клиента" value={balance.awaitingClient} caption="выплата после оплаты" />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-2 lg:items-start">
        <section className="card p-4">
          <h2 className="text-[17px] font-semibold text-ink">По неделям</h2>
          <WeekBars weeks={weeks} />
        </section>

        <section>
          <h2 className="mb-1.5 px-1 text-[15px] font-semibold text-ink">Выполненные заказы</h2>
          {list.length ? (
            <div className="card px-3">
              {list.map((o) => (
                <DoneRow key={o.id} order={o} now={now} />
              ))}
            </div>
          ) : (
            <Empty icon={Wallet} title="Пока нет выполненных заказов" text="Возьмите заказ — заработок появится здесь." />
          )}
        </section>
      </div>

      <PayoutHistory now={now} />

      <p className={cn("mt-4 text-[13.5px]", MUTED)}>
        Выплаты делает офис. Вопросы по деньгам —{" "}
        <a href={SUPPORT_TEL} className="inline-flex min-h-12 items-center gap-1 font-semibold text-[#855600] underline underline-offset-2">
          <Phone size={14} aria-hidden /> {SUPPORT_PHONE}
        </a>
      </p>
    </div>
  );
}

/** Плитка суммы. Шрифт суммы сжимается на узких экранах: «1 315 500 ₸» в половине экрана 320 px — одной строкой. */
function Tile({ title, value, caption }: { title: string; value: number; caption: string }) {
  return (
    <section className="card min-w-0 p-4">
      <h2 className="text-[14.5px] leading-snug text-ink-2">{title}</h2>
      <div className="mt-1 text-[length:clamp(16px,5.2vw,20px)] font-bold whitespace-nowrap text-ink tabular-nums">{money(value)}</div>
      <div className={cn("text-[13px]", MUTED)}>{caption}</div>
    </section>
  );
}

/** Столбики по неделям: подпись суммы над столбиком дублирует цвет текстом, у каждого — описание для диктора. */
function WeekBars({ weeks }: { weeks: WeekIncome[] }) {
  const max = Math.max(1, ...weeks.map((w) => w.total));
  return (
    <div className="mt-3 flex h-[190px] items-end gap-2">
      {weeks.map((w, i) => {
        const current = i === weeks.length - 1;
        return (
          <div key={w.start} role="img" aria-label={`Неделя ${weekRangeLabel(w.start)}: ${money(w.total)}`} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end">
            {w.total > 0 && <span className="mb-1 text-[12px] font-semibold text-ink tabular-nums">{moneyShort(w.total)}</span>}
            <span className={cn("w-full rounded-t-[6px]", current ? "bg-brand" : "bg-[#ffe39a]")} style={{ height: w.total > 0 ? Math.max(8, Math.round((w.total / max) * 140)) : 4 }} />
            <span className={cn("mt-1.5 w-full truncate text-center text-[11.5px]", current ? "font-semibold text-ink" : MUTED)}>{dayMonthShort(w.start)}</span>
          </div>
        );
      })}
    </div>
  );
}
