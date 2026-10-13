// Журнал действий в карточках: кто сделал, куда ведёт запись и «История» объекта (ТЗ п.5, п.15, п.27).
import { ArrowUpRight, ChevronDown, Cog, History, Sparkles, Webhook, type LucideIcon } from "lucide-react";
import { useQuery } from "convex/react";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../convex/_generated/api";
import { AUDIT_ENTITY, canSeeEntityHistory, isSystemActor, type SystemActor } from "../data/audit";
import { ROLE_LABEL } from "../data/catalog";
import { useMe, useUi } from "../data/hooks";
import type { AuditEntity, AuditEntry, Role, SourceId } from "../data/types";
import { cn, dateTime, plural } from "../lib/format";
import { SourceIcon } from "./icons";
import { Avatar } from "./ui";

type Who = Pick<AuditEntry, "actorId" | "actorName" | "actorRole">;

const isRole = (r: string | undefined): r is Role => r !== undefined && Object.prototype.hasOwnProperty.call(ROLE_LABEL, r);

/** Каналы показываем их значками источника, систему, AI и API — своими. */
const CHANNEL: Partial<Record<SystemActor, SourceId>> = { Telegram: "telegram", WhatsApp: "whatsapp", OLX: "olx", Сайт: "site", АТС: "phone" };
const OWN_MARK: Partial<Record<SystemActor, { icon: LucideIcon; className: string }>> = {
  Система: { icon: Cog, className: "bg-slate-bg text-muted" },
  AI: { icon: Sparkles, className: "bg-violet-bg text-violet" },
  API: { icon: Webhook, className: "bg-sky-bg text-sky" },
};

const systemOf = (w: Who): SystemActor | null => (!w.actorId && isSystemActor(w.actorName) ? w.actorName : null);

function SystemMark({ actor, size }: { actor: SystemActor; size: number }) {
  const channel = CHANNEL[actor];
  const own = OWN_MARK[actor];
  return (
    <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full", own?.className ?? "bg-slate-bg")} style={{ width: size, height: size }} aria-hidden>
      {channel ? <SourceIcon source={channel} size={Math.round(size * 0.56)} /> : own ? <own.icon size={Math.round(size * 0.52)} strokeWidth={1.9} /> : null}
    </span>
  );
}

/** Роль автора на момент действия; у системы, AI и каналов — «автоматически». */
export const auditRole = (w: Who): string => (systemOf(w) ? "автоматически" : isRole(w.actorRole) ? ROLE_LABEL[w.actorRole] : "сотрудник");

/** Кто сделал: сотрудник — аватар, имя и роль на момент действия; система, AI и каналы — значок. */
export function AuditWho({ entry, size = 34 }: { entry: Who; size?: number }) {
  const system = systemOf(entry);
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      {system ? <SystemMark actor={system} size={size} /> : <Avatar name={entry.actorName} size={size} variant="person" />}
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-[14px] font-semibold text-ink">{entry.actorName}</span>
        <span className="block truncate text-[12.5px] text-muted">{auditRole(entry)}</span>
      </span>
    </span>
  );
}

/** Подпись автора в строку: «Мадина Е.» или значок канала + «Telegram». */
function WhoInline({ entry }: { entry: Who }) {
  const system = systemOf(entry);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {system && <SystemMark actor={system} size={18} />}
      <span className="truncate">{entry.actorName}</span>
    </span>
  );
}

const PATH: Partial<Record<AuditEntity, (id: string) => string>> = {
  order: (id) => `/orders/${id}`,
  // Отзыв — один на заказ, в журнале он записан на заказ: открываем карточку заказа с блоком «Отзыв клиента».
  review: (id) => `/orders/${id}`,
  client: (id) => `/clients/${id}`,
  executor: (id) => `/executors/${id}`,
  call: (id) => `/calls?open=${encodeURIComponent(id)}`,
};

