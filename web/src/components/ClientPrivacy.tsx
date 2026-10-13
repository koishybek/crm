// Удаление персональных данных по запросу клиента (ТЗ п.26): «опасная зона» карточки клиента — только владелец
// и только с вводом телефона клиента. Номера и суммы заказов остаются для отчётов.
import { ShieldAlert, UserX } from "lucide-react";
import { useState } from "react";
import { useMe } from "../data/hooks";
import { report } from "../data/store";
import { anonymizeClient } from "../data/systemActions";
import type { Client } from "../data/types";
import { date, digits, phoneMask } from "../lib/format";
import { Button, Card, FormRow, Input, Modal } from "./ui";

const ERASED = ["Имя, телефон, email, адрес, заметки и теги", "Записи звонков, расшифровки и разборы AI", "Тексты и файлы переписки во всех каналах", "Комментарии сотрудников и текст отзывов"];
const KEPT = ["Номера заявок и заказов, услуги, даты и статусы", "Цены, оплаты и выплаты мастерам — для отчётов", "Оценки мастерам — рейтинг не изменится", "Журнал действий сотрудников"];

/** «+7 (701) 123-45-67» → «77011234567» — как телефон хранится в карточке. */
const typedPhone = (masked: string) => `7${digits(masked).slice(1)}`;

/** Плашка над обезличенной карточкой: почему в ней нет данных и что делать, если человек обратится снова. */
export function ErasedClientNotice({ at }: { at: string }) {
  return (
    <div className="card mb-4 flex items-start gap-3 p-4">
      <UserX size={20} className="mt-0.5 shrink-0 text-muted" aria-hidden />
      <div className="text-[14px]">
        <div className="font-semibold text-ink">Данные клиента удалены по его запросу {date(at)}</div>
        <div className="mt-0.5 text-muted">Карточку изменить нельзя. Если человек обратится снова — заведите его как нового клиента.</div>
      </div>
    </div>
  );
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div>
      <div className="mb-1.5 text-[13.5px] font-semibold text-ink">{title}</div>
      <ul className="space-y-1 text-[13.5px] text-ink-2">
        {items.map((t) => (
          <li key={t}>— {t}</li>
        ))}
      </ul>
    </div>
  );
}

/** «Опасная зона»: удалить данные клиента по его запросу. Видна только владельцу и только у необезличенного клиента. */
export function ClientEraseCard({ client }: { client: Client }) {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  if (me?.role !== "owner" || client.anonymizedAt || !client.phone) return null;
  const matches = typedPhone(typed) === client.phone;
  const close = () => (setOpen(false), setTyped(""));

  const erase = async () => {
    setBusy(true);
    const ok = report(await anonymizeClient(client.id, typed), "Данные клиента удалены");
    setBusy(false);
    if (ok) close();
  };

  return (
    <>
      <Card className="mt-4" icon={ShieldAlert} title="Удаление данных по запросу клиента">
        <p className="text-[13.5px] text-muted">
          Клиент вправе потребовать удалить его персональные данные. Контакты, записи звонков и переписка удалятся безвозвратно, номера и суммы заказов останутся в отчётах. Перед удалением завершите или
          отмените его заказы и закройте заявки.
        </p>
        <Button className="mt-3" size="sm" variant="danger" icon={UserX} onClick={() => setOpen(true)}>
          Удалить данные клиента
        </Button>
      </Card>

      <Modal
        open={open}
        onClose={close}
        title="Удалить данные клиента"
        width={540}
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Отмена
            </Button>
            <Button variant="danger" icon={UserX} disabled={!matches || busy} onClick={() => void erase()}>
              {busy ? "Удаляем…" : "Удалить навсегда"}
            </Button>
          </>
        }
      >
        <p className="text-[14px] text-ink-2">Делайте это, только если клиент сам попросил удалить его данные. Отменить удаление нельзя.</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <List title="Удалится" items={ERASED} />
          <List title="Останется" items={KEPT} />
        </div>
        <div className="mt-4">
          <FormRow label="Телефон клиента — для подтверждения" required hint="Наберите номер клиента полностью">
            {(id) => <Input id={id} inputMode="tel" autoComplete="off" placeholder="+7 (___) ___-__-__" value={typed} onChange={(e) => setTyped(phoneMask(e.target.value))} />}
          </FormRow>
        </div>
      </Modal>
    </>
  );
}
