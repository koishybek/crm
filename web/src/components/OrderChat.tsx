import { ImageIcon, Lock, Paperclip, SendHorizontal, FileText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Id } from "../../convex/_generated/dataModel";
import { addMessage, toast, uploadFile } from "../data/store";
import type { Actor, Attachment, Message, User } from "../data/types";
import { cn, shortName, when } from "../lib/format";
import { Avatar, Modal } from "./ui";

export function Thumb({ a, onOpen, size = 96 }: { a: Attachment; onOpen?: (a: Attachment) => void; size?: number }) {
  if (a.kind === "file") {
    const inner = (
      <>
        <FileText size={16} className="shrink-0 text-brand-ink" />
        <span className="truncate">{a.name}</span>
      </>
    );
    const cls = "inline-flex max-w-[200px] items-center gap-2 rounded-[10px] border border-line bg-white px-3 py-2 text-[13px] text-ink-2";
    return a.src ? (
      <a href={a.src} target="_blank" rel="noreferrer" className={cls + " hover:border-brand-line"}>
        {inner}
      </a>
    ) : (
      <span className={cls}>{inner}</span>
    );
  }
  return (
    <button
      type="button"
      onClick={() => onOpen?.(a)}
      title={a.name}
      className="relative overflow-hidden rounded-[10px] border border-line bg-[linear-gradient(135deg,#f1efe9,#dfe7f1)]"
      style={{ width: size, height: Math.round(size * 0.68) }}
    >
      {a.src ? (
        <img src={a.src} alt={a.name} className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
          <ImageIcon size={20} />
          <span className="max-w-full truncate px-1.5 text-[10.5px]">{a.name.replace(/\.\w+$/, "")}</span>
        </span>
      )}
    </button>
  );
}

type Pending = Attachment & { storageId?: Id<"_storage"> };

/**
 * Переписка по заказу. Сообщения приходят с сервера (реактивно), файлы сразу грузятся в хранилище
 * и уходят вместе с сообщением. nameOf — как подписать автора.
 */
export function OrderChat({ orderId, messages, me, nameOf, compact }: { orderId: string; messages: Message[]; me: User; nameOf: (a: Actor) => string; compact?: boolean }) {
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<"client" | "internal">("client");
  const [files, setFiles] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState<Attachment | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Локальные превью выбранных картинок до отправки.
  useEffect(() => () => files.forEach((f) => f.src?.startsWith("blob:") && URL.revokeObjectURL(f.src)), [files]);

  const who = (m: Message) => ({ name: nameOf(m.author) });

  const attach = async (list: File[]) => {
    setUploading((n) => n + list.length);
    for (const file of list) {
      const r = await uploadFile(file);
      setUploading((n) => n - 1);
      if (!r.ok) {
        toast(r.error, "bad");
        continue;
      }
      setFiles((xs) => [...xs, { ...r.value, src: r.value.kind === "image" ? URL.createObjectURL(file) : undefined }]);
    }
  };

  const send = async () => {
    if (uploading) return toast("Дождитесь загрузки файлов", "info");
    setSending(true);
    const r = await addMessage(orderId, text, channel, files.map(({ src: _src, ...f }) => (void _src, f)));
    setSending(false);
    if (!r.ok) return toast(r.error, "bad");
    setText("");
    setFiles([]);
  };

  return (
    <div>
      <div className="flex items-start gap-3">
        {!compact && <Avatar name={me.name} size={42} variant="person" className="mt-0.5 hidden sm:inline-flex" />}
        <div className={cn("min-w-0 flex-1 rounded-[12px] border bg-white transition-colors", channel === "internal" ? "border-[#f5d9a8]" : "border-line-strong")}>
          <div className="flex items-center gap-2 px-2 pt-2">
            {(["client", "internal"] as const).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setChannel(c)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12.5px] font-semibold",
                  channel === c ? (c === "internal" ? "bg-warn-bg text-warn-ink" : "bg-brand-soft text-brand-ink") : "text-muted hover:bg-[#f4f2ec]",
                )}
              >
                {c === "internal" && <Lock size={12} />}
                {c === "client" ? "Переписка с клиентом" : "Внутренний"}
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2 p-2 pl-3">
            <textarea
              value={text}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={channel === "internal" ? "Заметка для команды — клиент её не увидит..." : "Написать комментарий..."}
              aria-label="Сообщение"
              className="max-h-32 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[14.5px] text-ink placeholder:text-faint focus:outline-none"
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,.pdf,.doc,.docx,.xls,.xlsx"
              className="hidden"
              onChange={(e) => {
                const list = [...(e.target.files ?? [])].slice(0, 6);
                e.target.value = "";
                void attach(list);
              }}
            />
            <button type="button" onClick={() => fileRef.current?.click()} aria-label="Прикрепить файл" className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] text-muted hover:bg-[#f4f2ec] hover:text-ink">
              <Paperclip size={19} />
            </button>
            <button type="button" onClick={() => void send()} disabled={sending} aria-label="Отправить" className="inline-flex h-10 w-11 items-center justify-center rounded-[10px] bg-brand text-on-brand hover:bg-brand-hover">
              <SendHorizontal size={19} />
            </button>
          </div>
          {uploading > 0 && <div className="px-3 pb-2 text-[12.5px] text-muted">Загружаем файлы… ({uploading})</div>}
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pb-3">
              {files.map((f) => (
                <span key={f.id} className="relative">
                  <Thumb a={f} size={72} />
                  <button onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label="Убрать файл" className="absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink text-white">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {messages.length === 0 ? (
        <div className="py-8 text-center text-[14px] text-muted">Сообщений пока нет. Здесь будет переписка по заказу и фото.</div>
      ) : (
        <ol className="relative mt-5 space-y-4 pl-6 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-line-strong">
          {messages.map((m, i) => {
            const w = who(m);
            return (
              <li key={m.id} className="relative">
                <span className={cn("absolute top-3 -left-6 h-[11px] w-[11px] rounded-full border-2 border-white", i === 0 ? "bg-[#ffc629]" : "bg-[#d9d4c8]")} />
                <div className="flex items-start gap-3">
                  <Avatar name={w.name} size={40} variant={m.author.type === "client" ? "client" : "person"} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      <span className="text-[14px] font-semibold text-ink">{shortName(w.name)}</span>
                      <span className="text-[12.5px] text-muted">{when(m.at)}</span>
                      {m.channel === "internal" && (
                        <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-warn-ink">
                          <Lock size={11} /> внутренний
                        </span>
                      )}
                    </div>
                    {m.text && <div className={cn("mt-1.5 inline-block max-w-full rounded-[12px] px-3.5 py-2 text-[14px] leading-snug text-ink-2", m.channel === "internal" ? "bg-[#fff7e8]" : "bg-[#f6f4ee]")}>{m.text}</div>}
                    {m.files.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.files.map((f) => (
                          <Thumb key={f.id} a={f} onOpen={setPreview} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.name ?? ""} width={760}>
        {preview?.src ? <img src={preview.src} alt={preview.name} className="w-full rounded-[12px]" /> : <div className="py-10 text-center text-muted">У этого файла из демо-данных нет оригинала.</div>}
      </Modal>
    </div>
  );
}
