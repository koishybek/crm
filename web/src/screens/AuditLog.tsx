// «Журнал действий» владельца (ТЗ п.20 «Audit Log», п.26, п.27): кто, что и когда сделал — с фильтрами и выгрузкой.
import { CalendarDays, Download, Filter, ScrollText, Search, Shapes, UserRound } from "lucide-react";
import { usePaginatedQuery } from "convex/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AuditObjectLink, AuditWho } from "../components/AuditHistory";
import { Button, EmptyState, Input, Loading, PageHeader, Select } from "../components/ui";
import { AUDIT_ENTITIES, AUDIT_ENTITY, AUDIT_QUERY_MAX } from "../data/audit";
import type { AuditFilters } from "../data/auditLog";
import { createExport, downloadFile, exportedText } from "../data/exportActions";
import { ROLE_LABEL } from "../data/catalog";
import { useNow, useTeam } from "../data/hooks";
import { rangeOf } from "../data/metrics";
import { report, toast } from "../data/store";
import type { AuditEntity, AuditEntry, Role } from "../data/types";
import { date, dateTime, dayDiff, hm, num, plural } from "../lib/format";

type Period = "today" | "7d" | "30d" | "90d" | "all";
const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "Сегодня" },
  { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" },
  { id: "90d", label: "90 дней" },
  { id: "all", label: "За всё время" },
];
const PAGE = 50;
/** Поиск по тексту отбирает строки после чтения страницы: если совпадений мало, дочитываем сами — не больше 5 страниц за раз. */
const AUTO_PAGES = 5;
const STAFF_ORDER: Role[] = ["owner", "operator", "manager", "executor"];
const FIELD = "[&_input]:h-[48px] [&_input]:border-line [&_select]:h-[48px] [&_select]:border-line";
/** «За всё время» в выгрузке — с начала работы системы. */
const ALL_TIME = "2020-01-01T00:00:00.000Z";

