import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import type { AiSummary } from "../data/types";

/** Блок «AI-разбор»: пересказ, что AI вытащил из разговора, и что уточнить у клиента. */
export function AiCard({ ai, title = "AI-разбор", action, compact }: { ai: AiSummary; title?: string; action?: ReactNode; compact?: boolean }) {
  return (
    <div className="rounded-[14px] border border-[#dccfff] bg-[linear-gradient(180deg,#f7f3ff,#fff)] p-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-ink">
          <Sparkles size={18} className="text-violet" aria-hidden /> {title}
        </div>
        {action}
      </div>
      <p className="text-[14px] leading-relaxed text-ink-2">{ai.summary}</p>
      {ai.extracted.length > 0 && (
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
          {ai.extracted.map((x) => (
            <div key={x.label} className="min-w-0">
              <div className="text-[12px] text-muted">{x.label}</div>
              <div className="truncate text-[13.5px] font-semibold text-ink" title={x.value}>
                {x.value}
              </div>
            </div>
          ))}
        </div>
      )}
      {ai.questions.length > 0 && (
        <>
          <div className="mt-3 text-[12.5px] font-semibold text-muted">Уточнить у клиента:</div>
          <ul className="mt-1 space-y-1">
            {ai.questions.map((q) => (
              <li key={q} className="flex items-start gap-2 text-[13.5px] text-ink-2">
                <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-violet" />
                {q}
              </li>
            ))}
          </ul>
        </>
      )}
      {!compact && <p className="mt-3 text-[12px] text-muted">AI только предлагает — оператор проверяет и подтверждает. Цены и закрытие заказа AI не меняет.</p>}
    </div>
  );
}
