// Экран заказа мастера — один адрес /w/orders/:id и для свободного заказа из ленты, и для своего.
// Данные — executorApp.order: только то, что мастеру можно видеть (без цены клиента и переписки команды):
// фото и документы, отмеченные для мастера, и переписка «С мастером». Ссылки на файлы обновляются раз в 5 минут.
// Внизу панель действий: ровно одна главная кнопка по статусу, рядом звонок, маршрут, сообщение оператору.
import { useQuery } from "convex/react";
import {
  ArrowLeft,
  Ban,
  BadgeCheck,
  Check,
  CircleCheck,
  CircleX,
  Clock,
  Copy,
  EllipsisVertical,
  FileText,
  Flame,
  Headset,
  Inbox,
  Info,
  Lock,
  MapPin,
  MessageCircle,
  Navigation,
  Pause,
  Phone,
  Play,
  TriangleAlert,
  Undo2,
  UserRound,
  Wallet,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import { api } from "../../../convex/_generated/api";
import { categoryById, serviceById } from "../../data/catalog";
import { useFileQuery } from "../../data/files";
import { useNow } from "../../data/hooks";
import { toast } from "../../data/store";
import type { WorkerOrder } from "../../data/types";
import { isFresh } from "../../data/workerFeed";
import { SUPPORT_PHONE, SUPPORT_TEL, telHref } from "../../data/workerLinks";
import { maxActiveOf } from "../../data/logic";
import { hasSkill } from "../../data/workerMatch";
import { clientShortName } from "../../data/workerNames";
import type { OrderChange } from "../../data/workerSeen";
import { isActiveWork, isEarning } from "../../data/workerStats";
import { contactsLocked, isOverdueWork, statusView, stepsOf } from "../../data/workerStatus";
import { dueLabel, durationLabel, whenLabel } from "../../data/workerTime";
import type { WorkerFile, WorkerNote, WorkerPhoto } from "../../data/workerTypes";
import { cn, money, phone } from "../../lib/format";
import { ServiceGlyph, ServiceTile } from "../../components/icons";
import { Gallery } from "../../components/worker/Gallery";
import { Empty, IconBtn, MUTED, Skeleton, WBadge, WButton, WLinkButton, busyLabel } from "../../components/worker/kit";
import { copyAddress, useRoute } from "../../components/worker/MapSheet";
import { OfflineBanner, useNet } from "../../components/worker/net";
import { DueText, PayoutChipBadge, Photo, StatusBadge, StatusStepper } from "../../components/worker/parts";
import { Sheet } from "../../components/worker/Sheet";
import { TakeSheet } from "../../components/worker/TakeSheet";
import { useOrderChange } from "../../components/worker/useOrderChange";
import { useStep } from "../../components/worker/useStep";
import { DeclineSheet, DoneSheet, MessageSheet, PauseSheet } from "../../components/worker/WorkSheets";

type Mode = "feed" | "mine";
type SheetKind = "take" | "decline" | "pause" | "done" | "message" | "more";

export function OrderPage() {
  const { id = "" } = useParams();
  // Другой заказ — другое состояние экрана (открытые шторки, «заказ больше не ваш»).
  return <OrderScreen key={id} id={id} />;
}

function OrderScreen({ id }: { id: string }) {
  const view = useFileQuery(api.executorApp.order, { id });
  const mine = useQuery(api.worker.mine);
  const nav = useNavigate();
  const [sheet, setSheet] = useState<SheetKind | null>(null);
  const [lost, setLost] = useState(false);

  // Заказ перестал быть «моим», пока экран открыт: оператор снял или передал другому.
  // Пока открыта шторка отказа, это сам мастер отказывается — тогда просто уходим в «Мои заказы».
  const state = view?.state;
  const prev = useRef(state);
  useEffect(() => {
    const before = prev.current;
    prev.current = state;
    if (before === "mine" && state !== undefined && state !== "mine" && sheet !== "decline") setLost(true);
    // Взял заказ не здесь (например, кнопкой в Telegram), пока смотрел его в приложении.
    if (before === "available" && state === "mine" && sheet !== "take") toast("Этот заказ уже ваш", "info");
  }, [state, sheet]);

  const back = (fallback: string) => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(fallback, { replace: true });
  };

  if (view === undefined) return <OrderSkeleton />;

  if (lost)
    return (
      <Notice
        icon={Inbox}
        title="Заказ больше не ваш"
        text="Оператор передал его другому мастеру или вернул в ленту. Если это ошибка — позвоните в офис."
        actions={
          <>
            <WButton size="lg" full onClick={() => nav("/w/my")}>
              Мои заказы
            </WButton>
            <WButton variant="secondary" full onClick={() => nav("/w")}>
              К заказам
            </WButton>
          </>
        }
        onBack={() => back("/w/my")}
      />
    );

  if (view.state === "taken" || view.state === "unavailable")
    return (
      <Notice
        icon={view.state === "taken" ? CircleX : Inbox}
        title={view.state === "taken" ? "Этот заказ уже взял другой мастер" : "Заказ недоступен"}
        text={view.state === "taken" ? "Ничего страшного — в ленте есть другие заказы." : "Его уже взяли или отменили, либо ссылка устарела."}
        actions={
          <WButton size="lg" full onClick={() => nav("/w")}>
            Смотреть другие заказы
          </WButton>
        }
        onBack={() => back("/w")}
      />
    );

  const ex = mine?.executor;
  const mode: Mode = view.state === "mine" ? "mine" : "feed";
  // Лимит заказов в работе (ТЗ п.14): на лимите взять новый нельзя — сервер откажет, экран объясняет заранее.
  const limited = !!ex && (mine?.orders.filter(isActiveWork).length ?? 0) >= maxActiveOf(ex);
  return (
    <OrderView
      mode={mode}
      order={view.order}
      photos={view.photos}
      documents={view.documents}
      notes={view.state === "mine" ? view.notes : []}
      publishedAt={view.state === "available" ? view.publishedAt : undefined}
      skills={ex?.skills ?? []}
      available={ex?.available ?? true}
      limited={limited}
      sheet={sheet}
      setSheet={setSheet}
      onBack={() => back(mode === "mine" ? "/w/my" : "/w")}
      onDeclined={() => nav("/w/my", { replace: true })}
    />
  );
}

