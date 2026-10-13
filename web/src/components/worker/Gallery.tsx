// Галерея фото заказа: листается пальцем (scroll-snap), счётчик «1/3», тап — просмотр на весь экран.
// В просмотре есть «Открыть оригинал»: там работает родное увеличение браузера.
import { ExternalLink, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { WorkerPhoto } from "../../data/workerTypes";
import { SignedImg } from "../SignedMedia";
import { IconBtn } from "./kit";
import { Photo } from "./parts";

function useIndex(ref: RefObject<HTMLDivElement | null>, count: number): number {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => setIndex(Math.min(count - 1, Math.max(0, Math.round(el.scrollLeft / Math.max(1, el.clientWidth)))));
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [ref, count]);
  return index;
}

export function Gallery({ photos }: { photos: WorkerPhoto[] }) {
  const strip = useRef<HTMLDivElement>(null);
  const index = useIndex(strip, photos.length);
  const [viewer, setViewer] = useState<number | null>(null);
  if (!photos.length) return null;
  return (
    <div className="relative overflow-hidden bg-[#efece5] lg:rounded-[16px]">
      <div ref={strip} className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Фото заказа">
        {photos.map((p, i) => (
          <button key={p.id} type="button" onClick={() => setViewer(i)} className="aspect-[4/3] w-full shrink-0 snap-center" aria-label={`Открыть фото ${i + 1} из ${photos.length}`}>
            <Photo url={p.url} alt={`Фото ${i + 1} из ${photos.length}`} className="h-full w-full" />
          </button>
        ))}
      </div>
      {photos.length > 1 && (
        <span className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-ink/70 px-2.5 py-1 text-[13px] font-semibold text-white tabular-nums" aria-hidden>
          {index + 1}/{photos.length}
        </span>
      )}
      {viewer !== null && <Viewer photos={photos} start={viewer} onClose={() => setViewer(null)} />}
    </div>
  );
}

function Viewer({ photos, start, onClose }: { photos: WorkerPhoto[]; start: number; onClose: () => void }) {
  const strip = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const index = useIndex(strip, photos.length);
  // Живые обновления экрана заказа не должны сбрасывать листание — колбэк держим в ref.
  const close = useRef(onClose);
  useLayoutEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    strip.current?.scrollTo({ left: start * strip.current.clientWidth });
    dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [start]);

  const current = photos[index] ?? photos[0]!;
  return createPortal(
    <div ref={dialog} role="dialog" aria-modal="true" aria-label="Фото заказа" className="fixed inset-0 z-[70] flex flex-col bg-black">
      <div className="flex items-center justify-between gap-2 px-2 pt-[max(8px,env(safe-area-inset-top))]">
        <span className="px-3 text-[15px] font-semibold text-white tabular-nums">
          {index + 1} из {photos.length}
        </span>
        <IconBtn icon={X} label="Закрыть" onClick={onClose} className="text-white hover:bg-white/10 active:bg-white/20" />
      </div>
      <div ref={strip} className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {photos.map((p, i) => (
          <div key={p.id} className="flex h-full w-full shrink-0 snap-center items-center justify-center">
            {/* Оригиналы тяжёлые: соседние фото грузятся, только когда до них долистали. */}
            <SignedImg src={p.url} alt={`Фото ${i + 1} из ${photos.length}`} loading={i === start ? "eager" : "lazy"} decoding="async" className="max-h-full max-w-full object-contain" />
          </div>
        ))}
      </div>
      <div className="flex justify-center px-4 pt-2 pb-[max(16px,env(safe-area-inset-bottom))]">
        <a href={current.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-12 items-center gap-2 rounded-full px-4 text-[15px] font-semibold text-white hover:bg-white/10">
          <ExternalLink size={18} aria-hidden />
          Открыть оригинал
        </a>
      </div>
    </div>,
    document.body,
  );
}
