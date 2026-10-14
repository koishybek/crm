// «Вебхуки» в карточке «API и сайт» (ТЗ п.20.7, п.26.7): подписки владельца на события, секрет подписи (один раз),
// «Отправить тестовое событие», последние доставки, автоотключение после неудач подряд.
import { useQuery } from "convex/react";
import { Plus, Send, Trash2, TriangleAlert, Webhook } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../convex/_generated/api";
import { Badge, Button, FormRow, Input, Loading, Modal, Toggle } from "../components/ui";
import { report } from "../data/store";
import { createWebhook, removeWebhook, sendWebhookTest, setWebhookActive } from "../data/webhookActions";
import {
  SIGNATURE_HEADER,
  WEBHOOK_DISABLE_AFTER,
  WEBHOOK_EVENT_LABEL,
  WEBHOOK_EVENTS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_TOLERANCE_SEC,
  type WebhookDeliveryInfo,
  type WebhookEvent,
  type WebhookInfo,
} from "../data/webhookEvents";
import { dateTime } from "../lib/format";
import { CopyRow } from "./Integrations";

/** Набор галочек: события подписки, права ключа API. */
export function CheckOptions<T extends string>({ options, value, onChange }: { options: { value: T; label: string; hint?: string }[]; value: T[]; onChange: (v: T[]) => void }) {
  return (
    <div className="space-y-1.5">
      {options.map((o) => (
        <label key={o.value} className="flex cursor-pointer items-start gap-2.5 rounded-[9px] px-1 py-1 text-[13.5px] hover:bg-[#faf8f3]">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 shrink-0 accent-[#b07200]"
            checked={value.includes(o.value)}
            onChange={(e) => onChange(e.target.checked ? [...value, o.value] : value.filter((x) => x !== o.value))}
          />
          <span>
            <span className="text-ink">{o.label}</span>
            {o.hint && <span className="block text-[12px] text-muted">{o.hint}</span>}
          </span>
        </label>
      ))}
    </div>
  );
}

const EVENT_OPTIONS = WEBHOOK_EVENTS.map((e) => ({ value: e, label: WEBHOOK_EVENT_LABEL[e], hint: e }));

/** «api.example.kz/hooks/hms» — без схемы и параметров (в них бывают токены). */
const shortUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
};

function deliveryText(d: WebhookDeliveryInfo): { tone: "green" | "amber" | "red" | "gray"; text: string } {
  if (d.status === "ok") return { tone: "green", text: `доставлено${d.responseCode ? ` (${d.responseCode})` : ""}` };
  if (d.status === "failed") return { tone: "red", text: d.error ?? "не доставлено" };
  return d.attempts ? { tone: "amber", text: `попытка ${d.attempts + 1} из ${WEBHOOK_MAX_ATTEMPTS}${d.nextAt ? ` в ${dateTime(d.nextAt)}` : ""} · ${d.error ?? ""}` } : { tone: "gray", text: "отправляется" };
}

