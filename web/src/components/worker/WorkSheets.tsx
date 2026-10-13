// Шторки по своему заказу: отказ с причиной, пауза, сдача работы с фото и сообщение оператору.
// Тексты ошибок — человеческие: «Статус заказа уже изменился» вместо технических кодов.
import { useState } from "react";
import { toast } from "../../data/store";
import type { OrderStatus, WorkerOrder } from "../../data/types";
import { completeOrder, declineOrder, messageOperator, pauseOrder, sendReport } from "../../data/workerActions";
import { refusalOf } from "../../data/workerStatus";
import { cn, money } from "../../lib/format";
import { MUTED, WButton, busyLabel, useBusy } from "./kit";
import { useNet } from "./net";
import { PhotoPicker, usePhotoQueue } from "./photos";
import { Sheet } from "./Sheet";

type SheetOrder = Pick<WorkerOrder, "id" | "number" | "status" | "payout">;

// Подсказка в пустом поле — тем же цветом, что и прочий вторичный текст (5,6:1): на солнце бледная не читается.
const FIELD = "w-full rounded-[12px] border border-[#cfc9bc] bg-white px-3.5 py-3 text-[16px] text-ink placeholder:text-[#6b675f] focus:border-[#e9b400] focus:shadow-[0_0_0_3px_rgb(255_198_41/0.28)] focus:outline-none";

/** Ответ сервера «статус уже изменился / заказ не ваш» — закрываем шторку и говорим об этом. */
function staleRefusal(error: string): boolean {
  const kind = refusalOf(error);
  return kind === "changed" || kind === "not_yours";
}

function ErrorLine({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="text-center text-[14px] font-medium text-[#c41d3a]">
      {text}
    </p>
  ) : null;
}

const NETWORK_ERROR = "Не получилось отправить. Проверьте интернет и попробуйте ещё раз.";

// ── Отказ ────────────────────────────────────────────────────────────────────

const DECLINE_REASONS = ["Не успеваю к этому времени", "Слишком далеко", "Не мой профиль работ", "Нет нужных запчастей или инструмента", "Заболел или форс-мажор"];
const CLIENT_SILENT = "Клиент не отвечает";
const OTHER = "Другая причина";

export function DeclineSheet({ order, onClose, onDeclined }: { order: SheetOrder; onClose: () => void; onDeclined: () => void }) {
  const offline = useNet((s) => s.offline);
  const { busy, slow, run } = useBusy();
  const [reason, setReason] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reasons = [...DECLINE_REASONS, ...(order.status === "accepted" ? [CLIENT_SILENT] : []), OTHER];

  const submit = () =>
    run(async () => {
      if (!reason) return setError("Выберите причину");
      const text = reason === OTHER ? other.trim() : reason;
      if (reason === OTHER && text.length < 3) return setError("Напишите причину — хотя бы 3 буквы");
      setError(null);
      const r = await declineOrder(order.id, text);
      if (r.ok) {
        toast(`Вы отказались от заказа №${order.number}`, "info");
        return onDeclined();
      }
      if (staleRefusal(r.error)) {
        toast("Статус заказа уже изменился — экран обновлён", "info");
        return onClose();
      }
      setError(NETWORK_ERROR);
    });

  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy}
      title={`Отказаться от заказа №${order.number}?`}
      footer={
        <>
          <WButton variant="ghost" full onClick={onClose} disabled={busy}>
            Не отказываться
          </WButton>
          <WButton variant="danger" size="lg" full busy={busy} busyText={busyLabel(slow, "Отправляем…")} disabled={offline} onClick={() => void submit()}>
            {offline ? "Нет связи" : "Отказаться"}
          </WButton>
          <ErrorLine text={error} />
        </>
      }
    >
      <p className="text-[15.5px] text-ink-2">Заказ вернётся в ленту, его возьмёт другой мастер. Оператор увидит причину.</p>
      <fieldset className="mt-4">
        <legend className="mb-2 text-[15px] font-semibold text-ink">Причина</legend>
        <div className="flex flex-col gap-2" role="radiogroup">
          {reasons.map((r) => (
            <label key={r} className={cn("flex min-h-[52px] cursor-pointer items-center gap-3 rounded-[12px] border px-3.5 py-2 text-[15.5px]", reason === r ? "border-ink bg-[#faf8f3] font-semibold" : "border-[#cfc9bc]")}>
              <input type="radio" name="decline-reason" className="h-5 w-5 shrink-0 accent-[#141414]" checked={reason === r} onChange={() => (setReason(r), setError(null))} />
              {r}
            </label>
          ))}
        </div>
      </fieldset>
      {reason === OTHER && (
        <textarea
          className={cn(FIELD, "mt-3 min-h-24 resize-none")}
          maxLength={200}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder="Коротко напишите причину"
          aria-label="Другая причина"
        />
      )}
    </Sheet>
  );
}

