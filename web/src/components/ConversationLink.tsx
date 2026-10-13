import { useQuery } from "convex/react";
import { MessagesSquare } from "lucide-react";
import { useNavigate } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useMe } from "../data/hooks";
import { canUseInbox, channelLabel } from "../data/inbox";

/** «Переписка» в карточке заявки: заявка пришла из чата — открыть диалог в «Сообщениях». Руководителю направления не показывается. */
export function ConversationLink({ leadId, onOpen }: { leadId: string; onOpen?: () => void }) {
  const me = useMe();
  const nav = useNavigate();
  const conv = useQuery(api.inbox.forLead, canUseInbox(me) ? { leadId: leadId as Id<"leads"> } : "skip");
  if (!conv) return null;
  return (
    <button
      type="button"
      onClick={() => {
        onOpen?.();
        nav(`/inbox?c=${conv.id}`);
      }}
      className="ml-auto inline-flex items-center gap-1 text-[13px] font-semibold text-brand-ink hover:underline"
      title={`Переписка в ${channelLabel(conv.channel)}`}
    >
      <MessagesSquare size={14} aria-hidden /> Переписка
    </button>
  );
}
