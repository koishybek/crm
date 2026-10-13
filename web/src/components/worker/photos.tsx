// Фото к сообщению оператору и к сдаче работы: камера или галерея, сжатие, загрузка сразу после выбора
// (пока мастер пишет комментарий), видимое состояние каждого фото и «Повторить» при сбое.
import { Camera, CircleAlert, Images, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { toast } from "../../data/store";
import { uploadPhoto, type Uploaded } from "../../data/workerActions";
import { cn } from "../../lib/format";
import { Spinner, WButton } from "./kit";

/** Больше фото оператору не нужно, а мобильный трафик мастера дорог. */
export const MAX_PHOTOS = 6;

interface Shot {
  key: string;
  file: File;
  preview: string;
  state: "uploading" | "done" | "error";
  error?: string;
  uploaded?: Uploaded;
}

let seq = 0;

export function usePhotoQueue(max = MAX_PHOTOS) {
  const [shots, setShots] = useState<Shot[]>([]);
  const alive = useRef(true);
  const urls = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    const created = urls.current;
    return () => {
      alive.current = false;
      created.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  const patch = (key: string, p: Partial<Shot>) => {
    if (alive.current) setShots((xs) => xs.map((s) => (s.key === key ? { ...s, ...p } : s)));
  };

  const upload = async (key: string, file: File) => {
    patch(key, { state: "uploading", error: undefined });
    const r = await uploadPhoto(file);
    if (r.ok) patch(key, { state: "done", uploaded: r.value });
    else patch(key, { state: "error", error: r.error });
  };

  const add = (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif|jpe?g|png|webp)$/i.test(f.name));
    if (images.length < files.length) toast("Можно прикладывать только фото", "info");
    const room = max - shots.length;
    if (images.length > room) toast(`Можно приложить до ${max} фото`, "info");
    const next = images.slice(0, Math.max(0, room)).map((file): Shot => {
      const preview = URL.createObjectURL(file);
      urls.current.add(preview);
      return { key: `p${++seq}`, file, preview, state: "uploading" };
    });
    if (!next.length) return;
    setShots((xs) => [...xs, ...next]);
    for (const s of next) void upload(s.key, s.file);
  };

  const remove = (key: string) => {
    setShots((xs) => {
      const s = xs.find((x) => x.key === key);
      if (s) {
        URL.revokeObjectURL(s.preview);
        urls.current.delete(s.preview);
      }
      return xs.filter((x) => x.key !== key);
    });
  };

  const retry = (key: string) => {
    const s = shots.find((x) => x.key === key);
    if (s) void upload(s.key, s.file);
  };

  const clear = () => {
    shots.forEach((s) => {
      URL.revokeObjectURL(s.preview);
      urls.current.delete(s.preview);
    });
    setShots([]);
  };

  return {
    shots,
    add,
    remove,
    retry,
    clear,
    uploading: shots.some((s) => s.state === "uploading"),
    failed: shots.filter((s) => s.state === "error").length,
    uploaded: shots.flatMap((s) => (s.uploaded ? [s.uploaded] : [])),
  };
}

export type PhotoQueue = ReturnType<typeof usePhotoQueue>;

/** Кнопки «Снять фото» и «Из галереи» + превью 88×88 с состоянием загрузки. */
export function PhotoPicker({ queue, disabled }: { queue: PhotoQueue; disabled?: boolean }) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const full = queue.shots.length >= MAX_PHOTOS;
  const pick = (input: HTMLInputElement | null) => {
    if (full) return toast(`Можно приложить до ${MAX_PHOTOS} фото`, "info");
    input?.click();
  };
  const onFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    queue.add(files);
  };

  return (
    <div>
      <div className="grid grid-cols-2 gap-2">
        <WButton variant="secondary" icon={Camera} disabled={disabled} onClick={() => pick(camera.current)}>
          Снять фото
        </WButton>
        <WButton variant="secondary" icon={Images} disabled={disabled} onClick={() => pick(gallery.current)}>
          Из галереи
        </WButton>
      </div>
      {/* В Chrome на Android capture сразу открывает камеру; Safari показывает своё меню выбора. */}
      <input ref={camera} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} tabIndex={-1} aria-hidden />
      <input ref={gallery} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} tabIndex={-1} aria-hidden />
      {queue.shots.length > 0 && (
        <ul className="mt-3 grid grid-cols-[repeat(auto-fill,88px)] gap-2" aria-label="Выбранные фото">
          {queue.shots.map((s, i) => (
            <li key={s.key} className="relative h-[88px] w-[88px] overflow-hidden rounded-[12px] bg-[#efece5]">
              <img src={s.preview} alt={`Фото ${i + 1}`} className="h-full w-full object-cover" />
              {s.state === "uploading" && (
                <span className="absolute inset-0 flex items-center justify-center bg-white/60 text-ink" role="status" aria-label={`Фото ${i + 1} загружается`}>
                  <Spinner className="h-6 w-6" />
                </span>
              )}
              {s.state === "error" && (
                <button
                  type="button"
                  onClick={() => queue.retry(s.key)}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-0.5 bg-[#c41d3a]/85 text-[12px] font-semibold text-white"
                  aria-label={`Фото ${i + 1} не загрузилось. Повторить`}
                >
                  <CircleAlert size={18} aria-hidden />
                  Не загрузилось
                  <span className="inline-flex items-center gap-1 underline">
                    <RotateCw size={12} aria-hidden /> Повторить
                  </span>
                </button>
              )}
              <button
                type="button"
                onClick={() => queue.remove(s.key)}
                aria-label={`Убрать фото ${i + 1}`}
                className="absolute top-0 right-0 inline-flex h-12 w-12 items-start justify-end p-1.5"
              >
                <span className={cn("inline-flex h-6 w-6 items-center justify-center rounded-full bg-ink/80 text-white")}>
                  <X size={14} aria-hidden />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
