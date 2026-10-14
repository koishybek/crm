// Надёжность в «Настройках» владельца: внешнее хранилище копий (ТЗ п.20.10, п.26.5), ошибки интерфейса
// в «Состоянии системы» (п.26.5) и срок хранения записей звонков (п.26.4). Монтируются из SystemCards.tsx.
import { useQuery } from "convex/react";
import { Archive, CloudUpload, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { OFFSITE_STEPS } from "../data/offsite";
import { saveRetention, setOffsiteFiles } from "../data/reliabilityActions";
import { RETENTION_MAX_DAYS, retentionLabel, retentionProblem } from "../data/retention";
import { report } from "../data/store";
import { Badge, Button, Card, Input, Loading, Toggle } from "../components/ui";
import { dateTime, plural } from "../lib/format";

// ── Внешнее хранилище (внутри карточки «Резервные копии») ───────────────────

export function OffsitePanel() {
  const s = useQuery(api.offsite.status);
  const [busy, setBusy] = useState(false);
  if (s === undefined) return null;
  const failing = !!s.health?.errorAt && (!s.health.okAt || s.health.errorAt >= s.health.okAt);
  return (
    <div className="mt-4 rounded-[12px] border border-line p-3">
      <div className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-ink">
        <CloudUpload size={17} className="text-muted" aria-hidden /> Внешнее хранилище
        {s.configured ? (
          <Badge tone={failing ? "red" : "green"} size="sm">
            {failing ? "Сбой" : "Подключено"}
          </Badge>
        ) : (
          <Badge tone="gray" size="sm">
            Не подключено
          </Badge>
        )}
      </div>
      {!s.configured ? (
        <>
          <p className="mt-1 text-[13px] text-ink-2">Внешнее хранилище не подключено — копии лежат только в том же облаке, что и система. Чтобы копия пережила потерю облака:</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[13px] text-ink-2">
            {OFFSITE_STEPS.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ol>
          {s.missing.length > 0 && <p className="mt-2 text-[12.5px] break-words text-muted">Не заданы: {s.missing.join(", ")}</p>}
        </>
      ) : (
        <>
          <p className="mt-1 text-[13px] break-words text-ink-2">
            После каждой ночной копии та же копия уходит в {s.host} (бакет {s.bucket}). Там храним {s.keep} последних.
          </p>
          {failing && s.health?.error && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[13px] text-bad-ink">
              <TriangleAlert size={15} className="mt-0.5 shrink-0" aria-hidden />
              <span className="min-w-0 break-words">
                {s.health.error} · {dateTime(s.health.errorAt!)}
              </span>
            </p>
          )}
          {s.health?.okAt && (
            <p className="mt-1 text-[12.5px] text-muted">
              Последняя выгрузка: {dateTime(s.health.okAt)}
              {s.health.okNote ? ` · ${s.health.okNote}` : ""}
            </p>
          )}
          <div className="mt-2.5">
            <Toggle
              checked={s.copyFiles}
              label="Копировать и файлы — записи звонков, фото, вложения"
              onChange={async (on) => {
                if (busy) return;
                setBusy(true);
                report(await setOffsiteFiles(on), on ? "Файлы будут копироваться каждую ночь" : "Копирование файлов выключено");
                setBusy(false);
              }}
            />
            <p className="mt-1 text-[12.5px] text-muted">Каждый файл копируется один раз; удалённые у нас (по сроку хранения или по просьбе клиента) удаляются и там. Объём хранилища растёт — за него платит владелец хранилища.</p>
          </div>
        </>
      )}
    </div>
  );
}

// ── Ошибки интерфейса (внутри «Состояния системы») ──────────────────────────

export function ClientErrorsList() {
  const rows = useQuery(api.clientErrors.recent);
  if (!rows) return null;
  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="text-[14px] font-semibold text-ink">Ошибки в интерфейсе</div>
      {rows.length === 0 ? (
        <p className="mt-1 text-[13px] text-muted">За последние две недели ошибок не было.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="py-2">
              <div className="text-[13px] font-medium break-words text-ink">{r.message}</div>
              <div className="text-[12.5px] break-words text-muted">
                {r.path} · сборка {r.build} · {dateTime(r.lastAt)}
                {r.count > 1 ? ` · ${r.count} ${plural(r.count, "раз", "раза", "раз")}` : ""}
                {r.role ? ` · ${r.role === "executor" ? "у мастера" : "у сотрудника"}` : ""}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-[12.5px] text-muted">Без данных людей: только текст ошибки, экран и версия сборки. Одинаковые за сутки — одной строкой.</p>
    </div>
  );
}

// ── Срок хранения записей звонков ────────────────────────────────────────────

const isDays = (s: string): boolean => /^\d+$/.test(s.trim());

export function RetentionCard() {
  const s = useQuery(api.retention.settings);
  const [draft, setDraft] = useState<{ rec: string; tr: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (s === undefined) {
    return (
      <Card icon={Archive} title="Хранение записей звонков">
        <Loading className="py-6" />
      </Card>
    );
  }
  const d = draft ?? { rec: String(s.recordingsDays), tr: String(s.transcriptsDays) };
  const rec = Number(d.rec);
  const tr = Number(d.tr);
  const problem = draft ? (isDays(d.rec) && isDays(d.tr) ? (retentionProblem(rec) ?? retentionProblem(tr)) : retentionProblem(NaN)) : null;
  const changed = draft !== null && (rec !== s.recordingsDays || tr !== s.transcriptsDays);
  const save = async () => {
    setBusy(true);
    const ok = report(await saveRetention(rec, tr), "Сроки хранения сохранены");
    setBusy(false);
    if (ok) setDraft(null);
  };
  const field = (key: "rec" | "tr", label: string) => (
    <label className="flex items-center justify-between gap-3 text-[14px] text-ink-2">
      <span className="min-w-0">{label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <Input type="number" inputMode="numeric" min={0} max={RETENTION_MAX_DAYS} value={d[key]} onChange={(e) => setDraft({ ...d, [key]: e.target.value })} className="w-24" />
        дней
      </span>
    </label>
  );
  return (
    <Card icon={Archive} title="Хранение записей звонков">
      <p className="text-[13.5px] text-muted">
        Записи разговоров и расшифровки старше срока система удаляет сама раз в сутки, ночью, и пишет об этом в журнал. Звонок, AI-резюме и заявка остаются. 0 — хранить бессрочно.
      </p>
      <div className="mt-3 space-y-2">
        {field("rec", "Хранить записи звонков")}
        {field("tr", "Хранить расшифровки")}
      </div>
      {problem && <p className="mt-1.5 text-[12.5px] text-bad-ink">{problem}</p>}
      <p className="mt-2 text-[12.5px] text-muted">
        Сейчас: записи — {retentionLabel(s.recordingsDays)}, расшифровки — {retentionLabel(s.transcriptsDays)}.
      </p>
      {changed && (
        <Button size="sm" className="mt-3" disabled={!!problem || busy} onClick={() => void save()}>
          Сохранить
        </Button>
      )}
    </Card>
  );
}
