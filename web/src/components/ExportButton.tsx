// «Выгрузка» (ТЗ п.26.9): CSV за выбранный период собирает сервер — все записи, а не только загруженные на экран.
// Кнопка — по праву «Выгрузка в Excel» и только с теми выгрузками, на данные которых есть права (src/data/exportAccess.ts).
import { Download } from "lucide-react";
import { useState } from "react";
import { createExport, downloadFile, exportedText } from "../data/exportActions";
import { almatyDay, EXPORT_KIND, exportRange, PERIOD_PRESETS, type ExportKind, type PeriodPreset } from "../data/exports";
import { exportAllowed } from "../data/exportAccess";
import { useMe } from "../data/hooks";
import { report, toast } from "../data/store";
import { cn } from "../lib/format";
import { Button, FormRow, Input, Modal, Select } from "./ui";

/** Высота — как у соседних кнопок в шапке экрана. */
const HEIGHT = { 44: "h-11", 46: "h-[46px]", 50: "h-[50px] text-[15px]" } as const;

/** kinds — что можно выгрузить с этого экрана; первое — по умолчанию. */
export function ExportButton({ kinds, label = "Выгрузка", height = 46 }: { kinds: readonly [ExportKind, ...ExportKind[]]; label?: string; height?: keyof typeof HEIGHT }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const allowed = kinds.filter((k) => exportAllowed(me, k));
  if (!allowed.length) return null;
  return (
    <>
      <Button variant="secondary" icon={Download} className={cn("bg-white", HEIGHT[height])} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && <ExportModal kinds={allowed as [ExportKind, ...ExportKind[]]} onClose={() => setOpen(false)} />}
    </>
  );
}

function ExportModal({ kinds, onClose }: { kinds: readonly [ExportKind, ...ExportKind[]]; onClose: () => void }) {
  const today = almatyDay(Date.now());
  const [kind, setKind] = useState<ExportKind>(kinds[0]);
  const [preset, setPreset] = useState<PeriodPreset>("month");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const range = exportRange(preset, Date.now(), { from, to });
    if (!range) return toast("Укажите даты периода: «с» — не позже «по»", "bad");
    setBusy(true);
    const r = await createExport({ kind, ...range });
    setBusy(false);
    if (!report(r)) return;
    downloadFile(r.value.url);
    toast(exportedText(r.value.rows, r.value.truncated), r.value.truncated ? "info" : "ok");
    onClose();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={EXPORT_KIND[kind].ext ? "Выгрузка" : "Выгрузка в CSV"}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button icon={Download} disabled={busy} onClick={() => void submit()}>
            {busy ? "Готовим файл…" : `Скачать ${(EXPORT_KIND[kind].ext ?? "csv").toUpperCase()}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {kinds.length > 1 && (
          <FormRow label="Что выгрузить">
            {(id) => (
              <Select id={id} value={kind} onChange={(e) => setKind(e.target.value as ExportKind)}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {EXPORT_KIND[k].label}
                  </option>
                ))}
              </Select>
            )}
          </FormRow>
        )}
        <FormRow label="Период" hint={`${EXPORT_KIND[kind].label}: ${EXPORT_KIND[kind].period}`}>
          {(id) => (
            <Select id={id} value={preset} onChange={(e) => setPreset(e.target.value as PeriodPreset)}>
              {PERIOD_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </FormRow>
        {preset === "custom" && (
          <div className="grid grid-cols-2 gap-3">
            <FormRow label="С">{(id) => <Input id={id} type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} />}</FormRow>
            <FormRow label="По">{(id) => <Input id={id} type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />}</FormRow>
          </div>
        )}
        <p className="text-[13px] leading-snug text-muted">
          {EXPORT_KIND[kind].ext ? "Файл XML (UTF-8) для загрузки в 1С." : kind === "accounting" ? "Для 1С и Excel: кодировка UTF-8 с BOM, разделитель «;», даты — ДД.ММ.ГГГГ." : "Файл открывается в Excel: кодировка UTF-8, разделитель «;»."} Скачивание начнётся сразу; ссылка действует 15 минут, файл хранится на сервере сутки. Выгрузка записывается в журнал действий.
        </p>
      </div>
    </Modal>
  );
}
