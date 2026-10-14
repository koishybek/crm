// «Рекомендация AI» в окне назначения (ТЗ п.12.7, п.23.1): AI предлагает порядок среди подходящих по правилам
// мастеров и коротко объясняет, назначает человек. AI выключен владельцем, не подключён или не ответил —
// рекомендация по правилам с объяснением (её возвращает сервер, convex/aiMatch.ts).
import { useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { AiMatchResult } from "../data/aiMatch";
import { askAiMatch } from "../data/matchActions";
import { toast } from "../data/store";
import { money } from "../lib/format";
import { Badge, Button } from "./ui";

export function AiMatchPanel({ orderId, disabled, onPick }: { orderId: string; disabled?: boolean; onPick: (executorId: string) => void }) {
  const s = useQuery(api.aiMatch.settings);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AiMatchResult | null>(null);
  const aiOn = !!s?.enabled && !!s.connected;

  const ask = async () => {
    setBusy(true);
    const r = await askAiMatch(orderId);
    setBusy(false);
    if (!r.ok) return toast(r.error, "bad");
    setResult(r.value);
  };

  return (
    <section className="mb-3 rounded-[12px] border border-[#e2d9ff] bg-violet-bg/40 p-3" aria-label="Рекомендация AI">
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles size={17} className="text-violet" aria-hidden />
        <span className="text-[14px] font-semibold text-ink">Рекомендация AI</span>
        {result && (
          <Badge tone={result.source === "ai" ? "violet" : "gray"} size="sm">
            {result.source === "ai" ? "AI" : "По правилам"}
          </Badge>
        )}
        <Button size="sm" variant="secondary" className="ml-auto bg-white" disabled={busy || s === undefined} onClick={() => void ask()}>
          {busy ? "Думаем…" : result ? "Спросить ещё раз" : aiOn ? "Спросить AI" : "Показать рекомендацию"}
        </Button>
      </div>
      {!result && (
        <p className="mt-1.5 text-[12.5px] text-muted">
          {aiOn
            ? "AI расставит подходящих мастеров и объяснит выбор. Клиентские данные в AI не передаются. Решение — за вами."
            : s && !s.enabled
              ? "AI-подбор выключен владельцем в «Настройках» — покажем рекомендацию по правилам подбора."
              : "AI не подключён — покажем рекомендацию по правилам подбора."}
        </p>
      )}
      {result && (
        <div className="mt-2">
          {result.note && <p className="mb-1.5 text-[12.5px] text-warn-ink">{result.note}</p>}
          <p className="text-[13px] text-ink-2">{result.summary}</p>
          <ol className="mt-2 flex flex-col gap-1.5">
            {result.items.map((it, i) => (
              <li key={it.executorId} className="flex items-start gap-2.5 rounded-[10px] bg-white px-3 py-2">
                <span className="mt-0.5 w-5 shrink-0 text-[13px] font-semibold text-violet">{i + 1}.</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-semibold text-ink">
                    {it.name} <span className="font-normal text-muted">· получит {money(it.payout)}</span>
                  </div>
                  <div className="text-[12.5px] text-ink-2">{it.why}</div>
                </div>
                <Button size="sm" disabled={disabled} onClick={() => onPick(it.executorId)}>
                  Назначить
                </Button>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}