/** Ссылка на объект записи: заявка открывается в карточке-дровере, заказ, клиент, исполнитель и звонок — на своих страницах. */
export function AuditObjectLink({ entry, className }: { entry: Pick<AuditEntry, "entity" | "entityId">; className?: string }) {
  const openLead = useUi((s) => s.openLead);
  const id = entry.entityId;
  const to = id ? PATH[entry.entity]?.(id) : undefined;
  if (!id || (entry.entity !== "lead" && !to)) return null;
  const label = AUDIT_ENTITY[entry.entity].one;
  const cls = cn(
    "inline-flex h-8 shrink-0 items-center gap-1 rounded-[9px] border border-line bg-white px-2.5 text-[13px] font-semibold whitespace-nowrap text-brand-ink hover:border-brand-line hover:bg-brand-soft/50",
    className,
  );
  const body = (
    <>
      {label}
      <ArrowUpRight size={15} aria-hidden />
    </>
  );
  return entry.entity === "lead" ? (
    <button type="button" className={cls} onClick={() => openLead({ leadId: id })} aria-label={`Открыть: ${label}`}>
      {body}
    </button>
  ) : (
    <Link to={to!} className={cls} aria-label={`Открыть: ${label}`}>
      {body}
    </Link>
  );
}

const FIRST = 6;

/**
 * «История» объекта: кто, когда и что менял — новые сверху, по умолчанию свёрнута.
 * Кому история не положена (руководитель — клиенты и исполнители, исполнитель — всё), блока нет вовсе.
 * variant="card" — отдельная карточка на странице, "inline" — блок внутри дровера.
 */
export function EntityHistory({ entity, entityId, variant = "inline", className }: { entity: AuditEntity; entityId: string; variant?: "card" | "inline"; className?: string }) {
  const me = useMe();
  const allowed = !!me && canSeeEntityHistory(me.role, entity);
  const rows = useQuery(api.audit.forEntity, allowed ? { entity, entityId } : "skip");
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  if (!allowed || rows === null) return null;
  const card = variant === "card";
  const pad = card ? "px-5" : "px-4";

  return (
    <section className={cn("min-w-0", card ? "card" : "rounded-[14px] border border-line", className)}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className={cn("flex w-full items-center gap-3 py-3.5 text-left", pad)}>
        <History size={card ? 20 : 18} className="shrink-0 text-muted" aria-hidden />
        <span className={cn("flex-1 font-semibold text-ink", card ? "text-[18px] tracking-[-0.01em]" : "text-[15px]")}>История</span>
        {rows !== undefined && <span className="text-[13px] text-muted">{rows.length ? `${rows.length} ${plural(rows.length, "запись", "записи", "записей")}` : "пусто"}</span>}
        <ChevronDown size={18} className={cn("shrink-0 text-ink-2 transition-transform", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className={cn("border-t border-line pt-1 pb-3", pad)}>
          {rows === undefined ? (
            <div className="py-4 text-center text-[13.5px] text-muted">Загружаем…</div>
          ) : rows.length === 0 ? (
            <div className="py-4 text-center text-[13.5px] text-muted">Действий пока не было</div>
          ) : (
            <>
              <ol className="divide-y divide-line">
                {(all ? rows : rows.slice(0, FIRST)).map((e) => (
                  <li key={e.id} className="py-2.5">
                    <p className="text-[14px] leading-snug text-ink [overflow-wrap:anywhere]">{e.summary}</p>
                    <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[12.5px] text-muted">
                      <time dateTime={e.at}>{dateTime(e.at)}</time>
                      <span aria-hidden>·</span>
                      <WhoInline entry={e} />
                    </div>
                  </li>
                ))}
              </ol>
              {!all && rows.length > FIRST && (
                <button type="button" onClick={() => setAll(true)} className="mt-1 text-[13.5px] font-semibold text-brand-ink hover:underline">
                  Показать все ({rows.length})
                </button>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
