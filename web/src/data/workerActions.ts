// Действия мастера, собранные из существующих функций сервера (worker.take / worker.act / worker.setAvailable,
// orders.addMessage, uploadFile). Причину отказа и фотоотчёт сервер пока не принимает в одной мутации,
// поэтому порядок шагов выбран так, чтобы при сбое посередине не было вреда (см. комментарии у функций).
// Мастер пишет только в переписку «С мастером» (канал executor): внутренние заметки команды ему недоступны.
import type { Id } from "../../convex/_generated/dataModel";
import type { Result } from "./convex";
import { addMessage, executorAction, setMyAvailability, takeOrder, telegramLink, uploadFile } from "./store";
import type { Attachment } from "./types";

export type Uploaded = Attachment & { storageId: Id<"_storage"> };

/** Взять заказ; при выключенном приёме — сначала включить его. */
export async function takeWithShift(id: string, enableShift: boolean): Promise<Result<{ number: number }>> {
  if (enableShift) {
    const on = await setMyAvailability(true);
    if (!on.ok) return on;
  }
  return takeOrder(id);
}

/**
 * Отказ с причиной. Сначала причина оператору (после отказа заказ уже не наш и написать в него нельзя),
 * потом сам отказ. Не дошла причина — отказа не делаем.
 */
export async function declineOrder(id: string, reason: string): Promise<Result<null>> {
  const note = await addMessage(id, `Отказываюсь от заказа. Причина: ${reason}`, "executor");
  if (!note.ok) return note;
  return executorAction(id, "decline");
}

/** Пауза: причина и комментарий уходят оператору сообщением, затем статус «на паузе». */
export async function pauseOrder(id: string, reason: string): Promise<Result<null>> {
  if (reason) {
    const note = await addMessage(id, `Пауза: ${reason}`, "executor");
    if (!note.ok) return note;
  }
  return executorAction(id, "wait");
}

export type CompleteResult = { ok: true } | { ok: false; stage: "status" | "report"; error: string };

/**
 * Сдать работу. Сначала статус: если заказ успели отменить, фото не отправляем.
 * Статус сменился, а фотоотчёт не дошёл — stage: "report", его можно отправить повторно (sendReport).
 */
export async function completeOrder(id: string, comment: string, photos: Uploaded[]): Promise<CompleteResult> {
  const done = await executorAction(id, "done");
  if (!done.ok) return { ok: false, stage: "status", error: done.error };
  const report = await sendReport(id, comment, photos);
  return report.ok ? { ok: true } : { ok: false, stage: "report", error: report.error };
}

/** Фотоотчёт и комментарий оператору. Нечего отправлять — ничего не шлём. */
export async function sendReport(id: string, comment: string, photos: Uploaded[]): Promise<Result<null>> {
  const text = comment.trim();
  if (!text && !photos.length) return { ok: true, value: null };
  return addMessage(id, text || "Фотоотчёт о выполненной работе", "executor", photos);
}

/** Сообщение оператору по заказу — в переписку «С мастером» (видят команда и этот мастер, клиент — нет). */
export const messageOperator = (id: string, text: string, photos: Uploaded[]) => addMessage(id, text.trim(), "executor", photos);

/**
 * Подключить Telegram: одноразовая ссылка t.me/<бот>?start=<код>. Переходим по ней в этой же вкладке:
 * window.open после await мобильный Safari может счесть всплывающим окном и заблокировать.
 */
export async function connectTelegram(): Promise<Result<void>> {
  const r = await telegramLink();
  if (!r.ok) return r;
  window.location.href = r.value;
  return { ok: true, value: undefined };
}

/** Длинная сторона фото после сжатия — экономим мобильный трафик. */
const MAX_SIDE = 1600;

/**
 * Сжать фото перед загрузкой: длинная сторона до 1600 px, JPEG 80%. Если браузер не умеет открыть файл
 * (например, HEIC на Android) или сжатие не помогло — грузим оригинал, размер проверит uploadFile.
 */
export async function shrinkPhoto(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const g = canvas.getContext("2d");
    if (!g) {
      bitmap.close();
      return file;
    }
    g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.8));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  }
}

/** Сжать и загрузить одно фото. */
export async function uploadPhoto(file: File): Promise<Result<Uploaded>> {
  return uploadFile(await shrinkPhoto(file));
}
