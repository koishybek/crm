// Фото, звук и видео по подписанным ссылкам (живут 15 минут): элемент держит свою ссылку, пока она работает,
// и сам переходит на свежую, когда старая истекла (src/data/files.ts → useLatchedSrc). Запись продолжается с того же места.
import { useRef, type AudioHTMLAttributes, type ImgHTMLAttributes, type ReactNode, type VideoHTMLAttributes } from "react";
import { useLatchedSrc } from "../data/files";

type ImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "onError"> & {
  src: string | undefined;
  /** Что показать, пока ссылки нет или фото не загрузилось. */
  fallback?: ReactNode;
};

export function SignedImg({ src, fallback = null, alt, ...rest }: ImgProps) {
  const m = useLatchedSrc(src);
  if (!m.src || m.broken) return <>{fallback}</>;
  return <img {...rest} alt={alt} src={m.src} onError={m.onError} />;
}

/** Ссылка истекла посреди прослушивания (перемотка, долгая пауза) — свежая ссылка и то же место записи. */
function useResumable<T extends HTMLMediaElement>(src: string | undefined) {
  const ref = useRef<T>(null);
  const playing = useRef(false);
  const resume = useRef<number | null>(null);
  const m = useLatchedSrc(src);
  return {
    ref,
    src: m.broken ? undefined : m.src,
    onPlay: () => void (playing.current = true),
    onPause: () => void (playing.current = false),
    onError: () => {
      const el = ref.current;
      resume.current = el && el.currentTime > 0 ? el.currentTime : null;
      m.onError();
    },
    onLoadedMetadata: () => {
      const el = ref.current;
      const at = resume.current;
      if (!el || at === null) return;
      resume.current = null;
      el.currentTime = at;
      if (playing.current) void el.play().catch(() => undefined);
    },
  };
}

type MediaProps<T> = Omit<T, "src" | "onError" | "onLoadedMetadata" | "onPlay" | "onPause"> & { src: string | undefined };

export function SignedAudio({ src, children, ...rest }: MediaProps<AudioHTMLAttributes<HTMLAudioElement>>) {
  const p = useResumable<HTMLAudioElement>(src);
  return (
    <audio {...rest} ref={p.ref} src={p.src} onError={p.onError} onLoadedMetadata={p.onLoadedMetadata} onPlay={p.onPlay} onPause={p.onPause}>
      {children}
    </audio>
  );
}

export function SignedVideo({ src, children, ...rest }: MediaProps<VideoHTMLAttributes<HTMLVideoElement>>) {
  const p = useResumable<HTMLVideoElement>(src);
  return (
    <video {...rest} ref={p.ref} src={p.src} onError={p.onError} onLoadedMetadata={p.onLoadedMetadata} onPlay={p.onPlay} onPause={p.onPause}>
      {children}
    </video>
  );
}
