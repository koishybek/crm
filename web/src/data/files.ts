// Файлы в интерфейсе: свежие подписанные ссылки, проверка загрузки до отправки и «Показать мастеру».
// Ссылки на файлы приходят с сервера подписанными и живут 15 минут (convex/lib/files.ts). Запросы, которые их отдают,
// получают метку «t» — время, округлённое до 5 минут: раз в 5 минут запрос выполняется заново и приносит свежие ссылки.
import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { convex, run, type Result } from "./convex";

/** Раз в 5 минут — с запасом до конца 15-минутных ссылок. */
const REFRESH_MS = 5 * 60_000;
const stampOf = (now: number) => Math.floor(now / REFRESH_MS) * REFRESH_MS;

/** Метка «t» для запросов со ссылками на файлы: меняется раз в 5 минут. */
export function useFileStamp(): number {
  const [stamp, setStamp] = useState(() => stampOf(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setStamp(stampOf(Date.now())), 30_000);
    return () => clearInterval(timer);
  }, []);
  return stamp;
}

type FileQuery = FunctionReference<"query", "public", { t?: number }>;

/**
 * useQuery для запросов со ссылками на файлы: добавляет метку «t». Пока ответ со свежими ссылками в пути, отдаёт прежний —
 * экран не мигает «Загрузкой» раз в 5 минут. Другие аргументы (другой заказ, другой диалог) — честная загрузка.
 */
export function useFileQuery<Q extends FileQuery>(query: Q, args: Omit<FunctionArgs<Q>, "t"> | "skip"): FunctionReturnType<Q> | undefined {
  const t = useFileStamp();
  const rest = [args === "skip" ? "skip" : { ...args, t }] as unknown as OptionalRestArgsOrSkip<Q>;
  const value = useQuery(query, ...rest);
  const key = args === "skip" ? null : JSON.stringify(args);
  const [kept, setKept] = useState<{ key: string; value: FunctionReturnType<Q> } | null>(null);
  useEffect(() => {
    if (value !== undefined && key !== null) setKept({ key, value });
  }, [key, value]);
  if (value !== undefined) return value;
  return kept && kept.key === key ? kept.value : undefined;
}

/** Ссылка без подписи и срока — сам файл: /files/<storageId>. */
const fileOf = (url: string) => url.split("?", 1)[0]!;

/**
 * Ссылка для <img>/<audio>/<video>: держим ту, с которой элемент начал, — фото не перезагружается, а запись не сбрасывается
 * каждые 5 минут. Ошибка загрузки (ссылка истекла) — берём свежую из последнего ответа сервера; свежей ещё нет —
 * broken, пока она не придёт. Другой файл — сразу его ссылка.
 */
export function useLatchedSrc(url: string | undefined): { src: string | undefined; broken: boolean; onError: () => void } {
  const [state, setState] = useState<{ held?: string; failed?: string }>({ held: url });
  useEffect(() => {
    setState((s) => {
      if (!url) return s.held === undefined && s.failed === undefined ? s : {};
      if (!s.held || fileOf(s.held) !== fileOf(url)) return { held: url };
      return s.failed && s.failed !== url ? { held: url } : s;
    });
  }, [url]);
  const src = url && state.held && fileOf(state.held) === fileOf(url) ? state.held : url;
  return {
    src,
    broken: !!src && state.failed === src,
    onError: () => setState(url && url !== src ? { held: url } : { held: src, failed: src }),
  };
}

// ── Загрузка ─────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
type Kind = "image" | "video" | "audio" | "file";
/** Те же потолки, что на сервере (convex/lib/files.ts): сервер всё равно проверит, здесь — чтобы не грузить зря. */
const LIMIT_MB: Record<Kind, number> = { image: 15, video: 100, audio: 25, file: 25 };
const KIND_LABEL: Record<Kind, string> = { image: "фото", video: "видео", audio: "аудиозапись", file: "документ" };

/** Тип по расширению — когда браузер его не знает (часто у .amr, .opus, .heic): сервер принимает файл по типу. */
const EXT_TYPE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  "3gp": "video/3gpp",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  flac: "audio/flac",
  amr: "audio/amr",
  wma: "audio/x-ms-wma",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  txt: "text/plain",
};

export const mimeOf = (file: File): string => file.type || EXT_TYPE[file.name.split(".").pop()?.toLowerCase() ?? ""] || "application/octet-stream";

const kindOf = (type: string): Kind => (type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : type.startsWith("audio/") ? "audio" : "file");

/** Слишком большой файл — текст ошибки; подходит — null. */
export function uploadLimitError(file: File, type: string): string | null {
  const kind = kindOf(type);
  return file.size > LIMIT_MB[kind] * MB ? `«${file.name}» слишком большой: ${KIND_LABEL[kind]} — до ${LIMIT_MB[kind]} МБ` : null;
}

/** Подтвердить загрузку на сервере: он сверит тип и размер и закрепит файл за пользователем. */
export async function confirmUpload(storageId: Id<"_storage">): Promise<Result<Kind>> {
  const r = await run(convex.mutation(api.files.confirmUpload, { storageId }));
  if (!r.ok) return r;
  return r.value.ok ? { ok: true, value: r.value.kind } : { ok: false, error: r.value.error };
}

// ── «Показать мастеру» ───────────────────────────────────────────────────────

export const setFileForExecutor = (orderId: string, fileId: string, forExecutor: boolean) =>
  run(convex.mutation(api.orders.setFileForExecutor, { orderId: orderId as Id<"orders">, fileId, forExecutor }));