export default function AuditLog() {
  const team = useTeam();
  const now = useNow(60_000);
  const [period, setPeriod] = useState<Period>("7d");
  const [actor, setActor] = useState("");
  const [entity, setEntity] = useState<AuditEntity | "">("");
  const [q, setQ] = useState("");
  const [dq, setDq] = useState("");
  const [exporting, setExporting] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setDq(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Начало периода меняется только в полночь — пока день тот же, аргументы запроса не меняются и список не сбрасывается.
  const from = period === "all" ? undefined : new Date(rangeOf(period, now).cur.from).toISOString();
  const filters = useMemo<AuditFilters>(
    () => ({ from, actorId: actor === "system" ? "system" : actor ? (actor as Id<"users">) : undefined, entity: entity || undefined, q: dq || undefined }),
    [from, actor, entity, dq],
  );
  const { results, status, loadMore } = usePaginatedQuery(api.audit.list, filters, { initialNumItems: PAGE });

  const [want, setWant] = useState(PAGE);
  const autoPages = useRef(0);
  const filtersKey = JSON.stringify(filters);
  useEffect(() => {
    setWant(PAGE);
    autoPages.current = 0;
  }, [filtersKey]);
  useEffect(() => {
    if (status === "CanLoadMore" && results.length < want && autoPages.current < AUTO_PAGES) {
      autoPages.current += 1;
      loadMore(PAGE);
    }
  }, [status, results.length, want, loadMore]);
  const more = () => {
    autoPages.current = 0;
    setWant(results.length + PAGE);
  };

  const people = useMemo(
    () =>
      [...team.users].sort((a, b) => STAFF_ORDER.indexOf(a.role) - STAFF_ORDER.indexOf(b.role) || a.name.localeCompare(b.name, "ru")),
    [team.users],
  );
  const days = useMemo(() => {
    const out: { key: string; label: string; rows: AuditEntry[] }[] = [];
    for (const e of results) {
      const d = new Date(e.at);
      const key = d.toDateString();
      const diff = dayDiff(d, new Date(now));
      const label = diff === 0 ? "Сегодня" : diff === -1 ? "Вчера" : date(e.at);
      const last = out[out.length - 1];
      if (last?.key === key) last.rows.push(e);
      else out.push({ key, label, rows: [e] });
    }
    return out;
  }, [results, now]);

  const filtered = period !== "7d" || actor || entity || q;
  const reset = () => {
    setPeriod("7d");
    setActor("");
    setEntity("");
    setQ("");
  };

  // Файл собирает сервер по тем же фильтрам (ТЗ п.26.9): все записи периода, ссылка — подписанная, выгрузка — в журнале.
  const exportAll = async () => {
    setExporting(true);
    const r = await createExport({ kind: "audit", from: filters.from ?? ALL_TIME, to: new Date().toISOString(), actorId: filters.actorId, entity: filters.entity, q: filters.q });
    setExporting(false);
    if (!report(r)) return;
    downloadFile(r.value.url);
    toast(exportedText(r.value.rows, r.value.truncated), r.value.truncated ? "info" : "ok");
  };

  return (
    <>
      <PageHeader
        title="Журнал действий"
        subtitle="Кто, что и когда сделал: заявки, заказы, деньги, доступы и справочник"
        actions={
          <Button variant="secondary" icon={Download} className="h-[46px]" disabled={exporting || !results.length} onClick={() => void exportAll()}>
            {exporting ? "Готовим файл…" : "Экспорт"}
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto]">
        <Select icon={CalendarDays} aria-label="Период" value={period} onChange={(e) => setPeriod(e.target.value as Period)} className={FIELD}>
          {PERIODS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </Select>
        <Select icon={UserRound} aria-label="Сотрудник" value={actor} onChange={(e) => setActor(e.target.value)} className={FIELD}>
          <option value="">Все сотрудники</option>
          <option value="system">Система, AI и каналы</option>
          {people.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} — {ROLE_LABEL[u.role]}
              {u.active ? "" : " (отключён)"}
            </option>
          ))}
        </Select>
        <Select icon={Shapes} aria-label="Тип объекта" value={entity} onChange={(e) => setEntity(e.target.value as AuditEntity | "")} className={FIELD}>
          <option value="">Все объекты</option>
          {AUDIT_ENTITIES.map((x) => (
            <option key={x} value={x}>
              {AUDIT_ENTITY[x].many}
            </option>
          ))}
        </Select>
        <Input
          icon={Search}
          aria-label="Поиск по описанию"
          placeholder="Поиск: №1024, имя, «отмена»…"
          maxLength={AUDIT_QUERY_MAX}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className={FIELD}
        />
        <Button variant="soft" icon={Filter} className="h-[48px]" disabled={!filtered} onClick={reset}>
          Сбросить
        </Button>
      </div>

      <div className="card mt-4 p-3 sm:p-4">
        {status === "LoadingFirstPage" ? (
          <Loading />
        ) : results.length === 0 && status !== "CanLoadMore" && status !== "LoadingMore" ? (
          <EmptyState icon={ScrollText} title="Записей нет" text={filtered ? "Измените период или фильтры." : "Здесь появятся действия сотрудников, системы и каналов."} />
        ) : (
          <>
            {days.map((d) => (
              <section key={d.key} aria-label={d.label}>
                <h2 className="px-1 pt-3 pb-1 text-[12.5px] font-semibold tracking-[0.04em] text-muted uppercase first:pt-1">{d.label}</h2>
                <ol className="divide-y divide-line">
                  {d.rows.map((e) => (
                    <li key={e.id} className="flex min-w-0 flex-col gap-2 px-1 py-3 md:flex-row md:items-center md:gap-4">
                      <div className="flex min-w-0 items-center justify-between gap-3 md:w-[290px] md:shrink-0 md:justify-start md:gap-4">
                        <time dateTime={e.at} title={dateTime(e.at)} className="order-2 shrink-0 text-[13px] text-muted tabular-nums md:order-1 md:w-[42px]">
                          {hm(new Date(e.at))}
                        </time>
                        <span className="order-1 min-w-0 md:order-2">
                          <AuditWho entry={e} />
                        </span>
                      </div>
                      <p className="min-w-0 flex-1 text-[14.5px] leading-snug text-ink [overflow-wrap:anywhere]">{e.summary}</p>
                      <AuditObjectLink entry={e} className="self-start md:self-center" />
                    </li>
                  ))}
                </ol>
              </section>
            ))}
            {results.length === 0 && (
              <div className="px-1 py-6 text-center text-[14px] text-muted">
                {status === "LoadingMore" ? "Ищем совпадения в более старых записях…" : "В просмотренных записях совпадений нет — «Загрузить ещё» продолжит поиск"}
              </div>
            )}
            <div className="flex flex-col items-center gap-2 border-t border-line pt-4 sm:flex-row sm:justify-between">
              <span className="text-[13.5px] text-muted">
                Показано {num(results.length)} {plural(results.length, "запись", "записи", "записей")}
                {status === "Exhausted" ? "" : " — есть ещё"}
              </span>
              {status !== "Exhausted" && (
                <Button variant="secondary" size="sm" disabled={status !== "CanLoadMore"} onClick={more} className="w-full sm:w-auto">
                  {status === "CanLoadMore" ? "Загрузить ещё" : "Загружаем…"}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