export function WebhooksSection() {
  const view = useQuery(api.webhooks.list);
  const [creating, setCreating] = useState(false);
  return (
    <details className="group rounded-[12px] border border-line" open={!!view?.webhooks.length}>
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3.5 py-2.5 text-[13.5px] font-semibold text-ink">
        <Webhook size={16} className="text-brand-ink" aria-hidden /> Вебхуки — события на ваш сервер
        {!!view?.webhooks.length && (
          <Badge tone="gray" size="sm">
            {view.webhooks.length}
          </Badge>
        )}
      </summary>
      <div className="space-y-3 border-t border-line px-3.5 py-3 text-[13px] text-ink-2">
        <p>
          Новая заявка, смена статуса, оплата, отзыв — POST с JSON на ваш https-адрес. Подпись — заголовок <code>{SIGNATURE_HEADER}</code> (HMAC-SHA256 с временем, отвергайте подписи старше {WEBHOOK_TOLERANCE_SEC / 60} минут). Не
          ответили 2xx — до {WEBHOOK_MAX_ATTEMPTS} попыток с растущей паузой; {WEBHOOK_DISABLE_AFTER} неудач подряд — подписка отключается, вы получите уведомление. Контактов клиентов и денег в событиях нет.
        </p>
        {view?.keyIssue && (
          <div className="flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-warn-ink">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>Не подключено: {view.keyIssue}.</span>
          </div>
        )}
        {view === undefined ? (
          <Loading className="py-4" />
        ) : (
          <>
            {view.webhooks.length === 0 ? (
              <p className="rounded-[12px] bg-[#f8f6f1] px-3.5 py-3">Подписок пока нет.</p>
            ) : (
              <ul className="divide-y divide-line rounded-[12px] border border-line">
                {view.webhooks.map((w) => (
                  <WebhookRow key={w.id} w={w} />
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <Button size="sm" icon={Plus} disabled={!!view.keyIssue} onClick={() => setCreating(true)}>
                Добавить подписку
              </Button>
            </div>
            {view.deliveries.length > 0 && <Deliveries list={view.deliveries} hooks={view.webhooks} />}
          </>
        )}
      </div>
      {creating && <CreateWebhook onClose={() => setCreating(false)} />}
    </details>
  );
}

function WebhookRow({ w }: { w: WebhookInfo }) {
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const t = setTimeout(() => setConfirm(false), 5000);
    return () => clearTimeout(t);
  }, [confirm]);
  const act = async (p: Promise<Parameters<typeof report>[0]>, ok: string) => {
    setBusy(true);
    report(await p, ok);
    setBusy(false);
  };
  return (
    <li className="space-y-1.5 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink" title={w.url}>
          {shortUrl(w.url)}
        </span>
        {w.active ? (
          <Badge tone={w.failures ? "amber" : "green"} size="sm">
            {w.failures ? `неудач подряд: ${w.failures}` : "работает"}
          </Badge>
        ) : (
          <Badge tone={w.disabledAt ? "red" : "gray"} size="sm">
            {w.disabledAt ? "отключена системой" : "выключена"}
          </Badge>
        )}
      </div>
      {w.description && <div className="text-[12.5px] text-muted">{w.description}</div>}
      <div className="flex flex-wrap gap-1">
        {w.events.map((e) => (
          <Badge key={e} tone="gray" size="sm">
            {WEBHOOK_EVENT_LABEL[e]}
          </Badge>
        ))}
      </div>
      {w.disabledReason && <div className="text-[12.5px] text-bad">Отключена: {w.disabledReason}. Проверьте сервер и включите снова.</div>}
      {w.active && w.lastError && <div className="text-[12.5px] text-warn-ink">Последняя ошибка: {w.lastError}</div>}
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Toggle checked={w.active} onChange={(v) => void act(setWebhookActive(w.id, v), v ? "Подписка включена" : "Подписка выключена")} label="Включена" />
        <span className="text-[12px] text-muted">{w.lastDeliveryAt ? `доставлено ${dateTime(w.lastDeliveryAt)}` : "ещё не доставлялось"}</span>
        <span className="flex-1" />
        <Button size="sm" variant="secondary" icon={Send} disabled={busy} onClick={() => void act(sendWebhookTest(w.id), "Тестовое событие отправлено — итог в журнале ниже")}>
          Отправить тестовое событие
        </Button>
        <Button size="sm" variant={confirm ? "danger" : "ghost"} icon={Trash2} disabled={busy} onClick={() => (confirm ? void act(removeWebhook(w.id), "Подписка удалена") : setConfirm(true))}>
          {confirm ? "Точно удалить?" : "Удалить"}
        </Button>
      </div>
    </li>
  );
}

function Deliveries({ list, hooks }: { list: WebhookDeliveryInfo[]; hooks: WebhookInfo[] }) {
  const host = new Map(hooks.map((w) => [w.id, shortUrl(w.url)]));
  return (
    <div>
      <div className="mb-1 text-[12.5px] font-medium text-muted">Последние доставки</div>
      <ul className="divide-y divide-line rounded-[12px] border border-line">
        {list.slice(0, 12).map((d) => {
          const s = deliveryText(d);
          return (
            <li key={d.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 text-[12.5px]">
              <span className="font-semibold text-ink">{WEBHOOK_EVENT_LABEL[d.event]}</span>
              <span className="truncate text-muted">{host.get(d.webhookId) ?? "удалённая подписка"}</span>
              <span className="text-muted">{dateTime(d.createdAt)}</span>
              <span className="flex-1" />
              <Badge tone={s.tone} size="sm">
                {s.text}
              </Badge>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CreateWebhook({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["lead.created", "order.status_changed"]);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const create = async () => {
    setBusy(true);
    const r = await createWebhook(url.trim(), events, description.trim() || undefined);
    setBusy(false);
    if (report(r)) setSecret(r.value.secret);
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={secret ? "Подписка создана" : "Новая подписка на события"}
      width={560}
      footer={
        secret ? (
          <Button onClick={onClose}>Готово, секрет сохранён</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button icon={Webhook} disabled={busy || !url.trim() || !events.length} onClick={() => void create()}>
              {busy ? "Создаём…" : "Создать"}
            </Button>
          </>
        )
      }
    >
      {secret ? (
        <div className="space-y-3 text-[13px] text-ink-2">
          <div className="flex items-start gap-2 rounded-[10px] bg-warn-bg px-3 py-2.5 text-warn-ink">
            <TriangleAlert size={16} className="mt-0.5 shrink-0" aria-hidden />
            <span>Скопируйте секрет сейчас — он показывается один раз. Им ваш сервер проверяет подпись каждого события.</span>
          </div>
          <CopyRow label="Секрет подписи" value={secret} />
          <p>
            Проверка: возьмите из заголовка <code>{SIGNATURE_HEADER}</code> значения <code>t</code> и <code>v1</code>, посчитайте HMAC-SHA256 с этим секретом от строки <code>t + "." + тело запроса</code> и сравните с{" "}
            <code>v1</code>. Подписи старше {WEBHOOK_TOLERANCE_SEC / 60} минут отвергайте. Повторы одного события приходят с тем же <code>id</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          <FormRow label="Адрес (https)" required hint="Публичный адрес вашего сервера на порту 443">
            {(id) => <Input id={id} autoFocus inputMode="url" maxLength={500} placeholder="https://example.kz/hooks/homemax" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </FormRow>
          <FormRow label="Описание" hint="Чтобы потом понять, куда уходят события">
            {(id) => <Input id={id} maxLength={80} placeholder="Сайт, бухгалтерия, рекламный кабинет…" value={description} onChange={(e) => setDescription(e.target.value)} />}
          </FormRow>
          <div>
            <div className="mb-1 text-[12.5px] font-medium text-muted">События</div>
            <CheckOptions options={EVENT_OPTIONS} value={events} onChange={setEvents} />
          </div>
        </div>
      )}
    </Modal>
  );
}
