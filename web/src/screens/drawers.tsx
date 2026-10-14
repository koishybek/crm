import {
  ArrowRight,
  Ban,
  CalendarClock,
  CircleAlert,
  Clock3,
  Clock,
  Copy,
  Hand,
  KeyRound,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  PhoneCall,
  RotateCw,
  Sparkles,
  Undo2,
  User as UserIcon,
} from "lucide-react";
import { useQuery } from "convex/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import {
  APP_NAME,
  CATEGORIES,
  CITIES,
  LEAD_STATUS,
  REJECT_REASONS,
  SERVICES,
  SOURCES,
  SOURCE_IDS,
  serviceById,
} from "../data/catalog";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useFileQuery } from "../data/files";
import { useMe, useNow, useTeam, useUi } from "../data/hooks";
import { normalizeCity } from "../data/cities";
import { awaitsOperator, deadlineByUrgency, LEAD_ORIGIN } from "../data/leadRules";
import { leadBadge } from "../data/logic";
import { takeLead } from "../data/operationsActions";
import {
  convertLead,
  createClient,
  createExecutor,
  createLead,
  parseLeadText,
  reprocessCall,
  setLeadStatus,
  report,
  toast,
  updateClient,
  updateExecutor,
  updateLead,
  uploadCall,
} from "../data/store";
import type { AiDraft, AiSummary, CategoryId, Client, Lead, SourceId, Urgency } from "../data/types";
import { linkConversationLead, useConversationDraft } from "../data/inbox";
import { AiCard } from "../components/AiCard";
import { SignedAudio } from "../components/SignedMedia";
import { ConversationLink } from "../components/ConversationLink";
import { EntityHistory } from "../components/AuditHistory";
import { Source } from "../components/icons";
import { ExecutorSkillsField, withoutCategory } from "../components/SkillChips";
import { DistrictField, DistrictPicker } from "../components/DistrictSelect";
import { normalizeSkills, SKILLS_PER_EXECUTOR } from "../data/skills";
import { Avatar, Badge, Button, Drawer, FormRow, Input, Segmented, Select, Textarea } from "../components/ui";
import { cn, dateTime, digits, money, phone, phoneMask } from "../lib/format";

// ── Общие поля ───────────────────────────────────────────────────────────────

export function PhoneInput({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <Input
      id={id}
      icon={Phone}
      inputMode="tel"
      placeholder="+7 (___) ___-__-__"
      value={value}
      onChange={(e) => onChange(digits(e.target.value) ? phoneMask(e.target.value) : "")}
    />
  );
}

