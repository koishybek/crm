import { useQuery } from "convex/react";
import {
  ArrowRight,
  MessageCircle,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  RotateCw,
  Sparkles,
  Upload,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AiCard } from "../components/AiCard";
import { ExportButton } from "../components/ExportButton";
import { SignedAudio } from "../components/SignedMedia";
import { Avatar, Badge, Button, Drawer, EmptyState, KpiCard, Loading, PageHeader, Pagination, Tabs } from "../components/ui";
import type { Tone } from "../data/catalog";
import { useFileQuery } from "../data/files";
import { useNow, useTeam, useUi } from "../data/hooks";
import { reprocessCall, report, toast, uploadCall } from "../data/store";
import type { AiStatus, Call } from "../data/types";
import { cn, dateTime, dayDiff, phone, when } from "../lib/format";

/** Номер клиента: у входящего — кто звонил, у исходящего — кому звонили. */
export const callNumber = (c: Pick<Call, "direction" | "from" | "to">) => (c.direction === "in" ? c.from : c.to);
export const talkTime = (sec?: number) => (sec === undefined ? "—" : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`);

type Kind = { label: string; tone: Tone; icon: LucideIcon };
const callKind = (c: Call): Kind =>
  c.status === "missed"
    ? { label: "Пропущенный", tone: "red", icon: PhoneMissed }
    : c.status === "ringing"
      ? { label: "Звонит", tone: "amber", icon: PhoneIncoming }
      : c.status === "answered"
        ? { label: "Идёт разговор", tone: "green", icon: PhoneCall }
        : c.direction === "out"
          ? { label: "Исходящий", tone: "blue", icon: PhoneOutgoing }
          : { label: "Входящий", tone: "green", icon: PhoneIncoming };

const callTitle = (c: Call) =>
  c.status === "missed" ? "Пропущенный звонок" : c.status === "answered" ? "Идёт разговор" : c.direction === "out" ? "Исходящий звонок" : "Входящий звонок";

const AI_BADGE: Record<AiStatus, { label: string; tone: Tone } | null> = {
  pending: { label: "Разбирает…", tone: "violet" },
  done: { label: "Разобран", tone: "violet" },
  failed: { label: "Ошибка AI", tone: "red" },
  none: null,
};

type TabId = "all" | "missed" | "nolead" | "ai";
const TABS: { id: TabId; label: string }[] = [
  { id: "all", label: "Все" },
  { id: "missed", label: "Пропущенные" },
  { id: "nolead", label: "Без заявки" },
  { id: "ai", label: "С AI-разбором" },
];
const PER_PAGE = 12;

/** Пропущенный считается обработанным, если после него с этим номером был разговор. */
function useCallbacks(list: Call[]) {
  return useMemo(() => {
    const lastTalk = new Map<string, string>();
    for (const c of list) {
      if (c.status !== "completed" && c.status !== "answered") continue;
      const n = callNumber(c);
      if ((lastTalk.get(n) ?? "") < c.startedAt) lastTalk.set(n, c.startedAt);
    }
    return (c: Call) => c.status === "missed" && (lastTalk.get(callNumber(c)) ?? "") > c.startedAt;
  }, [list]);
}

export default function Calls() {
  const now = useNow();
  const team = useTeam();
  const ui = useUi();
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<TabId>("all");
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const data = useQuery(api.calls.list);
  const list = useMemo(() => data ?? [], [data]);
  const calledBack = useCallbacks(list);

  // Открыть звонок из уведомления: /calls?open=<id>
  useEffect(() => {
    const id = params.get("open");
    if (id) {
      setOpenId(id);
      params.delete("open");
      setParams(params, { replace: true });
    }
  }, [params, setParams]);
  useEffect(() => setPage(1), [tab]);

  const isToday = (c: Call) => dayDiff(new Date(c.startedAt), new Date(now)) === 0;
  const today = list.filter(isToday);
  const waiting = list.filter((c) => c.status === "missed" && !calledBack(c) && now - Date.parse(c.startedAt) < 3 * 86400_000);
  const week = list.filter((c) => now - Date.parse(c.startedAt) < 7 * 86400_000);
  const aiWeek = week.filter((c) => c.aiStatus === "done");

  const match: Record<TabId, (c: Call) => boolean> = {
    all: () => true,
    missed: (c) => c.status === "missed",
    nolead: (c) => c.status === "completed" && c.direction === "in" && !c.leadId,
    ai: (c) => !!c.aiStatus && c.aiStatus !== "none",
  };
  const rows = list.filter(match[tab]);
  const pageRows = rows.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  const upload = async (file: File) => {
    setUploading(true);
    const r = await uploadCall(file, { autoLead: true });
    setUploading(false);
    if (!report(r)) return;
    toast("Запись загружена. AI разберёт её за минуту", "info");
    setOpenId(r.value);
  };

  return (
    <>
      <PageHeader
        title="Звонки"
        subtitle="Входящие и исходящие, записи разговоров и AI-разбор"
        actions={
          <>
            <ExportButton kinds={["calls"]} height={44} />
            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.amr" className="hidden" onChange={(e) => (e.target.files?.[0] && void upload(e.target.files[0]), (e.target.value = ""))} />
            <Button variant="secondary" icon={Upload} disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? "Загружаем…" : "Загрузить запись"}
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          icon={PhoneCall}
          tone="green"
          label="Звонков сегодня"
          value={today.length}
          caption={`входящих ${today.filter((c) => c.direction === "in").length} · исходящих ${today.filter((c) => c.direction === "out").length}`}
          onClick={() => setTab("all")}
        />
        <KpiCard icon={PhoneMissed} tone="red" label="Ждут перезвона" value={waiting.length} caption={waiting.length ? "пропущенные без ответа" : "всем перезвонили"} onClick={() => setTab("missed")} />
        <KpiCard
          icon={Sparkles}
          tone="violet"
          label="Разобрано AI за неделю"
          value={aiWeek.length}
          caption={`стали заявками: ${aiWeek.filter((c) => c.leadId).length}`}
          onClick={() => setTab("ai")}
        />
      </div>

      <div className="card mt-4 p-4 sm:p-5">
        <Tabs items={TABS.map((t) => ({ ...t, count: list.filter(match[t.id]).length }))} value={tab} onChange={setTab} />

        {data === undefined ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={PhoneCall}
            title={list.length ? "Здесь пусто" : "Звонков пока нет"}
            text={list.length ? "Под этот фильтр звонков нет." : "Подключите АТС в настройках — звонки появятся здесь сами. Или загрузите запись разговора вручную."}
          />
        ) : (
          <>
            <div className="scroll-x mt-3">
              <table className="tbl min-w-[980px]">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Клиент</th>
                    <th>Звонок</th>
                    <th>Длительность</th>
                    <th>Оператор</th>
                    <th>AI</th>
                    <th>Заявка</th>
                    <th className="text-right">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((c) => {
                    const k = callKind(c);
                    const num = callNumber(c);
                    const ai = c.aiStatus ? AI_BADGE[c.aiStatus] : null;
                    const op = team.userName(c.operatorId);
                    return (
                      <tr key={c.id} className="row-link" onClick={() => setOpenId(c.id)}>
                        <td className={cn("whitespace-nowrap", isToday(c) ? "text-ink-2" : "text-muted")}>{when(c.startedAt, new Date(now))}</td>
                        <td>
                          <span className="flex items-center gap-3">
                            <Avatar name={c.clientName ?? "?"} size={38} />
                            <span className="min-w-0 leading-tight">
                              <span className={cn("block max-w-[190px] truncate font-medium", c.clientName ? "text-ink" : "text-muted")}>{c.clientName ?? "Новый номер"}</span>
                              <span className="text-[13px] text-muted">{num ? phone(num) : "номер не определён"}</span>
                            </span>
                          </span>
                        </td>
                        <td>
                          <span className="flex items-center gap-2">
                            <Badge tone={k.tone}>
                              <k.icon size={14} className="mr-1 -ml-0.5 inline" aria-hidden />
                              {k.label}
                            </Badge>
                            {calledBack(c) && <span className="text-[12.5px] text-muted">перезвонили</span>}
                          </span>
                        </td>
                        <td className="text-ink-2 tabular-nums">{talkTime(c.duration)}</td>
                        <td className="text-ink-2">{op ? op.split(" ")[0] : <span className="text-faint">—</span>}</td>
                        <td>{ai ? <Badge tone={ai.tone} size="sm">{ai.label}</Badge> : <span className="text-faint">—</span>}</td>
                        <td onClick={(e) => e.stopPropagation()}>
                          {c.leadId ? (
                            <button className="font-semibold text-brand-ink hover:underline" onClick={() => ui.openLead({ leadId: c.leadId })}>
                              Открыть
                            </button>
                          ) : c.status !== "ringing" && c.status !== "answered" ? (
                            <button className="font-medium text-ink-2 hover:text-brand-ink" onClick={() => ui.openLead({ callId: c.id })}>
                              + Создать
                            </button>
                          ) : (
                            <span className="text-faint">—</span>
                          )}
                        </td>
                        <td onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1.5">
                            {num && (
                              <a href={`tel:+${num}`} aria-label={`Позвонить: ${phone(num)}`} className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] bg-[#f4f2ec] text-ink-2 hover:bg-brand-soft hover:text-brand-ink">
                                <Phone size={16} />
                              </a>
                            )}
                            {num && (
                              <a href={`https://wa.me/${num}`} target="_blank" rel="noreferrer" aria-label={`Написать: ${phone(num)}`} className="inline-flex h-9 w-9 items-center justify-center rounded-[9px] bg-[#f4f2ec] text-brand-ink hover:bg-brand-soft">
                                <MessageCircle size={16} />
                              </a>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={rows.length} perPage={PER_PAGE} onChange={setPage} noun="звонков" />
          </>
        )}
      </div>

      <CallDrawer id={openId} onClose={() => setOpenId(null)} />
    </>
  );
}