// ── Экран заказа ─────────────────────────────────────────────────────────────

interface OrderViewProps {
  mode: Mode;
  order: WorkerOrder;
  photos: WorkerPhoto[];
  documents: WorkerFile[];
  notes: WorkerNote[];
  publishedAt?: string;
  skills: string[];
  available: boolean;
  /** У мастера уже столько заказов в работе, сколько можно взять одновременно. */
  limited: boolean;
  sheet: SheetKind | null;
  setSheet: (s: SheetKind | null) => void;
  onBack: () => void;
  onDeclined: () => void;
}

interface Act {
  key: string;
  /** Подпись под иконкой в нижней панели (телефон). */
  short: string;
  /** Подпись на кнопке в правой колонке (компьютер). */
  long: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  danger?: boolean;
}

function OrderView({ mode, order: o, photos, documents, notes, publishedAt, skills, available, limited, sheet, setSheet, onBack, onDeclined }: OrderViewProps) {
  const now = useNow();
  const nav = useNavigate();
  const offline = useNet((s) => s.offline);
  const { busy, slow, step } = useStep();
  const route = useRoute(o.city, o.address);
  const s = serviceById(o.serviceId);
  const mineMode = mode === "mine";
  const changed = useOrderChange(o, mineMode);
  const contacts = mineMode && !contactsLocked(o) && !!o.address;
  const active = mineMode && isActiveWork(o);
  const overdue = mineMode && isOverdueWork(o, now);
  const steps = mineMode ? stepsOf(o) : null;
  const sv = statusView(o, now);

  const call: Act | null = contacts && o.clientPhone ? { key: "call", short: "Звонок", long: "Позвонить клиенту", icon: Phone, href: telHref(o.clientPhone) } : null;
  const routeAct: Act | null = contacts ? { key: "route", short: "Маршрут", long: "Построить маршрут", icon: Navigation, href: route.href, onClick: route.href ? undefined : route.open } : null;
  const write: Act = { key: "write", short: "Написать", long: "Написать оператору", icon: MessageCircle, onClick: () => setSheet("message") };
  const office: Act = { key: "office", short: "Офис", long: "Позвонить в офис", icon: Headset, href: SUPPORT_TEL };
  const decline: Act = { key: "decline", short: "Отказ", long: "Отказаться от заказа", icon: Undo2, onClick: () => setSheet("decline"), danger: true };
  const pause: Act = { key: "pause", short: "Жду клиента", long: "Жду клиента — пауза", icon: Pause, onClick: () => setSheet("pause") };
  // «Снять паузу», а не «Продолжить»: два коротких слова помещаются в квадрат 64 px и на экране 320 px.
  // Подпись та же и на компьютере — подсказка под шагами ссылается на неё (workerStatus.ts).
  const resume: Act = { key: "resume", short: "Снять паузу", long: "Снять паузу", icon: Play, onClick: () => void step(o.id, "resume") };

  let primary: { label: string; busyText: string; onClick: () => void; soft?: boolean; icon?: LucideIcon } | null = null;
  let secondary: (Act | null)[] = [];
  let note: ReactNode = null;

  if (!mineMode) {
    const locked = !available || limited;
    primary = { label: "Взять заказ", busyText: "Берём заказ…", onClick: () => setSheet("take"), soft: locked, icon: locked ? Lock : undefined };
    secondary = [office];
  } else if (o.status === "assigned") {
    primary = { label: "Подтвердить заказ", busyText: "Отправляем…", onClick: () => void step(o.id, "accept") };
    secondary = [decline, write];
  } else if (o.status === "accepted") {
    primary = { label: "Начать работу", busyText: "Отправляем…", onClick: () => void step(o.id, "start") };
    secondary = [call ?? write, routeAct ?? office];
  } else if (o.status === "in_progress" || o.status === "awaiting_client") {
    // Главная кнопка всю работу одна — «Работа выполнена» (сдать можно и с паузы); пауза — переключатель рядом.
    primary = { label: "Работа выполнена", busyText: "Отправляем…", onClick: () => setSheet("done") };
    secondary = [o.status === "in_progress" ? pause : resume, call ?? write];
  } else if (isEarning(o)) {
    secondary = [write];
    note = o.payoutPaid ? (
      <span className="inline-flex items-center gap-1.5 font-semibold text-[#067a46]">
        <CircleCheck size={18} aria-hidden /> Выплачено {money(o.payout)}
      </span>
    ) : o.status === "paid" || o.status === "closed" ? (
      `Клиент оплатил · ${money(o.payout)} к выплате`
    ) : (
      `Работа сдана · ${money(o.payout)} после оплаты клиентом`
    );
  } else if (o.status === "cancelled" || o.status === "refund") {
    secondary = [write, office];
    note = o.status === "refund" ? "Оформлен возврат" : "Заказ отменён";
  } else {
    // Оператор вернул заказ в работу у себя (например, восстановил отменённый) — ждём его решения.
    secondary = [write, office];
    note = "Заказ у оператора — он свяжется с вами";
  }
  const acts = secondary.filter((a): a is Act => a !== null);

  // Полный список вторичных действий — для правой колонки на компьютере и меню «⋮».
  const desktopActs = [
    ...(mineMode ? [call, routeAct, write] : []),
    ...(o.status === "in_progress" ? [pause] : []),
    ...(o.status === "awaiting_client" ? [resume] : []),
    ...(mineMode && (o.status === "assigned" || o.status === "accepted") ? [decline] : []),
    office,
  ].filter((a): a is Act => a !== null);

  const primaryButton = primary && (
    <WButton
      size="lg"
      full
      icon={primary.icon}
      busy={busy}
      busyText={busyLabel(slow, primary.busyText)}
      softDisabled={primary.soft}
      disabled={offline}
      onClick={primary.onClick}
      aria-label={primary.soft && !offline ? `${primary.label}. Сначала включите приём заказов` : undefined}
    >
      {offline ? "Нет связи" : primary.label}
    </WButton>
  );

  return (
    <div className="mx-auto max-w-[1120px]">
      {/* Шапка экрана заказа (телефон): «назад», номер, меню. */}
      <div className="sticky top-0 z-30 lg:hidden">
        <header className="flex h-14 items-center gap-1 border-b border-line bg-white px-1">
          <IconBtn icon={ArrowLeft} label="Назад" onClick={onBack} />
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">Заказ №{o.number}</h1>
          <IconBtn icon={EllipsisVertical} label="Ещё действия" onClick={() => setSheet("more")} />
        </header>
        <OfflineBanner />
      </div>

      <button type="button" onClick={onBack} className={cn("mb-3 hidden min-h-12 items-center gap-2 text-[15px] lg:inline-flex", MUTED)}>
        <ArrowLeft size={18} aria-hidden /> {mineMode ? "Мои заказы" : "Заказы"}
      </button>
      {/* На компьютере шапки экрана заказа нет — заголовок для диктора. */}
      <h1 className="sr-only hidden lg:block">Заказ №{o.number}</h1>

      <StateBanner order={o} mode={mode} now={now} overdue={overdue} change={changed.change} onAck={changed.ack} onWrite={() => setSheet("message")} />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
        <div className="min-w-0">
          <Gallery photos={photos} />

          {/* Голова: деньги, услуга, метки. */}
          <section className="px-4 pt-4 lg:px-0">
            <div className="flex items-start gap-3">
              {!photos.length && <ServiceTile serviceId={o.serviceId} size={56} />}
              <div className="min-w-0 flex-1">
                <div className={cn("text-[13.5px]", MUTED)}>Вы получите</div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-[32px] leading-tight font-bold tracking-[-0.02em] text-ink tabular-nums">{money(o.payout)}</span>
                  {/* У отмены и возврата это уже сказано бейджем статуса и плашкой сверху. */}
                  {mineMode && o.status !== "cancelled" && o.status !== "refund" && <PayoutChipBadge order={o} />}
                </div>
              </div>
            </div>
            <h2 className="mt-2 flex items-start gap-2 text-[20px] leading-[26px] font-semibold text-ink">
              {!!photos.length && <ServiceGlyph serviceId={o.serviceId} size={22} className="mt-0.5 shrink-0" />}
              <span className="min-w-0">{s.label}</span>
            </h2>
            <div className={cn("text-[14.5px]", MUTED)}>{categoryById(s.category).label}</div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {mineMode && <StatusBadge order={o} now={now} />}
              {o.priority === "urgent" && (
                <WBadge tone="bad" icon={Flame}>
                  Срочно
                </WBadge>
              )}
              {o.priority === "high" && <WBadge tone="warn">Важно</WBadge>}
              {!mineMode && publishedAt && isFresh(publishedAt, now) && <WBadge tone="brand">Новый</WBadge>}
            </div>
          </section>

          {steps && (
            <section className="px-4 pt-4 lg:hidden">
              <StatusStepper steps={steps} />
              {sv.hint && <p className="mt-2.5 text-[15px] text-ink-2">{sv.hint}</p>}
            </section>
          )}

          <InfoRows order={o} mode={mode} now={now} skills={skills} contacts={contacts} />

          {documents.length > 0 && <Documents files={documents} />}

          {contacts && active && (
            <section className="mx-4 mt-3 grid grid-cols-3 gap-2 lg:hidden">
              {[call, routeAct, write].map((a) => a && <SquareAct key={a.key} act={a} tall />)}
            </section>
          )}

          {mineMode && <Notes notes={notes} now={now} onWrite={() => setSheet("message")} />}
        </div>

        {/* Правая колонка (компьютер): выплата, шаги, главная кнопка и все действия списком. */}
        <aside className="card sticky top-24 hidden p-5 lg:block">
          <div className={cn("text-[13.5px]", MUTED)}>Вы получите</div>
          <div className="text-[30px] font-bold text-ink tabular-nums">{money(o.payout)}</div>
          {steps && (
            <div className="mt-3">
              <StatusStepper steps={steps} />
              {sv.hint && <p className="mt-2.5 text-[14.5px] text-ink-2">{sv.hint}</p>}
            </div>
          )}
          <div className="mt-4 flex flex-col gap-2">
            {primaryButton}
            {!primary && note && <p className="text-[15px] text-ink-2">{note}</p>}
            {!mineMode && !available && <p className={cn("text-[14px]", MUTED)}>Сначала включите приём заказов — переключатель вверху экрана.</p>}
            {!mineMode && available && limited && <p className={cn("text-[14px]", MUTED)}>У вас лимит заказов в работе — сначала сдайте текущий.</p>}
            {desktopActs.map((a) =>
              a.href ? (
                <WLinkButton key={a.key} href={a.href} icon={a.icon} full {...(a.key === "route" ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                  {a.long}
                </WLinkButton>
              ) : (
                <WButton key={a.key} variant="secondary" icon={a.icon} full onClick={a.onClick} className={a.danger ? "text-[#c41d3a]" : undefined}>
                  {a.long}
                </WButton>
              ),
            )}
          </div>
        </aside>
      </div>

      {/* Нижняя панель действий (телефон). */}
      <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-white px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:hidden">
        {!mineMode && !available && <p className={cn("mb-2 text-center text-[14px]", MUTED)}>Сначала включите приём заказов</p>}
        {!mineMode && available && limited && <p className={cn("mb-2 text-center text-[14px]", MUTED)}>Лимит заказов — сначала сдайте текущий</p>}
        <div className="flex items-stretch gap-2">
          {acts.map((a) => (
            <SquareAct key={a.key} act={a} />
          ))}
          <div className="flex min-w-0 flex-1 items-center">{primaryButton ?? <p className="w-full text-[15px] leading-snug text-ink-2">{note}</p>}</div>
        </div>
      </div>

      {route.sheet}
      {sheet === "take" && <TakeSheet order={o} gone={mode !== "feed"} available={available} limited={limited} onClose={() => setSheet(null)} onTaken={() => setSheet(null)} />}
      {sheet === "decline" && <DeclineSheet order={o} onClose={() => setSheet(null)} onDeclined={onDeclined} />}
      {sheet === "pause" && <PauseSheet order={o} onClose={() => setSheet(null)} />}
      {sheet === "done" && <DoneSheet order={o} onClose={() => setSheet(null)} />}
      {sheet === "message" && <MessageSheet order={o} onClose={() => setSheet(null)} />}
      {sheet === "more" && (
        <Sheet open onClose={() => setSheet(null)} title={`Заказ №${o.number}`}>
          <div className="-mx-2 flex flex-col">
            {mineMode && (o.status === "assigned" || o.status === "accepted") && <MenuRow icon={Undo2} danger label="Отказаться от заказа" onClick={() => setSheet("decline")} />}
            {contacts && o.address && <MenuRow icon={Copy} label="Скопировать адрес" onClick={() => void copyAddress(o.city, o.address!).then(() => setSheet(null))} />}
            {mineMode && <MenuRow icon={MessageCircle} label="Написать оператору" onClick={() => setSheet("message")} />}
            <MenuRow icon={Headset} label="Позвонить в офис" hint={SUPPORT_PHONE} href={SUPPORT_TEL} />
            {!mineMode && <MenuRow icon={ArrowLeft} label="Все заказы" onClick={() => nav("/w")} />}
          </div>
        </Sheet>
      )}
    </div>
  );
}

/**
 * Квадратная вторичная кнопка панели: иконка + короткая подпись. Диктору — полная подпись, но видимое
 * слово («Звонок») остаётся в имени кнопки: голосовое управление находит кнопку по тому, что на ней написано.
 */
function SquareAct({ act, tall }: { act: Act; tall?: boolean }) {
  const cls = cn(
    "inline-flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-[12px] border border-[#cfc9bc] bg-white px-0.5 text-center text-[11.5px] leading-[13px] font-semibold active:bg-[#f4f2ec]",
    tall ? "min-h-14 w-full" : "min-h-14 w-16",
    act.danger ? "text-[#c41d3a]" : "text-ink",
  );
  const inner = (
    <>
      <act.icon size={22} strokeWidth={1.9} aria-hidden />
      {act.short}
      {act.long !== act.short && <span className="sr-only"> — {act.long}</span>}
    </>
  );
  if (act.href)
    return (
      <a href={act.href} className={cls} {...(act.key === "route" ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {inner}
      </a>
    );
  return (
    <button type="button" onClick={act.onClick} className={cls}>
      {inner}
    </button>
  );
}

function MenuRow({ icon: Icon, label, hint, onClick, href, danger }: { icon: LucideIcon; label: string; hint?: string; onClick?: () => void; href?: string; danger?: boolean }) {
  const cls = cn("flex min-h-14 w-full items-center gap-3 rounded-[12px] px-2 text-left text-[16px] font-medium active:bg-[#f4f2ec]", danger ? "text-[#c41d3a]" : "text-ink");
  const inner = (
    <>
      <Icon size={22} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">
        {label}
        {hint && <span className={cn("block text-[13.5px] font-normal", MUTED)}>{hint}</span>}
      </span>
    </>
  );
  return href ? (
    <a href={href} className={cls}>
      {inner}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {inner}
    </button>
  );
}

interface StateBannerProps {
  order: WorkerOrder;
  mode: Mode;
  now: number;
  overdue: boolean;
  /** Оператор поменял выплату, срок или адрес с прошлого просмотра. */
  change: OrderChange | null;
  onAck: () => void;
  onWrite: () => void;
}

const CHANGE_ICON: Record<OrderChange["kind"], LucideIcon> = { payout: Wallet, deadline: Clock, address: MapPin };

function changeText(c: OrderChange, now: number): string {
  if (c.kind === "payout") return `Оплата изменилась: было ${money(c.before)}, стало ${money(c.after)}`;
  if (c.kind === "deadline") return `Срок изменён: ${dueLabel(c.after, now)}`;
  return "Адрес изменён — проверьте его ниже";
}

/** Плашка состояния под шапкой (одна за раз): отмена, возврат, просрочка, изменения оператора. */
function StateBanner({ order: o, mode, now, overdue, change, onAck, onWrite }: StateBannerProps) {
  if (mode !== "mine") return null;
  if (o.status === "cancelled") {
    const reason = o.cancelReason && o.cancelReason !== "Без причины" ? o.cancelReason : null;
    return (
      <Banner tone="slate" icon={CircleX}>
        {reason ? `Заказ отменён: ${reason.charAt(0).toLowerCase()}${reason.slice(1)}` : "Заказ отменён оператором"}
      </Banner>
    );
  }
  if (o.status === "refund")
    return (
      <Banner tone="bad" icon={Ban} action={{ label: "Написать", onClick: onWrite }}>
        По заказу оформлен возврат. Вопросы — оператору
      </Banner>
    );
  if (overdue)
    return (
      <Banner tone="bad" icon={TriangleAlert} action={{ label: "Написать", onClick: onWrite }}>
        Срок прошёл {durationLabel(now - Date.parse(o.deadline))} назад. Напишите оператору, если задерживаетесь
      </Banner>
    );
  if (change)
    return (
      <Banner tone="warn" icon={CHANGE_ICON[change.kind]} action={{ label: "Понятно", onClick: onAck }}>
        {changeText(change, now)}
      </Banner>
    );
  return null;
}

const BANNER_TONE = { slate: "bg-slate-bg text-[#4f4b44]", bad: "bg-bad-bg text-[#c41d3a]", warn: "bg-warn-bg text-[#9a5b00]" } as const;

function Banner({ tone, icon: Icon, children, action }: { tone: keyof typeof BANNER_TONE; icon: LucideIcon; children: ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div role="status" className={cn("flex items-center gap-3 px-4 py-2.5 text-[15px] font-medium lg:mb-4 lg:rounded-[14px]", BANNER_TONE[tone])}>
      <Icon size={20} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{children}</span>
      {action && (
        <button type="button" onClick={action.onClick} className="inline-flex min-h-12 shrink-0 items-center rounded-[10px] px-2 font-semibold underline underline-offset-2">
          {action.label}
        </button>
      )}
    </div>
  );
}

/** Строки «Срок», «Адрес», «Клиент», «Что сделать», «Нужные навыки», «Номер заказа». */
function InfoRows({ order: o, mode, now, skills, contacts }: { order: WorkerOrder; mode: Mode; now: number; skills: string[]; contacts: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const long = o.description.length > 320 || o.description.split("\n").length > 8;
  const locked = (text: string) => (
    <span className={cn("mt-0.5 flex items-start gap-1.5 text-[14.5px]", MUTED)}>
      <Lock size={15} className="mt-[3px] shrink-0" aria-hidden />
      {text}
    </span>
  );
  const finished = mode === "mine" && !isActiveWork(o);
  return (
    <dl className="card mx-4 mt-4 divide-y divide-line px-4 lg:mx-0">
      <Row icon={Clock} label="Срок">
        <DueText deadline={o.deadline} now={now} mode={mode} bare settled={finished} className="text-[16px]" />
      </Row>
      <Row icon={MapPin} label="Адрес">
        {contacts ? (
          <div className="flex items-start gap-2">
            <span className="min-w-0 flex-1 text-[17px] font-semibold whitespace-pre-line text-ink wrap-anywhere">
              {o.city}, {o.address}
            </span>
            <IconBtn icon={Copy} label="Скопировать адрес" onClick={() => void copyAddress(o.city, o.address!)} className="-my-1.5 -mr-2" />
          </div>
        ) : (
          <>
            <span className="text-[16px] text-ink">{o.city}</span>
            {mode === "feed"
              ? locked("Точный адрес откроется, когда заказ станет вашим")
              : contactsLocked(o)
                ? locked("Адрес откроется после подтверждения")
                : finished && locked("Контакты скрыты — заказ завершён. Связаться с клиентом можно через оператора")}
          </>
        )}
      </Row>
      <Row icon={UserRound} label="Клиент">
        {contacts && o.clientName ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate text-[16px] font-semibold text-ink">{clientShortName(o.clientName)}</span>
            {o.clientPhone && (
              <WLinkButton href={telHref(o.clientPhone)} icon={Phone} aria-label={`Позвонить клиенту ${phone(o.clientPhone)}`}>
                {phone(o.clientPhone)}
              </WLinkButton>
            )}
          </div>
        ) : mode === "feed" ? (
          locked("Имя и телефон клиента откроются, когда заказ станет вашим")
        ) : contactsLocked(o) ? (
          locked("Телефон клиента откроется после подтверждения")
        ) : (
          locked("Связаться с клиентом можно через оператора")
        )}
      </Row>
      {o.description.trim() && (
        <Row icon={Wrench} label="Что сделать">
          <p className={cn("text-[16px] whitespace-pre-line text-ink wrap-anywhere", long && !expanded && "line-clamp-[8]")}>{o.description}</p>
          {long && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="-ml-2 inline-flex min-h-12 items-center px-2 text-[15px] font-semibold text-[#855600]">
              {expanded ? "Свернуть" : "Показать полностью"}
            </button>
          )}
        </Row>
      )}
      {!!o.requiredSkills?.length && (
        <Row icon={BadgeCheck} label="Нужные навыки">
          <ul className="mt-0.5 flex flex-wrap gap-1.5">
            {o.requiredSkills.map((k) => {
              const own = hasSkill({ skills }, k);
              return (
                <li key={k} className="inline-flex min-h-8 max-w-full items-center gap-1 rounded-[8px] bg-slate-bg px-2.5 text-[14px] text-ink wrap-anywhere">
                  {own && <Check size={14} className="text-[#067a46]" aria-hidden />}
                  {k}
                  {own && <span className="sr-only"> — есть у вас</span>}
                </li>
              );
            })}
          </ul>
        </Row>
      )}
      <Row icon={Info} label="Номер заказа">
        <span className={cn("text-[15px]", MUTED)}>№{o.number}</span>
      </Row>
    </dl>
  );
}

/** Строка списка: в dl — только пары dt/dd (иконка — внутри dt), иначе диктор теряет связь подписи и значения. */
function Row({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="relative min-w-0 py-3 pl-8">
      <dt className={cn("text-[13px]", MUTED)}>
        <Icon size={20} className="absolute top-3.5 left-0 text-ink-2" aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

/** Документы к заказу, которые офис отметил для мастера (схема, ТЗ, гарантийный талон). */
function Documents({ files }: { files: WorkerFile[] }) {
  return (
    <section className="card mx-4 mt-3 p-4 lg:mx-0">
      <h2 className="text-[17px] font-semibold text-ink">Документы</h2>
      <ul className="mt-2 flex flex-col gap-2">
        {files.map((f) => (
          <li key={f.id}>
            {f.url ? (
              <a href={f.url} target="_blank" rel="noopener noreferrer" className="flex min-h-12 items-center gap-2.5 rounded-[12px] border border-[#cfc9bc] px-3 text-[15px] font-medium text-ink active:bg-[#f4f2ec]">
                <FileText size={20} className="shrink-0 text-[#855600]" aria-hidden />
                <span className="min-w-0 truncate">{f.name}</span>
              </a>
            ) : (
              <span className={cn("flex min-h-12 items-center gap-2.5 px-3 text-[15px]", MUTED)}>
                <FileText size={20} className="shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{f.name}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Переписка с офисом по заказу: сообщения мастера и ответы команды. Внутреннюю переписку команды мастер не видит. */
function Notes({ notes, now, onWrite }: { notes: WorkerNote[]; now: number; onWrite: () => void }) {
  return (
    <section className="card mx-4 mt-3 p-4 lg:mx-0">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[17px] font-semibold text-ink">Переписка с офисом</h2>
      </div>
      {notes.length === 0 ? (
        <p className={cn("mt-1 text-[15px]", MUTED)}>Напишите, если что-то пошло не так. Оператор свяжется с вами.</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-2.5">
          {notes.map((n) => (
            <li key={n.id} className={cn("max-w-[92%] rounded-[12px] px-3.5 py-2.5", n.mine ? "self-end bg-brand-soft" : "self-start bg-slate-bg")}>
              <div className="text-[12.5px] font-semibold text-ink-2">{n.mine ? "Вы" : n.author ? `Офис · ${n.author}` : "Офис"}</div>
              {n.text && <p className="text-[15px] whitespace-pre-line text-ink-2 wrap-anywhere">{n.text}</p>}
              {n.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {n.files.map((f) =>
                    f.url ? (
                      <a
                        key={f.id}
                        href={f.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block h-16 w-16 overflow-hidden rounded-[10px]"
                        aria-label={`${f.kind === "image" ? "Открыть фото" : "Открыть файл"} ${f.name}`}
                      >
                        {f.kind === "image" ? (
                          <Photo url={f.url} alt={f.name} className="h-full w-full" />
                        ) : (
                          <span className="flex h-full items-center justify-center bg-white p-1 text-center text-[12px] leading-tight break-all">{f.name}</span>
                        )}
                      </a>
                    ) : null,
                  )}
                </div>
              )}
              <div className={cn("mt-1 text-[12.5px]", MUTED)}>{whenLabel(n.at, now)}</div>
            </li>
          ))}
        </ol>
      )}
      <WButton variant="secondary" icon={MessageCircle} full className="mt-3" onClick={onWrite}>
        Написать оператору
      </WButton>
    </section>
  );
}

function Notice({ icon, title, text, actions, onBack }: { icon: LucideIcon; title: string; text: string; actions: ReactNode; onBack: () => void }) {
  return (
    <div className="mx-auto max-w-[760px]">
      <div className="sticky top-0 z-30 lg:hidden">
        <header className="flex h-14 items-center gap-1 border-b border-line bg-white px-1">
          <IconBtn icon={ArrowLeft} label="Назад" onClick={onBack} />
          <h1 className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink">Заказ</h1>
        </header>
        <OfflineBanner />
      </div>
      <h1 className="sr-only hidden lg:block">Заказ</h1>
      <div className="px-4 pt-4 lg:px-0">
        <Empty icon={icon} title={title} text={text} action={actions} />
        <p className={cn("mt-4 text-center text-[14px]", MUTED)}>
          Вопросы — в офис:{" "}
          <a href={SUPPORT_TEL} className="inline-flex min-h-12 items-center font-semibold whitespace-nowrap text-[#855600] underline underline-offset-2">
            {SUPPORT_PHONE}
          </a>
        </p>
      </div>
    </div>
  );
}

function OrderSkeleton() {
  return (
    <div className="mx-auto max-w-[1120px]" role="status" aria-label="Загружаем заказ">
      <div className="sticky top-0 z-30 flex h-14 items-center border-b border-line bg-white px-4 lg:hidden">
        <Skeleton className="h-5 w-32" />
      </div>
      <Skeleton className="aspect-[4/3] w-full rounded-none lg:max-w-[700px] lg:rounded-[16px]" />
      <div className="space-y-3 px-4 pt-4 lg:px-0">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-40 w-full rounded-[16px]" />
      </div>
      <div className="fixed inset-x-0 bottom-0 border-t border-line bg-white px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] lg:hidden">
        <Skeleton className="h-14 w-full rounded-[12px]" />
      </div>
    </div>
  );
}