// ── Пауза ────────────────────────────────────────────────────────────────────

const PAUSE_REASONS = ["Жду клиента", "Жду запчасть", "Другое"];

export function PauseSheet({ order, onClose }: { order: SheetOrder; onClose: () => void }) {
  const offline = useNet((s) => s.offline);
  const { busy, slow, run } = useBusy();
  const [reason, setReason] = useState<string>(PAUSE_REASONS[0]!);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    run(async () => {
      setError(null);
      const text = [reason, comment.trim()].filter(Boolean).join(": ");
      const r = await pauseOrder(order.id, text);
      if (r.ok) {
        toast("Заказ на паузе", "info");
        return onClose();
      }
      if (staleRefusal(r.error)) {
        toast("Статус заказа уже изменился — экран обновлён", "info");
        return onClose();
      }
      setError(NETWORK_ERROR);
    });

  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy}
      title="Поставить на паузу?"
      footer={
        <>
          <WButton variant="ghost" full onClick={onClose} disabled={busy}>
            Отмена
          </WButton>
          <WButton size="lg" full busy={busy} busyText={busyLabel(slow, "Отправляем…")} disabled={offline} onClick={() => void submit()}>
            {offline ? "Нет связи" : "Поставить на паузу"}
          </WButton>
          <ErrorLine text={error} />
        </>
      }
    >
      <p className="text-[15.5px] text-ink-2">Оператор увидит, почему работа стоит. Снять паузу можно в любой момент.</p>
      <div className="mt-4 flex flex-wrap gap-2">
        {PAUSE_REASONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => setReason(r)}
            className={cn("min-h-12 rounded-full border px-4 text-[15px] font-medium", reason === r ? "border-ink bg-ink text-white" : "border-[#cfc9bc] bg-white text-ink")}
          >
            {r}
          </button>
        ))}
      </div>
      <textarea
        className={cn(FIELD, "mt-3 min-h-20 resize-none")}
        maxLength={200}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Комментарий для оператора (необязательно)"
        aria-label="Комментарий для оператора"
      />
    </Sheet>
  );
}

// ── Сдать работу ─────────────────────────────────────────────────────────────

const ENDED: readonly OrderStatus[] = ["cancelled", "refund"];

