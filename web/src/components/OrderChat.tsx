import { Eye, EyeOff, FileText, HardHat, ImageIcon, Lock, Paperclip, SendHorizontal, X, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { setFileForExecutor, useFileQuery } from "../data/files";
import { canUseInbox } from "../data/inbox";
import { sendToOrderClient } from "../data/orderClientActions";
import { addMessage, report, toast, uploadFile } from "../data/store";
import type { Actor, Attachment, Message, MessageChannel, User } from "../data/types";
import { cn, shortName, when } from "../lib/format";
import { ClientFeedItem, ClientTarget } from "./OrderClientFeed";
import type { OrderClientMessage } from "../data/orderClientChat";
import { SignedImg } from "./SignedMedia";
import { Avatar, Modal } from "./ui";

const Placeholder = ({ name }: { name: string }) => (
  <span className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted">
    <ImageIcon size={20} />
    <span className="max-w-full truncate px-1.5 text-[10.5px]">{name.replace(/\.\w+$/, "")}</span>
  </span>
);

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
      <SignedImg src={a.src} alt={a.name} className="h-full w-full object-cover" fallback={<Placeholder name={a.name} />} />
    </button>
  );
}

/**
 * Видно ли файл мастеру. Вложения переписки с мастером он видит в ней всегда; остальные — по «Показать мастеру».
 * Сервер не даст скрыть файл из переписки с мастером (orders.setFileForExecutor).
 */
function ExecutorAccess({ orderId, file, fromThread }: { orderId: string; file: Attachment; fromThread: boolean }) {
  const [busy, setBusy] = useState(false);
  const shown = fromThread || file.forExecutor === true;
  if (fromThread)
    return (
      <span className="mt-1 inline-flex items-center gap-1 text-[11.5px] font-medium text-blue">
        <Eye size={12} aria-hidden /> видно мастеру
      </span>
    );
  const toggle = async () => {
    setBusy(true);
    report(await setFileForExecutor(orderId, file.id, !shown), shown ? "Мастер больше не видит файл" : "Файл показан мастеру");
    setBusy(false);
  };
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      aria-pressed={shown}
      title={shown ? "Скрыть файл от мастера" : "Показать файл мастеру в его приложении"}
      className={cn(
        "mt-1 inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11.5px] font-medium disabled:opacity-60",
        shown ? "bg-blue-soft text-blue" : "text-muted hover:bg-[#f4f2ec] hover:text-ink",
      )}
    >
      {shown ? <Eye size={12} aria-hidden /> : <EyeOff size={12} aria-hidden />}
      {shown ? "Видно мастеру" : "Показать мастеру"}
    </button>
  );
}

type Pending = Attachment & { storageId?: Id<"_storage"> };
/** Лента заказа: сообщения заказа и переписка с клиентом из его мессенджера — по времени. */
type TimelineItem = { key: string; at: string; order: Message } | { key: string; at: string; client: OrderClientMessage };

const CHANNELS: { id: MessageChannel; label: string; icon?: LucideIcon; active: string; border: string; bubble: string; placeholder: string; hint?: string }[] = [
  { id: "client", label: "Переписка с клиентом", active: "bg-brand-soft text-brand-ink", border: "border-line-strong", bubble: "bg-[#f6f4ee]", placeholder: "Написать комментарий..." },
  {
    id: "executor",
    label: "С мастером",
    icon: HardHat,
    active: "bg-blue-soft text-blue",
    border: "border-[#b9d6ff]",
    bubble: "bg-blue-soft",
    placeholder: "Сообщение мастеру",
    hint: "Мастер увидит его в приложении и в Telegram",
  },
  {
    id: "internal",
    label: "Внутренний",
    icon: Lock,
    active: "bg-warn-bg text-warn-ink",
    border: "border-[#f5d9a8]",
    bubble: "bg-[#fff7e8]",
    placeholder: "Заметка для команды",
    hint: "Ни клиент, ни мастер её не увидят",
  },
];
const channelOf = (id: MessageChannel) => CHANNELS.find((c) => c.id === id) ?? CHANNELS[0]!;