// ── Карточка звонка ──────────────────────────────────────────────────────────

function CallDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const data = useFileQuery(api.calls.get, id ? { id: id as Id<"calls"> } : "skip");
  const call = data?.call;
  return (
    <Drawer open={!!id} onClose={onClose} title={call ? callTitle(call) : "Звонок"} footer={null} width={520}>
      {data === undefined ? <Loading /> : !call ? <div className="text-muted">Звонок не найден</div> : <CallView call={call} lead={data.lead} onClose={onClose} />}
    </Drawer>
  );
}

function CallView({ call, lead, onClose }: { call: Call; lead: { id: string; number: number; orderId: string | null } | null; onClose: () => void }) {
  const nav = useNavigate();
  const ui = useUi();
  const team = useTeam();
  const num = callNumber(call);
  const k = callKind(call);
  const [busy, setBusy] = useState(false);
  const op = team.userName(call.operatorId);

  const reprocess = async () => {
    setBusy(true);
    if (report(await reprocessCall(call.id))) toast("AI заново разбирает запись", "info");
    setBusy(false);
  };

  return (
    <div className="flex min-h-full flex-col gap-5">
      <div className="rounded-[14px] border border-line p-4">
        <div className="flex items-center gap-3">
          <Avatar name={call.clientName ?? "?"} size={46} />
          <div className="min-w-0 flex-1">
            {call.clientId ? (
              <button onClick={() => (onClose(), nav(`/clients/${call.clientId}`))} className="block max-w-full truncate text-left text-[16px] font-semibold text-ink hover:text-brand-ink">
                {call.clientName}
              </button>
            ) : (
              <div className="text-[16px] font-semibold text-ink">{call.clientName ?? "Новый номер"}</div>
            )}
            <div className="text-[13.5px] text-muted">{num ? phone(num) : "номер не определён"}</div>
          </div>
          {num && (
            <>
              <a href={`tel:+${num}`} className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-ok-bg text-ok-ink" aria-label="Позвонить">
                <Phone size={18} />
              </a>
              <a href={`https://wa.me/${num}`} target="_blank" rel="noreferrer" className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-soft text-brand-ink" aria-label="Написать в WhatsApp">
                <MessageCircle size={18} />
              </a>
            </>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-3 text-[13.5px] text-ink-2">
          <Badge tone={k.tone}>
            <k.icon size={14} className="mr-1 -ml-0.5 inline" aria-hidden />
            {k.label}
          </Badge>
          <span>{dateTime(call.startedAt)}</span>
          {call.duration !== undefined && <span className="tabular-nums">Разговор {talkTime(call.duration)}</span>}
          {op && (
            <span className="flex items-center gap-1.5">
              <UserRound size={15} className="text-muted" aria-hidden /> {op}
            </span>
          )}
        </div>
      </div>

      {call.recordingSrc && (
        <div>
          <div className="mb-2 text-[14px] font-semibold text-ink">Запись разговора</div>
          <SignedAudio controls preload="none" src={call.recordingSrc} className="w-full">
            <a href={call.recordingSrc}>Скачать запись</a>
          </SignedAudio>
        </div>
      )}

      {call.aiStatus === "pending" && (
        <div className="flex items-start gap-3 rounded-[14px] border border-[#dccfff] bg-violet-bg/60 p-4" role="status">
          <span className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#d6c9ff] border-t-violet" />
          <div className="text-[14px] text-ink-2">
            <div className="font-semibold text-ink">AI слушает запись…</div>
            Расшифровка и разбор занимают до минуты. Окно можно закрыть — результат сохранится{call.leadId ? "" : ", а если услуга понятна, AI сам создаст заявку"}.
          </div>
        </div>
      )}
      {call.aiStatus === "failed" && (
        <div className="rounded-[14px] border border-[#ffd2da] bg-[#fff8f9] p-4 text-[14px] text-ink-2">
          <div className="font-semibold text-bad-ink">AI не смог разобрать запись</div>
          {call.aiError && <div className="mt-0.5">{call.aiError}</div>}
          <Button size="sm" variant="secondary" icon={RotateCw} className="mt-3" disabled={busy} onClick={() => void reprocess()}>
            Разобрать заново
          </Button>
        </div>
      )}
      {call.ai && call.aiStatus !== "pending" && (
        <AiCard
          ai={call.ai}
          title="AI-разбор звонка"
          action={
            call.hasRecording ? (
              <button className="inline-flex items-center gap-1 text-[12.5px] font-medium text-muted hover:text-violet" disabled={busy} onClick={() => void reprocess()}>
                <RotateCw size={13} aria-hidden /> заново
              </button>
            ) : undefined
          }
        />
      )}
      {(!call.aiStatus || call.aiStatus === "none") && (
        <div className="rounded-[12px] bg-[#f8f6f1] px-4 py-3 text-[14px] text-ink-2">
          {call.hasRecording ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>Запись есть, AI её ещё не разбирал.</span>
              <Button size="sm" variant="secondary" icon={Sparkles} disabled={busy} onClick={() => void reprocess()}>
                Разобрать AI
              </Button>
            </div>
          ) : call.status === "missed" ? (
            "Клиент не дозвонился — перезвоните ему. После разговора можно сразу создать заявку."
          ) : (
            "Записи разговора нет. Её присылает АТС после звонка — или загрузите файл в разделе «Звонки»."
          )}
        </div>
      )}

      {call.transcript && (
        <details className="group rounded-[14px] border border-line">
          <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-[14px] font-semibold text-ink">
            Расшифровка разговора
            <ArrowRight size={16} className="text-muted transition-transform group-open:rotate-90" aria-hidden />
          </summary>
          <p className="border-t border-line px-4 py-3 text-[14px] leading-relaxed whitespace-pre-line text-ink-2">{call.transcript}</p>
        </details>
      )}

      <div className="sticky -bottom-6 -mx-6 -mb-6 mt-auto flex flex-wrap justify-end gap-2.5 border-t border-line bg-white px-6 pt-4 pb-6">
        {call.clientId && (
          <Button variant="secondary" onClick={() => (onClose(), nav(`/clients/${call.clientId}`))}>
            Карточка клиента
          </Button>
        )}
        {lead ? (
          <Button iconRight={ArrowRight} onClick={() => (onClose(), lead.orderId ? nav(`/orders/${lead.orderId}`) : ui.openLead({ leadId: lead.id }))}>
            {lead.orderId ? "Открыть заказ" : `Открыть заявку №${lead.number}`}
          </Button>
        ) : (
          call.status !== "ringing" &&
          call.status !== "answered" && (
            <Button disabled={call.aiStatus === "pending"} onClick={() => (onClose(), ui.openLead({ callId: call.id }))}>
              Создать заявку
            </Button>
          )
        )}
      </div>
    </div>
  );
}