export function DoneSheet({ order, onClose }: { order: SheetOrder; onClose: () => void }) {
  const offline = useNet((s) => s.offline);
  const { busy, slow, run } = useBusy();
  const photos = usePhotoQueue();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"ask" | "stale" | "report_failed">("ask");

  // Заказ отменили, пока шторка открыта, — сдавать нечего, фото не отправляем.
  const cancelled = ENDED.includes(order.status) && !busy;

  const submit = () =>
    run(async () => {
      if (photos.failed) return setError("Не все фото загрузились — нажмите «Повторить» на фото или уберите его");
      setError(null);
      const r = await completeOrder(order.id, comment, photos.uploaded);
      if (r.ok) {
        toast(`Работа сдана. ${money(order.payout)} — после оплаты клиентом`);
        return onClose();
      }
      if (r.stage === "report") return setPhase("report_failed");
      if (staleRefusal(r.error)) return setPhase("stale");
      setError(NETWORK_ERROR);
    });

  const resend = () =>
    run(async () => {
      const r = await sendReport(order.id, comment, photos.uploaded);
      if (r.ok) {
        toast("Фото и комментарий отправлены оператору");
        return onClose();
      }
      setError(NETWORK_ERROR);
    });

  if (cancelled || phase === "stale")
    return (
      <Sheet
        open
        onClose={onClose}
        title={cancelled ? "Заказ отменён" : "Статус заказа изменился"}
        footer={
          <WButton size="lg" full onClick={onClose}>
            Понятно
          </WButton>
        }
      >
        <p className="text-[16px] text-ink-2">{cancelled ? "Заказ отменён — сдавать работу не нужно." : "Статус заказа уже изменился — экран обновлён. Если что-то не так, напишите оператору."}</p>
      </Sheet>
    );

  if (phase === "report_failed")
    return (
      <Sheet
        open
        onClose={onClose}
        locked={busy}
        title="Работа сдана"
        footer={
          <>
            <WButton variant="ghost" full onClick={onClose} disabled={busy}>
              Закрыть
            </WButton>
            <WButton size="lg" full busy={busy} busyText={busyLabel(slow, "Отправляем…")} disabled={offline} onClick={() => void resend()}>
              {offline ? "Нет связи" : "Отправить фото ещё раз"}
            </WButton>
            <ErrorLine text={error} />
          </>
        }
      >
        <p className="text-[16px] text-ink-2">Статус «Сдан» сохранён, но фото и комментарий не дошли до оператора. Отправьте их ещё раз.</p>
      </Sheet>
    );

  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy}
      title="Работа выполнена?"
      footer={
        <>
          <WButton variant="ghost" full onClick={onClose} disabled={busy}>
            Ещё не закончил
          </WButton>
          <WButton size="lg" full busy={busy || photos.uploading} busyText={photos.uploading ? "Загружаем фото…" : busyLabel(slow, "Сдаём работу…")} disabled={offline} onClick={() => void submit()}>
            {offline ? "Нет связи" : "Сдать работу"}
          </WButton>
          <ErrorLine text={error} />
        </>
      }
    >
      <p className="text-[15.5px] text-ink-2">Приложите фото результата — оператору так проще закрыть заказ. Можно без фото.</p>
      <div className="mt-4">
        <PhotoPicker queue={photos} disabled={busy} />
      </div>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-[15px] font-semibold text-ink">Комментарий для оператора</span>
        <textarea
          className={cn(FIELD, "min-h-24 resize-none")}
          maxLength={1000}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Что сделали, что заменили, есть ли гарантия"
        />
      </label>
    </Sheet>
  );
}

// ── Сообщение оператору ──────────────────────────────────────────────────────

const QUICK_REPLIES = ["Буду через 15 минут", "Задерживаюсь", "Клиент не отвечает", "Нужна запчасть"];

export function MessageSheet({ order, onClose }: { order: SheetOrder; onClose: () => void }) {
  const offline = useNet((s) => s.offline);
  const { busy, slow, run } = useBusy();
  const photos = usePhotoQueue();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    run(async () => {
      if (!text.trim() && !photos.shots.length) return setError("Напишите сообщение или приложите фото");
      if (photos.failed) return setError("Не все фото загрузились — нажмите «Повторить» на фото или уберите его");
      setError(null);
      const r = await messageOperator(order.id, text, photos.uploaded);
      if (r.ok) {
        toast("Сообщение отправлено оператору");
        return onClose();
      }
      if (refusalOf(r.error) === "not_yours") {
        toast("Заказ больше не ваш — написать по нему нельзя", "info");
        return onClose();
      }
      setError("Сообщение не отправилось. Проверьте интернет и попробуйте ещё раз.");
    });

  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy}
      title="Написать оператору"
      footer={
        <>
          <WButton variant="ghost" full onClick={onClose} disabled={busy}>
            Отмена
          </WButton>
          <WButton size="lg" full busy={busy || photos.uploading} busyText={photos.uploading ? "Загружаем фото…" : busyLabel(slow, "Отправляем…")} disabled={offline} onClick={() => void submit()}>
            {offline ? "Нет связи" : "Отправить"}
          </WButton>
          <ErrorLine text={error} />
        </>
      }
    >
      <p className={cn("text-[14.5px]", MUTED)}>Заказ №{order.number}. Оператор увидит сообщение в карточке заказа и свяжется с вами.</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {QUICK_REPLIES.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setText((t) => (t.trim() ? `${t.trim()} ${q}` : q))}
            className="min-h-12 rounded-full border border-[#cfc9bc] bg-white px-4 text-[15px] font-medium text-ink active:bg-[#f4f2ec]"
          >
            {q}
          </button>
        ))}
      </div>
      <textarea
        className={cn(FIELD, "mt-3 min-h-28 resize-none")}
        maxLength={1000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Сообщение оператору…"
        aria-label="Сообщение оператору"
      />
      <div className="mt-3">
        <PhotoPicker queue={photos} disabled={busy} />
      </div>
    </Sheet>
  );
}