export function ServiceSelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>
        Выберите услугу
      </option>
      {CATEGORIES.filter((c) => c.active !== false).map((c) => (
        <optgroup key={c.id} label={c.label}>
          {SERVICES.filter((s) => s.category === c.id && (s.active !== false || s.id === value)).map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

export function CitySelect({ value, onChange, id }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <Select id={id} icon={MapPin} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="" disabled>
        Выберите город
      </option>
      {CITIES.map((c) => (
        <option key={c}>{c}</option>
      ))}
    </Select>
  );
}

export function SourceSelect({ value, onChange, id }: { value: SourceId | ""; onChange: (v: SourceId) => void; id?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value as SourceId)}>
      <option value="" disabled>
        Выберите источник
      </option>
      {SOURCE_IDS.map((s) => (
        <option key={s} value={s}>
          {SOURCES[s].label}
        </option>
      ))}
    </Select>
  );
}

const URGENCY_OPTIONS: { value: Urgency; label: string; icon: ReactNode }[] = [
  { value: "normal", label: "Обычная", icon: <Clock size={18} className="text-brand-ink" /> },
  { value: "high", label: "Высокая", icon: <Clock3 size={18} className="text-warn" /> },
  { value: "urgent", label: "Срочная", icon: <CircleAlert size={18} className="fill-bad text-white" /> },
];

// ── Заявка ───────────────────────────────────────────────────────────────────

export function LeadDrawer() {
  const { lead, closeLead } = useUi();
  return (
    <Drawer open={lead.open} onClose={closeLead} title={lead.leadId ? <LeadTitle id={lead.leadId} /> : lead.mode === "order" ? "Новый заказ" : "Новая заявка"} footer={null} width={480}>
      {lead.open &&
        (lead.leadId ? (
          <LeadView key={lead.leadId} id={lead.leadId} />
        ) : (
          <NewLeadForm
            key={`${lead.mode}-${lead.clientId ?? ""}-${lead.callId ?? ""}-${lead.conversationId ?? ""}`}
            mode={lead.mode}
            clientId={lead.clientId}
            callId={lead.callId}
            phone={lead.phone}
            conversationId={lead.conversationId}
          />
        ))}
    </Drawer>
  );
}

function LeadTitle({ id }: { id: string }) {
  const d = useQuery(api.leads.get, { id: id as Id<"leads"> });
  return <>Заявка №{d?.lead.number ?? ""}</>;
}

/** Значение, которое меняется не чаще раза в delay мс — для запросов при наборе. */
function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

const AI_CHIP = "inline-flex h-9 items-center gap-1.5 rounded-[9px] border border-[#e2d9ff] bg-white px-3 text-[13px] font-semibold text-ink-2 hover:border-violet hover:text-violet disabled:opacity-60";

function NewLeadForm({
  mode,
  clientId,
  callId: callFromProps,
  phone: phoneFromProps,
  conversationId,
}: {
  mode: "lead" | "order";
  clientId?: string;
  callId?: string;
  phone?: string;
  /** Заявка из «Сообщений»: форма заполняется по переписке, заявка связывается с диалогом. */
  conversationId?: string;
}) {
  const nav = useNavigate();
  const close = useUi((s) => s.closeLead);
  const openLead = useUi((s) => s.openLead);
  // Звонок, из которого создаём заявку: передан снаружи или появился после загрузки записи здесь.
  const [callId, setCallId] = useState(callFromProps);
  const callData = useFileQuery(api.calls.get, callId ? { id: callId as Id<"calls"> } : "skip");
  const call = callData?.call;
  const presetId = clientId ?? call?.clientId;
  const preset = useQuery(api.clients.get, presetId ? { id: presetId as Id<"clients"> } : "skip");
  const aiStatus = useQuery(api.ai.status);
  const aiOn = aiStatus?.enabled ?? false;
  const sttOn = aiStatus?.canTranscribe ?? false;

  const [client, setClient] = useState<Client | undefined>();
  const [name, setName] = useState("");
  const [ph, setPh] = useState(phoneFromProps ? phoneMask(phoneFromProps) : "");
  const [source, setSource] = useState<SourceId | "">(callFromProps ? "phone" : "");
  const [serviceId, setServiceId] = useState("");
  const [city, setCity] = useState(preset?.city ?? "");
  const [district, setDistrict] = useState("");
  const [description, setDescription] = useState("");
  const [urgency, setUrgency] = useState<Urgency>("normal");
  const [comment, setComment] = useState("");
  const [address, setAddress] = useState("");
  const [preferredTime, setPreferredTime] = useState("");
  const [budget, setBudget] = useState("");
  const [suggest, setSuggest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ai, setAi] = useState<AiSummary | undefined>();
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const appliedFor = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const q = useDebounced(name.trim());
  const matches = (useQuery(api.clients.list, q.length >= 2 && !client ? { q } : "skip") ?? []).slice(0, 6);
  // ТЗ п.7: по номеру ищем клиента, иначе создаём нового.
  const byPhone = useQuery(api.clients.byPhone, digits(ph).length === 11 && !client ? { phone: digits(ph) } : "skip") ?? undefined;

  const pick = (c: Client) => {
    setClient(c);
    setName(c.name);
    setPh(phoneMask(c.phone));
    setCity((x) => x || c.city);
    if (!source) setSource(c.source);
    setSuggest(false);
  };
  useEffect(() => {
    if (preset && !client) pick(preset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset]);

  /** Черновик от AI → поля формы. Оператор потом всё проверяет и правит. */
  const apply = (d: AiDraft, summary: AiSummary) => {
    if (d.serviceId && SERVICES.some((x) => x.id === d.serviceId && x.active !== false)) setServiceId(d.serviceId);
    const c = normalizeCity(d.city);
    if (c && (CITIES as readonly string[]).includes(c)) {
      setCity(c);
      // Район — только явно названный клиентом (сервер сверил его со справочником города).
      setDistrict(d.district ?? "");
    }
    if (d.description) setDescription(d.description);
    // Адрес, удобное время и бюджет — полями заявки (ТЗ п.8.3): адрес перейдёт в заказ, бюджет видят только сотрудники.
    if (d.address) setAddress((x) => x || d.address!);
    if (d.when) setPreferredTime((x) => x || d.when!);
    if (d.budget) setBudget((x) => x || String(d.budget));
    if (d.urgency) setUrgency(d.urgency);
    if (d.clientName) setName((n) => (n.trim() ? n : d.clientName!));
    setAi(summary);
  };

  // Номер и источник — из звонка; разбор AI — как только он готов (даже если форма уже открыта).
  useEffect(() => {
    if (!call) return;
    const num = call.direction === "in" ? call.from : call.to;
    if (num) setPh((x) => (digits(x).length === 11 ? x : phoneMask(num)));
    setSource((x) => x || "phone");
    if (call.aiStatus === "done" && call.ai && appliedFor.current !== call.id) {
      appliedFor.current = call.id;
      apply(call.draft ?? {}, call.ai);
      if (callFromProps !== call.id) toast("AI заполнил заявку по записи — проверьте поля", "info");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call]);

  const parsePasted = async () => {
    setAiBusy(true);
    const r = await parseLeadText(pasted);
    setAiBusy(false);
    if (!report(r)) return;
    apply(r.value.draft, r.value.ai);
    // Исходное сообщение клиента не теряем — оно уходит в комментарий.
    setComment((c) => c || `Сообщение клиента: «${pasted.trim().slice(0, 900)}»`);
    setPasting(false);
    toast("AI заполнил заявку — проверьте поля", "info");
  };

  const uploadRecording = async (file: File) => {
    setAiBusy(true);
    const r = await uploadCall(file, { phone: ph, autoLead: false });
    setAiBusy(false);
    if (!report(r)) return;
    appliedFor.current = null;
    setCallId(r.value);
    setSource((x) => x || "phone");
  };

  // Заявка из «Сообщений»: номер, имя и разбор переписки — сразу в форму, оператор проверяет и сохраняет.
  const chatBusy = useConversationDraft(conversationId, (d) => {
    if (d.phone) setPh((x) => (digits(x).length === 11 ? x : phoneMask(d.phone!)));
    if (d.name) setName((n) => (n.trim() ? n : d.name!));
    setSource((x) => x || d.channel);
    if (d.ai) apply(d.draft, d.ai);
    else if (d.draft.description) setDescription((x) => x || d.draft.description!);
    if (d.text) setComment((c) => c || `Сообщение клиента: «${d.text.slice(0, 900)}»`);
    if (d.ai) toast("AI заполнил заявку по переписке — проверьте поля", "info");
  });

  // Пока форма была открыта, AI мог сам создать заявку из этого звонка — второй не нужно.
  const taken = !busy && callData?.lead ? callData.lead : null;

  const submit = async (asOrder: boolean) => {
    setError("");
    if (taken) return setError(`Из этого звонка уже создана заявка №${taken.number}`);
    if (!name.trim()) return setError("Укажите клиента");
    if (digits(ph).length !== 11) return setError("Укажите телефон полностью");
    if (!source || !serviceId || !city) return setError("Заполните источник, услугу и город");
    if (!description.trim()) return setError("Опишите, что требуется сделать");
    setBusy(true);
    const res = await createLead({
      clientId: client?.id,
      clientName: name,
      phone: ph,
      source,
      serviceId,
      city,
      description,
      urgency,
      comment,
      ai,
      callId,
      address: address.trim() || undefined,
      preferredTime: preferredTime.trim() || undefined,
      budget: digits(budget) ? Number(digits(budget)) : undefined,
      district: district || undefined,
    });
    if (!res.ok) return (setBusy(false), setError(res.error));
    if (conversationId) {
      const linked = await linkConversationLead(conversationId, res.value.id);
      if (!linked.ok) toast(`Заявка №${res.value.number} сохранена, но не связалась с перепиской: ${linked.error}`, "bad");
    }
    if (!asOrder) {
      toast(`Заявка №${res.value.number} сохранена`);
      close();
      return;
    }
    const o = await convertLead(res.value.id);
    setBusy(false);
    if (!o.ok) return setError(o.error);
    toast(`Заказ №${o.value.number} создан. Укажите цену и опубликуйте`);
    close();
    nav(`/orders/${o.value.id}`);
  };

  const aiPanel = chatBusy ? (
    <div className="flex items-start gap-3 rounded-[14px] border border-[#dccfff] bg-violet-bg/60 p-4" role="status">
      <span className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#d6c9ff] border-t-violet" />
      <div className="text-[14px] text-ink-2">
        <div className="font-semibold text-ink">Читаем переписку…</div>
        Номер, имя и суть обращения подставятся сами.
      </div>
    </div>
  ) : call?.aiStatus === "pending" ? (
      <div className="flex items-start gap-3 rounded-[14px] border border-[#dccfff] bg-violet-bg/60 p-4" role="status">
        <span className="mt-0.5 h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-[#d6c9ff] border-t-violet" />
        <div className="text-[14px] text-ink-2">
          <div className="font-semibold text-ink">AI слушает запись…</div>
          Обычно до минуты. Поля заполнятся сами — пока можно ввести телефон.
        </div>
      </div>
    ) : call?.aiStatus === "failed" ? (
      <div className="rounded-[14px] border border-[#ffd2da] bg-[#fff8f9] p-4 text-[14px] text-ink-2">
        <div className="font-semibold text-bad-ink">AI не смог разобрать запись</div>
        {call.aiError && <div className="mt-0.5">{call.aiError}</div>}
        <Button size="sm" variant="secondary" icon={RotateCw} className="mt-3" onClick={async () => void report(await reprocessCall(call.id))}>
          Попробовать ещё раз
        </Button>
      </div>
    ) : ai ? (
      <AiCard ai={ai} title={callId ? "AI-разбор звонка" : conversationId ? "AI-разбор переписки" : "AI-разбор сообщения"} compact />
    ) : pasting ? (
      <div className="rounded-[14px] border border-[#dccfff] bg-[linear-gradient(180deg,#f7f3ff,#fff)] p-4">
        <div className="mb-2 flex items-center gap-2 text-[14.5px] font-semibold text-ink">
          <Sparkles size={17} className="text-violet" aria-hidden /> Сообщение клиента
        </div>
        <Textarea rows={4} autoFocus aria-label="Сообщение клиента" placeholder="Вставьте переписку из WhatsApp, OLX или Instagram — AI разложит её по полям заявки" value={pasted} onChange={(e) => setPasted(e.target.value)} />
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setPasting(false)}>
            Отмена
          </Button>
          <Button size="sm" icon={Sparkles} disabled={aiBusy || pasted.trim().length < 5} onClick={() => void parsePasted()}>
            {aiBusy ? "AI читает…" : "Заполнить заявку"}
          </Button>
        </div>
      </div>
    ) : aiOn ? (
      <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-dashed border-[#d6c9ff] bg-[#faf8ff] px-3 py-2.5">
        <span className="mr-auto flex items-center gap-2 text-[13.5px] font-semibold text-ink">
          <Sparkles size={17} className="text-violet" aria-hidden /> Заполнить с AI
        </span>
        <button type="button" className={AI_CHIP} onClick={() => setPasting(true)}>
          Вставить переписку
        </button>
        {/* У звонка от АТС запись придёт сама — второй звонок из формы не создаём. */}
        {!callId && sttOn && (
          <>
            <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.ogg,.m4a,.amr" className="hidden" onChange={(e) => (e.target.files?.[0] && void uploadRecording(e.target.files[0]), (e.target.value = ""))} />
            <button type="button" className={AI_CHIP} disabled={aiBusy} onClick={() => fileRef.current?.click()}>
              {aiBusy ? "Загружаем…" : "Запись звонка"}
            </button>
          </>
        )}
      </div>
    ) : null;

  return (
    <form
      className="flex min-h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(mode === "order");
      }}
    >
      <div className="flex flex-col gap-5">
        {taken && (
          <div className="rounded-[12px] border border-brand-line bg-brand-soft px-4 py-3 text-[14px] text-ink-2">
            AI уже создал из этого звонка заявку №{taken.number}.{" "}
            <button type="button" className="font-semibold text-brand-ink" onClick={() => openLead({ leadId: taken.id })}>
              Открыть её
            </button>
          </div>
        )}
        {aiPanel}
        {call?.recordingSrc && (
          <SignedAudio controls preload="none" src={call.recordingSrc} className="h-10 w-full" aria-label="Запись звонка">
            <a href={call.recordingSrc}>Скачать запись</a>
          </SignedAudio>
        )}
        <FormRow label="Клиент" required>
          {(id) => (
            <div className="relative">
              <Input
                id={id}
                icon={UserIcon}
                placeholder="Выберите клиента или введите имя"
                value={name}
                autoComplete="off"
                onChange={(e) => {
                  setName(e.target.value);
                  setClient(undefined);
                  setSuggest(true);
                }}
                onFocus={() => setSuggest(true)}
                onBlur={() => setTimeout(() => setSuggest(false), 150)}
              />
              {client && <Badge tone="green" size="sm" className="absolute top-1/2 right-3 -translate-y-1/2">в базе</Badge>}
              {suggest && matches.length > 0 && (
                <div className="anim-pop absolute top-[calc(100%+6px)] right-0 left-0 z-10 rounded-[12px] border border-line bg-white p-1 shadow-[var(--shadow-pop)]">
                  {matches.map((c) => (
                    <button key={c.id} type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)} className="flex w-full items-center gap-3 rounded-[9px] px-2.5 py-2 text-left hover:bg-[#f7f4ec]">
                      <Avatar name={c.name} size={32} />
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-semibold text-ink">{c.name}</span>
                        <span className="text-[12.5px] text-muted">
                          {phone(c.phone)} · {c.city}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </FormRow>

        <FormRow
          label="Телефон"
          required
          hint={
            byPhone ? (
              <span>
                Этот номер уже в базе: <b className="text-ink">{byPhone.name}</b>.{" "}
                <button type="button" className="font-semibold text-brand-ink" onClick={() => pick(byPhone)}>
                  Подставить клиента
                </button>
              </span>
            ) : undefined
          }
        >
          {(id) => <PhoneInput id={id} value={ph} onChange={setPh} />}
        </FormRow>

        <div className="grid grid-cols-2 gap-3">
          <FormRow label="Источник" required>
            {(id) => <SourceSelect id={id} value={source} onChange={setSource} />}
          </FormRow>
          <FormRow label="Услуга" required>
            {(id) => <ServiceSelect id={id} value={serviceId} onChange={setServiceId} />}
          </FormRow>
        </div>

        <FormRow label="Город" required>
          {(id) => (
            <CitySelect
              id={id}
              value={city}
              onChange={(c) => {
                setCity(c);
                setDistrict("");
              }}
            />
          )}
        </FormRow>
        <DistrictField city={city} value={district} onChange={setDistrict} />

        <FormRow label="Описание" required>
          {(id) => (
            <>
              <Textarea id={id} rows={3} placeholder="Кратко опишите, что требуется сделать..." value={description} onChange={(e) => setDescription(e.target.value)} />
              {serviceId && !description && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {serviceById(serviceId).examples.map((ex) => (
                    <button key={ex} type="button" onClick={() => setDescription(ex)} className="rounded-[8px] bg-[#f4f2ec] px-2.5 py-1 text-[12.5px] text-ink-2 hover:bg-brand-soft">
                      {ex}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </FormRow>

        <div>
          <div className="mb-2 text-[14px] font-semibold text-ink">
            Срочность<span className="ml-0.5 text-bad">*</span>
          </div>
          <Segmented options={URGENCY_OPTIONS} value={urgency} onChange={setUrgency} />
        </div>

        <LeadDetailsFields
          address={address}
          preferredTime={preferredTime}
          budget={budget}
          onAddress={setAddress}
          onPreferredTime={setPreferredTime}
          onBudget={setBudget}
        />

        <FormRow label="Комментарий">
          {(id) => <Textarea id={id} rows={2} placeholder="Дополнительная информация (не обязательно)..." value={comment} onChange={(e) => setComment(e.target.value)} />}
        </FormRow>

        {error && <div className="rounded-[10px] bg-bad-bg px-3.5 py-2.5 text-[13.5px] font-medium text-bad-ink">{error}</div>}
      </div>

      <div className="sticky -bottom-6 -mx-6 -mb-6 mt-6 flex flex-wrap justify-end gap-2.5 border-t border-line bg-white px-6 pt-4 pb-6">
        <Button variant="secondary" className="border-line-strong bg-white text-ink-2" onClick={close}>
          Отмена
        </Button>
        <Button variant="soft" className="bg-brand-soft text-brand-ink" disabled={busy} onClick={() => void submit(false)}>
          Сохранить заявку
        </Button>
        <Button type="submit" disabled={busy} onClick={(e) => (e.preventDefault(), void submit(true))}>
          Создать заказ
        </Button>
      </div>
    </form>
  );
}

function LeadView({ id }: { id: string }) {
  const nav = useNavigate();
  const close = useUi((s) => s.closeLead);
  const team = useTeam();
  const me = useMe();
  const now = useNow();
  const data = useQuery(api.leads.get, { id: id as Id<"leads"> });
  const lead = data?.lead;
  const [draft, setDraft] = useState<Partial<Lead>>({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState(REJECT_REASONS[0]!);
  const [taking, setTaking] = useState(false);

  useEffect(() => setDraft({}), [id]);
  if (data === undefined) return <div className="py-10 text-center text-muted">Загружаем…</div>;
  if (!lead) return <div className="text-muted">Заявка не найдена</div>;
  const client = { id: lead.clientId, name: lead.clientName, phone: lead.clientPhone, city: lead.city };
  const order = data?.order ?? undefined;
  const badge = leadBadge(lead, order);
  const v = { ...lead, ...draft };
  const dirty = Object.keys(draft).length > 0;
  // Заявку, ставшую заказом или закрытую отказом, сервер не правит (E24) — и форма её не предлагает.
  const locked = lead.status === "converted" || lead.status === "rejected";
  // Бюджет стёрли — серверу нужен null, а не «нет поля».
  const patch = () => ({ ...draft, ...("budget" in draft ? { budget: draft.budget ?? null } : {}) });
  const take = async () => {
    setTaking(true);
    const ok = report(await takeLead(lead.id), `Заявка №${lead.number} в работе`);
    setTaking(false);
    return ok;
  };

  const toOrder = async () => {
    if (dirty && !report(await updateLead(lead.id, patch()))) return;
    const res = await convertLead(lead.id);
    if (!res.ok) return toast(res.error, "bad");
    toast(`Заказ №${res.value.number} создан. Укажите цену и опубликуйте`);
    close();
    nav(`/orders/${res.value.id}`);
  };

  return (
    <div className="flex min-h-full flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{badge.label}</Badge>
        <span className="text-[13.5px] text-muted">
          {dateTime(lead.createdAt)}
          {lead.origin && lead.origin !== "operator" && ` · ${LEAD_ORIGIN[lead.origin].label}`}
          {lead.operatorId && ` · ${team.userName(lead.operatorId).split(" ")[0]}`}
        </span>
      </div>

      {awaitsOperator(lead) && (
        <div className="flex flex-wrap items-center gap-3 rounded-[14px] border border-brand-line bg-brand-soft px-4 py-3">
          <div className="min-w-0 flex-1 text-[14px] text-ink-2">
            <div className="font-semibold text-ink">Заявка ждёт оператора</div>
            Пришла сама — её ещё никто не взял в работу.
          </div>
          <Button size="sm" icon={Hand} disabled={taking} onClick={() => void take()}>
            Взять в работу
          </Button>
        </div>
      )}

      <div className="rounded-[14px] border border-line p-4">
        <div className="flex items-center gap-3">
          <Avatar name={client.name} size={46} />
          <div className="min-w-0 flex-1">
            {me?.role === "manager" ? (
              <span className="block truncate text-[16px] font-semibold text-ink">{client.name}</span>
            ) : (
              <Link to={`/clients/${client.id}`} onClick={close} className="block truncate text-[16px] font-semibold text-ink hover:text-brand-ink">
                {client.name}
              </Link>
            )}
            <div className="text-[13.5px] text-muted">
              {phone(client.phone)} · {client.city}
            </div>
          </div>
          <a href={`tel:+${client.phone}`} className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-ok-bg text-ok-ink" aria-label="Позвонить">
            <Phone size={18} />
          </a>
          <a href={`https://wa.me/${client.phone}`} target="_blank" rel="noreferrer" className="inline-flex h-10 w-10 items-center justify-center rounded-[10px] bg-brand-soft text-brand-ink" aria-label="Написать в WhatsApp">
            <MessageCircle size={18} />
          </a>
        </div>
        <div className="mt-3 flex items-center gap-2 border-t border-line pt-3 text-[14px] text-ink-2">
          <span className="text-muted">Источник:</span>
          <Source source={lead.source} />
          <ConversationLink leadId={lead.id} onOpen={close} />
          {lead.callId && !lead.ai && me?.role !== "manager" && (
            <button onClick={() => (close(), nav(`/calls?open=${lead.callId}`))} className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-brand-ink hover:underline">
              <PhoneCall size={14} aria-hidden /> Звонок
            </button>
          )}
        </div>
      </div>

      {lead.ai && (
        <AiCard
          ai={lead.ai}
          title={lead.callId ? "AI-разбор звонка" : "AI-разбор обращения"}
          action={
            lead.callId && me?.role !== "manager" ? (
              <button onClick={() => (close(), nav(`/calls?open=${lead.callId}`))} className="inline-flex items-center gap-1 text-[13px] font-semibold text-violet hover:underline">
                <PhoneCall size={14} aria-hidden /> Звонок
              </button>
            ) : undefined
          }
        />
      )}

      <div className="grid grid-cols-2 gap-3">
        <FormRow label="Услуга">
          {(fid) => <ServiceSelect id={fid} value={v.serviceId} onChange={(serviceId) => setDraft((d) => ({ ...d, serviceId }))} />}
        </FormRow>
        <FormRow label="Город">
          {(fid) => <CitySelect id={fid} value={v.city} onChange={(city) => setDraft((d) => ({ ...d, city, district: "" }))} />}
        </FormRow>
      </div>
      <DistrictField city={v.city} value={v.district ?? ""} disabled={locked} onChange={(district) => setDraft((d) => ({ ...d, district }))} />
      <FormRow label="Описание">{(fid) => <Textarea id={fid} rows={3} value={v.description} disabled={locked} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} />}</FormRow>
      <div>
        <div className="mb-2 text-[14px] font-semibold text-ink">Срочность</div>
        <Segmented options={URGENCY_OPTIONS} value={v.urgency} onChange={(urgency) => setDraft((d) => ({ ...d, urgency }))} />
      </div>
      <LeadDetailsFields
        address={v.address ?? ""}
        preferredTime={v.preferredTime ?? ""}
        budget={v.budget ? String(v.budget) : ""}
        disabled={locked}
        onAddress={(address) => setDraft((d) => ({ ...d, address }))}
        onPreferredTime={(preferredTime) => setDraft((d) => ({ ...d, preferredTime }))}
        onBudget={(b) => setDraft((d) => ({ ...d, budget: digits(b) ? Number(digits(b)) : undefined }))}
      />
      {lead.comment && (
        <div className="rounded-[12px] bg-[#f8f6f1] px-4 py-3 text-[14px] text-ink-2">
          <span className="font-semibold text-ink">Комментарий: </span>
          {lead.comment}
        </div>
      )}
      {dirty && !locked && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setDraft({})}>
            Отменить
          </Button>
          <Button
            size="sm"
            onClick={async () => {
              if (report(await updateLead(lead.id, patch()), "Заявка обновлена")) setDraft({});
            }}
          >
            Сохранить изменения
          </Button>
        </div>
      )}

      {lead.status === "rejected" && (
        <div className="rounded-[12px] bg-slate-bg px-4 py-3 text-[14px] text-ink-2">
          Отказ: <b className="text-ink">{lead.rejectReason ?? "без причины"}</b>
        </div>
      )}

      {!locked && lead.status !== "rejected" && (
        <div>
          <div className="mb-2 text-[14px] font-semibold text-ink">Этап заявки</div>
          <div className="grid grid-cols-3 gap-2">
            {(["new", "qualifying", "waiting"] as const).map((s) => (
              <button
                key={s}
                onClick={async () => void report(await setLeadStatus(lead.id, s))}
                className={cn(
                  "h-10 rounded-[10px] border text-[13.5px] font-semibold transition-colors",
                  lead.status === s ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong text-ink-2 hover:border-brand-line",
                )}
              >
                {LEAD_STATUS[s].label}
              </button>
            ))}
          </div>
        </div>
      )}

      {rejecting && (
        <div className="rounded-[12px] border border-[#ffd2da] bg-[#fff8f9] p-4">
          <div className="mb-2 text-[14px] font-semibold text-ink">Причина отказа</div>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {REJECT_REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRejecting(false)}>
              Назад
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={async () => {
                if (report(await setLeadStatus(lead.id, "rejected", reason))) {
                  setRejecting(false);
                  toast(`Заявка №${lead.number} закрыта: ${reason.toLowerCase()}`, "info");
                }
              }}
            >
              Закрыть заявку
            </Button>
          </div>
        </div>
      )}

      {!order && !locked && (
        <div className="flex items-start gap-2.5 rounded-[12px] bg-[#f8f6f1] px-4 py-3 text-[13.5px] text-ink-2">
          <CalendarClock size={17} className="mt-0.5 shrink-0 text-muted" aria-hidden />
          <span>
            Срок заказа будет {dateTime(deadlineByUrgency(v.urgency, now))} — по срочности.
            {(v.preferredTime ?? "").trim() && (
              <>
                {" "}
                Клиенту удобно: <b className="text-ink">{v.preferredTime}</b> — при необходимости поправьте срок в заказе.
              </>
            )}
          </span>
        </div>
      )}

      <EntityHistory entity="lead" entityId={lead.id} />

      <div className="sticky -bottom-6 -mx-6 -mb-6 mt-auto flex flex-wrap justify-end gap-2.5 border-t border-line bg-white px-6 pt-4 pb-6">
        {order ? (
          <Button
            iconRight={ArrowRight}
            onClick={() => {
              close();
              nav(`/orders/${order.id}`);
            }}
          >
            Открыть заказ №{order.number}
          </Button>
        ) : lead.status === "rejected" ? (
          <Button variant="secondary" icon={Undo2} onClick={async () => void report(await setLeadStatus(lead.id, "qualifying"))}>
            Вернуть в работу
          </Button>
        ) : (
          <>
            {!rejecting && (
              <Button variant="danger" icon={Ban} onClick={() => setRejecting(true)}>
                Отказ
              </Button>
            )}
            <Button onClick={() => void toOrder()}>Создать заказ</Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Поля обращения (ТЗ п.8.3): адрес (перейдёт в заказ), когда клиенту удобно, бюджет (видят только сотрудники). */
function LeadDetailsFields(p: {
  address: string;
  preferredTime: string;
  budget: string;
  disabled?: boolean;
  onAddress: (v: string) => void;
  onPreferredTime: (v: string) => void;
  onBudget: (v: string) => void;
}) {
  return (
    <>
      <FormRow label="Адрес" hint="Перейдёт в заказ; мастер увидит его после подтверждения">
        {(fid) => <Input id={fid} icon={MapPin} placeholder="Улица, дом, квартира" value={p.address} disabled={p.disabled} onChange={(e) => p.onAddress(e.target.value)} />}
      </FormRow>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label="Когда удобно">
          {(fid) => <Input id={fid} placeholder="Например, завтра после 18:00" value={p.preferredTime} disabled={p.disabled} onChange={(e) => p.onPreferredTime(e.target.value)} />}
        </FormRow>
        <FormRow label="Бюджет клиента" hint={p.budget && digits(p.budget) ? money(Number(digits(p.budget))) : "Видят только сотрудники"}>
          {(fid) => <Input id={fid} inputMode="numeric" placeholder="₸" value={p.budget} disabled={p.disabled} onChange={(e) => p.onBudget(e.target.value.replace(/[^\d\s]/g, ""))} />}
        </FormRow>
      </div>
    </>
  );
}

// ── Клиент ───────────────────────────────────────────────────────────────────

export function ClientDrawer() {
  const { client, closeClient } = useUi();
  const existing = useQuery(api.clients.get, client.open && client.clientId ? { id: client.clientId as Id<"clients"> } : "skip");
  const waiting = !!client.clientId && existing === undefined;
  return (
    <Drawer open={client.open} onClose={closeClient} title={client.clientId ? "Редактировать клиента" : "Новый клиент"} width={480}>
      {client.open && !waiting && <ClientForm key={client.clientId ?? "new"} existing={existing ?? undefined} />}
    </Drawer>
  );
}

function ClientForm({ existing }: { existing?: Client }) {
  const nav = useNavigate();
  const close = useUi((s) => s.closeClient);
  const [kind, setKind] = useState<Client["kind"]>(existing?.kind ?? "person");
  const [name, setName] = useState(existing?.name ?? "");
  const [ph, setPh] = useState(existing ? phoneMask(existing.phone) : "");
  const [email, setEmail] = useState(existing?.email ?? "");
  const [city, setCity] = useState(existing?.city ?? "");
  const [address, setAddress] = useState(existing?.address ?? "");
  const [source, setSource] = useState<SourceId | "">(existing?.source ?? "");
  const [pref, setPref] = useState<SourceId | "">(existing?.preferredChannel ?? "");
  const [notes, setNotes] = useState(existing?.notes ?? "");
  const [error, setError] = useState("");

  const save = async () => {
    setError("");
    if (!name.trim()) return setError("Укажите имя или название компании");
    if (!city || !source) return setError("Укажите город и источник");
    const data = { name: name.trim(), kind, phone: ph, email: email.trim() || undefined, city, address: address.trim() || undefined, source, preferredChannel: pref || undefined, notes: notes.trim() || undefined };
    if (existing) {
      if (digits(ph).length !== 11) return setError("Укажите телефон полностью");
      const r = await updateClient(existing.id, { ...data, tags: existing.tags });
      if (!r.ok) return setError(r.error);
      toast("Клиент обновлён");
      close();
      return;
    }
    const res = await createClient(data);
    if (!res.ok) return setError(res.error);
    toast(`Клиент «${res.value.name}» добавлен`);
    close();
    nav(`/clients/${res.value.id}`);
  };

  return (
    <div className="flex min-h-full flex-col gap-5">
      <Segmented
        options={[
          { value: "person", label: "Частное лицо" },
          { value: "company", label: "Компания" },
        ]}
        value={kind}
        onChange={setKind}
      />
      <FormRow label={kind === "company" ? "Название компании" : "Имя и фамилия"} required>
        {(id) => <Input id={id} icon={UserIcon} value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "company" ? "ТОО «Название»" : "Айгерим Сапарова"} />}
      </FormRow>
      <FormRow label="Телефон" required>
        {(id) => <PhoneInput id={id} value={ph} onChange={setPh} />}
      </FormRow>
      <FormRow label="Email">{(id) => <Input id={id} icon={Mail} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@mail.kz" />}</FormRow>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label="Город" required>
          {(id) => <CitySelect id={id} value={city} onChange={setCity} />}
        </FormRow>
        <FormRow label="Источник" required>
          {(id) => <SourceSelect id={id} value={source} onChange={setSource} />}
        </FormRow>
      </div>
      <FormRow label="Адрес">{(id) => <Input id={id} icon={MapPin} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="ул. Абая, 125, кв. 45" />}</FormRow>
      <FormRow label="Как удобнее связываться">
        {(id) => (
          <Select id={id} value={pref} onChange={(e) => setPref(e.target.value as SourceId)}>
            <option value="">Не указано</option>
            {(["whatsapp", "phone", "telegram"] as SourceId[]).map((s) => (
              <option key={s} value={s}>
                {SOURCES[s].label}
              </option>
            ))}
          </Select>
        )}
      </FormRow>
      <FormRow label="Заметки">{(id) => <Textarea id={id} rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Например: удобно звонить после 18:00" />}</FormRow>
      {error && <div className="rounded-[10px] bg-bad-bg px-3.5 py-2.5 text-[13.5px] font-medium text-bad-ink">{error}</div>}
      <div className="sticky -bottom-6 -mx-6 -mb-6 mt-auto flex justify-end gap-2.5 border-t border-line bg-white px-6 pt-4 pb-6">
        <Button variant="secondary" className="border-line-strong bg-white text-ink-2" onClick={close}>
          Отмена
        </Button>
        <Button onClick={() => void save()}>{existing ? "Сохранить" : "Добавить клиента"}</Button>
      </div>
    </div>
  );
}

// ── Исполнитель ──────────────────────────────────────────────────────────────

export function ExecutorDrawer() {
  const { executor, closeExecutor } = useUi();
  return (
    <Drawer open={executor.open} onClose={closeExecutor} title={executor.executorId ? "Редактировать исполнителя" : "Новый исполнитель"} width={480}>
      {executor.open && <ExecutorForm key={executor.executorId ?? "new"} existingId={executor.executorId} />}
    </Drawer>
  );
}

function ExecutorForm({ existingId }: { existingId?: string }) {
  const nav = useNavigate();
  const close = useUi((s) => s.closeExecutor);
  const team = useTeam();
  const ex = team.executor(existingId);
  const [creds, setCreds] = useState<{ id: string; login: string; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(ex?.name ?? "");
  const [ph, setPh] = useState(ex ? phoneMask(ex.phone) : "");
  const [city, setCity] = useState(ex?.city ?? "");
  const [cats, setCats] = useState<CategoryId[]>(ex?.categories ?? []);
  const [skills, setSkills] = useState<string[]>(ex?.skills ?? []);
  const [coop, setCoop] = useState(ex?.cooperation ?? "freelance");
  const [districts, setDistricts] = useState<string[]>(ex?.districts ?? []);
  const [error, setError] = useState("");

  /** Сняли специализацию — уходят и навыки, которые были только в её справочнике. */
  const toggleCategory = (id: CategoryId) => {
    if (!cats.includes(id)) return setCats([...cats, id]);
    const rest = cats.filter((x) => x !== id);
    setCats(rest);
    setSkills((list) => withoutCategory(list, id, rest));
  };

  const save = async () => {
    setError("");
    if (!city) return setError("Укажите город");
    const checked = normalizeSkills(skills, SKILLS_PER_EXECUTOR);
    if (!checked.ok) return setError(checked.error);
    const data = { name: name.trim(), phone: ph, city, categories: cats, skills: checked.skills, cooperation: coop, districts };
    if (ex) {
      if (!cats.length) return setError("Выберите хотя бы одну специализацию");
      const r = await updateExecutor(ex.id, { ...data, phone: ex.phone });
      if (!r.ok) return setError(r.error);
      toast("Исполнитель обновлён");
      close();
      return;
    }
    setBusy(true);
    const res = await createExecutor(data);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setCreds(res.value);
  };

  // После создания — логин и временный пароль: их видно один раз, исполнителю их передают лично.
  if (creds)
    return (
      <div className="flex min-h-full flex-col gap-5">
        <div className="rounded-[14px] border border-[#bfeed5] bg-ok-bg/60 p-4 text-[14.5px] text-ink-2">
          <b className="text-ink">{name.trim()}</b> добавлен. Передайте ему данные для входа — пароль показывается один раз; при первом входе он придумает свой и увидит подходящие заказы.
        </div>
        <div className="rounded-[14px] border border-line p-4">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-ink">
            <KeyRound size={17} className="text-brand-ink" /> Вход в {APP_NAME}
          </div>
          <dl className="mt-3 space-y-2 text-[15px]">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Логин</dt>
              <dd className="font-semibold text-ink tabular-nums">{phone(creds.login)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Пароль</dt>
              <dd className="font-mono text-[16px] font-semibold tracking-wide text-ink">{creds.password}</dd>
            </div>
          </dl>
          <Button
            variant="secondary"
            size="sm"
            icon={Copy}
            className="mt-4"
            onClick={() => {
              void navigator.clipboard?.writeText(`${APP_NAME} — вход: ${window.location.origin}\nЛогин: ${creds.login}\nПароль: ${creds.password}`);
              toast("Скопировано — отправьте исполнителю", "info");
            }}
          >
            Скопировать для отправки
          </Button>
        </div>
        <div className="sticky -bottom-6 -mx-6 -mb-6 mt-auto flex justify-end gap-2.5 border-t border-line bg-white px-6 pt-4 pb-6">
          <Button
            onClick={() => {
              close();
              nav(`/executors/${creds.id}`);
            }}
          >
            Готово
          </Button>
        </div>
      </div>
    );

  return (
    <div className="flex min-h-full flex-col gap-5">
      <FormRow label="ФИО" required>
        {(id) => <Input id={id} icon={UserIcon} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ерлан Ахметов" />}
      </FormRow>
      <div className="grid grid-cols-2 gap-3">
        <FormRow label="Телефон" required>
          {(id) => (ex ? <Input id={id} icon={Phone} value={phone(ex.phone)} disabled title="Телефон — это логин, его меняет владелец" /> : <PhoneInput id={id} value={ph} onChange={setPh} />)}
        </FormRow>
        <FormRow label="Город" required>
          {(id) => (
            <CitySelect
              id={id}
              value={city}
              onChange={(c) => {
                setCity(c);
                if (c !== city) setDistricts([]);
              }}
            />
          )}
        </FormRow>
      </div>
      <DistrictPicker city={city} value={districts} onChange={setDistricts} />
      <div>
        <div className="mb-2 text-[14px] font-semibold text-ink">
          Специализации<span className="ml-0.5 text-bad">*</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {CATEGORIES.filter((c) => c.active !== false || cats.includes(c.id)).map((c) => {
            const on = cats.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => toggleCategory(c.id)}
                className={cn("rounded-[10px] border px-3 py-2 text-[13.5px] font-medium transition-colors", on ? "border-brand bg-brand-soft text-brand-ink" : "border-line-strong text-ink-2 hover:border-brand-line")}
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <div className="mt-1.5 text-[12.5px] text-muted">По специализации, навыкам и городу исполнитель видит заказы в ленте.</div>
      </div>
      <div>
        <div className="mb-1 text-[14px] font-semibold text-ink">Навыки</div>
        <p className="mb-2.5 text-[12.5px] text-muted">Заказ, где нужен навык, увидят только исполнители, у которых он отмечен.</p>
        <ExecutorSkillsField categories={cats} value={skills} onChange={setSkills} />
      </div>
      <div>
        <div className="mb-2 text-[14px] font-semibold text-ink">Тип сотрудничества</div>
        <Segmented
          options={[
            { value: "freelance", label: "Фрилансер" },
            { value: "staff", label: "В штате" },
          ]}
          value={coop}
          onChange={setCoop}
        />
      </div>
      {error && <div className="rounded-[10px] bg-bad-bg px-3.5 py-2.5 text-[13.5px] font-medium text-bad-ink">{error}</div>}
      <div className="sticky -bottom-6 -mx-6 -mb-6 mt-auto flex justify-end gap-2.5 border-t border-line bg-white px-6 pt-4 pb-6">
        <Button variant="secondary" className="border-line-strong bg-white text-ink-2" onClick={close}>
          Отмена
        </Button>
        <Button disabled={busy} onClick={() => void save()}>{ex ? "Сохранить" : busy ? "Создаём…" : "Добавить исполнителя"}</Button>
      </div>
    </div>
  );
}

