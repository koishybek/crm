// Карточки владельца в «Настройках»: состояние системы (ТЗ п.20 «мониторинг»), резервные копии (п.20, п.26)
// и автораспределение заказов — «AI-подбор» (п.23).
import { useQuery } from "convex/react";
import { Activity, DatabaseBackup, Download, Shuffle, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import { AUTO_ASSIGN, AUTO_ASSIGN_RULES } from "../data/autoAssign";
import { useFileQuery } from "../data/files";
import { useMe, useNow } from "../data/hooks";
import { report } from "../data/store";
import { backupNow, saveAutoAssign } from "../data/systemActions";
import { fileSize, HEALTH_STATE, systemViews, type HealthState, type SubsystemView } from "../data/systemHealth";
import { Badge, Button, Card, DotBadge, Input, Loading, Toggle } from "../components/ui";
import { cn, dateTime, plural } from "../lib/format";

/** Только владелец: остальным эти карточки не показываем (и сервер им ничего не отдаст). */
export function SystemCards() {
  const me = useMe();
  if (me?.role !== "owner") return null;
  return (
    <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
      <SystemHealthCard />
      <div className="flex min-w-0 flex-col gap-4">
        <BackupsCard />
        <AutoAssignCard />
      </div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-[10px] bg-bad-bg px-3 py-2.5 text-[13px] text-bad-ink">
      <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </div>
  );
}

// ── Состояние системы ────────────────────────────────────────────────────────

const DETAIL_TONE: Record<HealthState, string> = { ok: "text-ink-2", warn: "text-warn-ink", bad: "text-bad-ink", off: "text-muted" };

function SystemHealthCard() {
  const o = useQuery(api.health.overview);
  const now = useNow(60_000);
  const views = o ? systemViews(o, now) : [];
  const bad = views.filter((v) => v.state === "bad").length;
  const warn = views.filter((v) => v.state === "warn").length;
  const summary = bad ? { tone: "red" as const, text: `Сбоев: ${bad}` } : warn ? { tone: "amber" as const, text: `Требует внимания: ${warn}` } : { tone: "green" as const, text: "Всё работает" };
  return (
    <Card icon={Activity} title="Состояние системы" titleExtra={o ? <Badge tone={summary.tone} size="sm">{summary.text}</Badge> : undefined}>
      {o === undefined ? (
        <Loading className="py-6" />
      ) : (
        <ul className="divide-y divide-line">
          {views.map((v) => (
            <SubsystemRow key={v.key} v={v} />
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12.5px] text-muted">Красное — не работает сейчас, жёлтое — работает не полностью или ещё не запускалось, серое — не подключено. Обновляется само.</p>
    </Card>
  );
}

function SubsystemRow({ v }: { v: SubsystemView }) {
  const st = HEALTH_STATE[v.state];
  // Ошибку, из-за которой подсистема красная, уже видно в главной строке — второй раз не повторяем.
  const pastError = v.errorAt && v.error && v.error !== v.detail ? `${v.error} · ${dateTime(v.errorAt)}` : null;
  return (
    <li className="flex items-start gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-semibold text-ink">{v.label}</div>
        <div className={cn("text-[13px] break-words", DETAIL_TONE[v.state])}>{v.detail}</div>
        {(v.okAt || pastError) && (
          <div className="mt-0.5 text-[12.5px] text-muted">
            {v.okAt && <span>Последний успех: {dateTime(v.okAt)}</span>}
            {v.okAt && pastError && " · "}
            {pastError && <span>Последняя ошибка: {pastError}</span>}
          </div>
        )}
      </div>
      <DotBadge tone={st.tone}>{st.label}</DotBadge>
    </li>
  );
}

// ── Резервные копии ──────────────────────────────────────────────────────────

function BackupsCard() {
  const b = useFileQuery(api.backup.list, {});
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    report(await backupNow(), "Копия создаётся — появится в списке через минуту");
    setBusy(false);
  };
  return (
    <Card
      icon={DatabaseBackup}
      title="Резервные копии"
      action={
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void start()}>
          Сделать копию
        </Button>
      }
    >
      <p className="text-[13.5px] text-muted">
        Каждую ночь в 02:00 система сохраняет копию всех данных: клиенты, заявки, заказы, деньги, переписка, журнал действий. Пароли, ключи и токены интеграций в копию не попадают. Храним {b?.keep ?? 14}{" "}
        последних.
      </p>
      {b === undefined ? (
        <Loading className="py-6" />
      ) : (
        <>
          {b.lastError && (
            <Notice>
              Последняя копия не создана: {b.lastError.text} · {dateTime(b.lastError.at)}
            </Notice>
          )}
          {b.items.length === 0 ? (
            <div className="py-5 text-center text-[14px] text-muted">Копий ещё нет — первая появится ночью, или сделайте её сейчас</div>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {b.items.map((x) => (
                <li key={x.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
                      {dateTime(x.at)}
                      {x.manual && (
                        <Badge tone="gray" size="sm">
                          вручную
                        </Badge>
                      )}
                    </div>
                    <div className="text-[12.5px] text-muted">
                      {fileSize(x.size)} · {x.docs} {plural(x.docs, "запись", "записи", "записей")}
                    </div>
                  </div>
                  {x.url && (
                    <a href={x.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1.5 text-[13.5px] font-semibold text-brand-ink hover:underline">
                      <Download size={15} aria-hidden /> Скачать
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p className="mt-3 text-[12.5px] text-muted">Копии лежат в том же облаке, что и система. Раз в неделю скачивайте свежую и храните отдельно — на случай, если пропадёт доступ к облаку.</p>
    </Card>
  );
}

// ── Автораспределение ────────────────────────────────────────────────────────

function AutoAssignCard() {
  const s = useQuery(api.autoAssign.settings);
  // Пока владелец правит минуты — черновик; null — показываем сохранённое значение.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (s === undefined) {
    return (
      <Card icon={Shuffle} title="Автораспределение заказов">
        <Loading className="py-6" />
      </Card>
    );
  }
  const value = draft ?? String(s.minutes);
  const typed = Number(value);
  const valid = /^\d+$/.test(value) && typed >= AUTO_ASSIGN.min && typed <= AUTO_ASSIGN.max;
  const changed = draft !== null && typed !== s.minutes;

  const save = async (enabled: boolean, minutes: number) => {
    setBusy(true);
    const ok = report(await saveAutoAssign(enabled, minutes), enabled === s.enabled ? "Сохранено" : enabled ? "Автораспределение включено" : "Автораспределение выключено");
    setBusy(false);
    if (ok) setDraft(null);
  };

  return (
    <Card
      icon={Shuffle}
      title="Автораспределение заказов"
      titleExtra={
        <Badge tone="violet" size="sm">
          AI-подбор
        </Badge>
      }
    >
      <p className="text-[13.5px] text-muted">
        Заказ {s.minutes} мин лежит в ленте и его никто не взял — система сама назначит лучшего подходящего мастера и пришлёт заказ с кнопками «Подтвердить / Отказаться». Выключено — заказы назначают только люди.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Toggle checked={s.enabled} onChange={(on) => !busy && void save(on, valid ? typed : s.minutes)} label={s.enabled ? "Включено" : "Выключено"} />
        <label className="flex items-center gap-2 text-[14px] text-ink-2">
          Ждать
          <Input
            type="number"
            inputMode="numeric"
            min={AUTO_ASSIGN.min}
            max={AUTO_ASSIGN.max}
            step={5}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && changed && valid && !busy && void save(s.enabled, typed)}
            className="w-24"
          />
          мин
        </label>
        {changed && (
          <Button size="sm" disabled={!valid || busy} onClick={() => void save(s.enabled, typed)}>
            Сохранить
          </Button>
        )}
      </div>
      {draft !== null && !valid && (
        <p className="mt-1.5 text-[12.5px] text-bad-ink">
          От {AUTO_ASSIGN.min} до {AUTO_ASSIGN.max} минут
        </p>
      )}
      <p className="mt-1.5 text-[12.5px] text-muted">Столько же заказ ждёт в ленте и столько же мастер думает над назначением.</p>
      <ul className="mt-3 space-y-1.5 text-[13.5px] text-ink-2">
        {AUTO_ASSIGN_RULES.map((t) => (
          <li key={t} className="flex items-start gap-2">
            <span className="mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full bg-violet" />
            {t}
          </li>
        ))}
      </ul>
    </Card>
  );
}
