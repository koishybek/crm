// Простое подтверждение в шторке: выход из аккаунта, отключение Telegram.
import { WButton, busyLabel, useBusy } from "./kit";
import { Sheet } from "./Sheet";

interface ConfirmSheetProps {
  title: string;
  text: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmSheet({ title, text, confirm, cancel = "Отмена", danger, onConfirm, onClose }: ConfirmSheetProps) {
  const { busy, slow, run } = useBusy();
  return (
    <Sheet
      open
      onClose={onClose}
      locked={busy}
      title={title}
      footer={
        <>
          <WButton variant="ghost" full onClick={onClose} disabled={busy}>
            {cancel}
          </WButton>
          <WButton variant={danger ? "danger" : "primary"} size="lg" full busy={busy} busyText={busyLabel(slow, "Секунду…")} onClick={() => void run(onConfirm)}>
            {confirm}
          </WButton>
        </>
      }
    >
      <p className="text-[15.5px] text-ink-2">{text}</p>
    </Sheet>
  );
}