/**
 * Переписка по заказу для сотрудников. Сообщения приходят с сервера (реактивно), файлы сразу грузятся в хранилище
 * и уходят вместе с сообщением. Мастер видит только вкладку «С мастером» и файлы, отмеченные «Показать мастеру»
 * (аудит M-6). nameOf — как подписать автора; executorName — кто сейчас назначен (подсказка во вкладке мастера).
 */
export function OrderChat({ orderId, messages, me, nameOf, compact, executorName }: { orderId: string; messages: Message[]; me: User; nameOf: (a: Actor) => string; compact?: boolean; executorName?: string }) {
  const [text, setText] = useState("");
  const [channel, setChannel] = useState<MessageChannel>("client");
  const [files, setFiles] = useState<Pending[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  // Просмотр фото — по id: ссылка берётся из свежих данных, а не та, что была при клике.
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = previewId ? (messages.flatMap((m) => m.files).find((f) => f.id === previewId) ?? null) : null;
  const fileRef = useRef<HTMLInputElement>(null);
  // Локальные превью выбранных картинок до отправки.
  useEffect(() => () => files.forEach((f) => f.src?.startsWith("blob:") && URL.revokeObjectURL(f.src)), [files]);
  const current = channelOf(channel);
  // Владелец и операторы пишут клиенту в его мессенджер прямо отсюда; руководителю направления это остаётся заметками.
  const thread = useFileQuery(api.orderClientChat.feed, canUseInbox(me) ? { orderId: orderId as Id<"orders"> } : "skip");
  const toClient = channel === "client" && !!thread;
  const timeline = [...messages.map((m): TimelineItem => ({ key: m.id, at: m.at, order: m })), ...(thread?.messages ?? []).map((m): TimelineItem => ({ key: m.id, at: m.at, client: m }))].sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
  );

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
    if (toClient) return sendClient();
    setSending(true);
    const r = await addMessage(orderId, text, channel, files);
    setSending(false);
    if (!r.ok) return toast(r.error, "bad");
    setText("");
    setFiles([]);
  };

  /** «Клиенту»: текст — в мессенджер клиента (или заметкой, если писать некуда), файлы — в заказ. */
  const sendClient = async () => {
    const body = text.trim();
    if (!body && !files.length) return toast("Напишите сообщение", "info");
    setSending(true);
    if (body) {
      const r = await sendToOrderClient(orderId, body);
      if (!r.ok) {
        setSending(false);
        return toast(r.error, "bad");
      }
      setText("");
      if (!r.value.sent) toast(r.value.reason, "info");
    }
    if (files.length) {
      const r = await addMessage(orderId, "", "client", files);
      if (!r.ok) {
        setSending(false);
        return toast(r.error, "bad");
      }
      setFiles([]);
    }
    setSending(false);
  };

  return (
    <div>
      <div className="flex items-start gap-3">
        {!compact && <Avatar name={me.name} size={42} variant="person" className="mt-0.5 hidden sm:inline-flex" />}
        <div className={cn("min-w-0 flex-1 rounded-[12px] border bg-white transition-colors", current.border)}>
          <div className="flex flex-wrap items-center gap-2 px-2 pt-2" role="tablist" aria-label="Кому сообщение">
            {CHANNELS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="tab"
                aria-selected={channel === c.id}
                onClick={() => setChannel(c.id)}
                className={cn("inline-flex items-center gap-1.5 rounded-[8px] px-2.5 py-1 text-[12.5px] font-semibold", channel === c.id ? c.active : "text-muted hover:bg-[#f4f2ec]")}
              >
                {c.icon && <c.icon size={12} aria-hidden />}
                {c.id === "client" && thread ? "Клиенту" : c.label}
              </button>
            ))}
          </div>
          {channel === "executor" && (
            <p className="px-3 pt-1.5 text-[12.5px] text-muted">
              {executorName ? `Увидит ${executorName}: в приложении мастера и в Telegram. Файлы отсюда мастеру видны сразу.` : "Мастер ещё не назначен — сообщение увидит тот, кто возьмёт заказ."}
            </p>
          )}
          {toClient && <ClientTarget thread={thread} />}
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
              placeholder={toClient ? (thread?.target ? "Сообщение клиенту" : "Заметка по клиенту") : current.placeholder}
              // Короткая подсказка в поле (на телефоне длинная обрезалась), кому уйдёт — во всплывающей подсказке.
              title={toClient ? (thread?.target ? "Уйдёт клиенту в его мессенджер" : "Клиенту она не уйдёт") : current.hint}
              aria-label="Сообщение"
              className="max-h-32 min-h-[38px] flex-1 resize-none bg-transparent py-2 text-[14.5px] text-ink placeholder:text-faint focus:outline-none"
            />
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx"
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
                  {f.kind === "image" && f.src ? (
                    <img src={f.src} alt={f.name} className="h-[49px] w-[72px] rounded-[10px] border border-line object-cover" />
                  ) : (
                    <Thumb a={f} size={72} />
                  )}
                  <button onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label="Убрать файл" className="absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-ink text-white">
                    <X size={12} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {timeline.length === 0 ? (
        <div className="py-8 text-center text-[14px] text-muted">Сообщений пока нет. Здесь будет переписка по заказу и фото.</div>
      ) : (
        <ol className="relative mt-5 space-y-4 pl-6 before:absolute before:top-2 before:bottom-2 before:left-[5px] before:w-px before:bg-line-strong">
          {timeline.map((item, i) => {
            const dot = <span className={cn("absolute top-3 -left-6 h-[11px] w-[11px] rounded-full border-2 border-white", i === 0 ? "bg-[#ffc629]" : "bg-[#d9d4c8]")} />;
            if ("client" in item)
              return (
                <li key={item.key} className="relative">
                  {dot}
                  <ClientFeedItem m={item.client} />
                </li>
              );
            const m = item.order;
            const c = channelOf(m.channel);
            return (
              <li key={item.key} className="relative">
                {dot}
                <div className="flex items-start gap-3">
                  <Avatar name={nameOf(m.author)} size={40} variant={m.author.type === "client" ? "client" : "person"} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      <span className="text-[14px] font-semibold text-ink">{shortName(nameOf(m.author))}</span>
                      <span className="text-[12.5px] text-muted">{when(m.at)}</span>
                      {m.channel === "internal" && (
                        <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-warn-ink">
                          <Lock size={11} /> внутренний
                        </span>
                      )}
                      {m.channel === "executor" && (
                        <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-blue">
                          <HardHat size={11} /> с мастером
                        </span>
                      )}
                    </div>
                    {m.text && <div className={cn("mt-1.5 inline-block max-w-full rounded-[12px] px-3.5 py-2 text-[14px] leading-snug whitespace-pre-line text-ink-2", c.bubble)}>{m.text}</div>}
                    {m.files.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {m.files.map((f) => (
                          <span key={f.id} className="inline-flex flex-col items-start">
                            <Thumb a={f} onOpen={(a) => setPreviewId(a.id)} />
                            <ExecutorAccess orderId={orderId} file={f} fromThread={m.channel === "executor"} />
                          </span>
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

      <Modal open={!!preview} onClose={() => setPreviewId(null)} title={preview?.name ?? ""} width={760}>
        <SignedImg src={preview?.src} alt={preview?.name ?? ""} className="w-full rounded-[12px]" fallback={<div className="py-10 text-center text-muted">У этого файла нет оригинала или он ещё загружается.</div>} />
      </Modal>
    </div>
  );
}
