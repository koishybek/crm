// Документы заказа (ТЗ п.19.9): «Счёт на оплату» и «Акт выполненных работ» — выпуск, печать (страница /docs/<вид>/<заказ>,
// «Скачать PDF» — через печать браузера) и ссылка клиенту на страницу только для чтения.
import { useQuery } from "convex/react";
import { Copy, FileText, Printer, RefreshCw, Send } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { issueDocument, shareDocument } from "../data/adapterActions";
import { ACT_STATUSES, DOC_KIND, docDate, INVOICE_BLOCKED, type DocumentKind } from "../data/documents";
import { useMe } from "../data/hooks";
import { report, toast } from "../data/store";
import type { Order } from "../data/types";
import { money } from "../lib/format";
import { Badge, Button, Card, Menu, MenuItem } from "./ui";

const openPrint = (kind: DocumentKind, orderId: string) => window.open(`/docs/${DOC_KIND[kind].path}/${orderId}`, "_blank", "noopener");

export function OrderDocuments({ o }: { o: Order }) {
  const me = useMe();
  const staff = me?.role === "owner" || me?.role === "operator";
  const docs = useQuery(api.documents.forOrder, staff ? { orderId: o.id as Id<"orders"> } : "skip");
  const [busy, setBusy] = useState(false);
  if (!staff || docs === undefined) return null;
  const allowed: Record<DocumentKind, boolean> = { invoice: !INVOICE_BLOCKED.includes(o.status) && o.clientPrice > 0, act: ACT_STATUSES.includes(o.status) && o.clientPrice > 0 };

  /** Печатная страница сама выпускает документ, если его ещё нет; «Выпустить заново» — сначала новый номер. */
  const issue = async (kind: DocumentKind, reissue = false) => {
    if (!reissue) return openPrint(kind, o.id);
    // Окно — сразу по нажатию: открытое после ответа сервера браузер может заблокировать.
    const w = window.open("", "_blank");
    setBusy(true);
    const r = await issueDocument(o.id, kind, true);
    setBusy(false);
    if (report(r, "Документ выпущен заново") && w) w.location.href = `/docs/${DOC_KIND[kind].path}/${o.id}`;
    else w?.close();
  };
  const share = async (id: string, send: boolean) => {
    const r = await shareDocument(id, send);
    if (!report(r)) return;
    if (!send) {
      void navigator.clipboard?.writeText(r.value.url);
      return toast("Ссылка скопирована — действует 30 дней", "info");
    }
    const d = r.value.delivery;
    toast(d?.sent ? "Документ отправлен клиенту" : (d?.reason ?? "Не отправлено"), d?.sent ? "ok" : "info");
  };

  return (
    <Card title="Документы" icon={FileText}>
      <div className="flex flex-wrap gap-2">
        {(["invoice", "act"] as const).map((k) => (
          <Button key={k} size="sm" variant="secondary" icon={Printer} disabled={busy || !allowed[k]} title={allowed[k] ? undefined : k === "act" ? "Акт — когда работа сдана" : "Счёт по этому заказу не выставить"} onClick={() => void issue(k)}>
            {k === "invoice" ? "Счёт на оплату" : "Акт выполненных работ"}
          </Button>
        ))}
      </div>
      {docs.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {docs.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-2 py-2 text-[13.5px]">
              <span className="font-medium text-ink">
                {DOC_KIND[d.kind].short} №{d.label}
              </span>
              <span className="text-muted">
                от {docDate(d.date)} · {money(d.total)}
              </span>
              {d.replaced ? (
                <Badge tone="gray" size="sm">
                  заменён
                </Badge>
              ) : d.sentAt ? (
                <Badge tone="green" size="sm">
                  отправлен клиенту
                </Badge>
              ) : null}
              <span className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" icon={Printer} onClick={() => openPrint(d.kind, o.id)} disabled={d.replaced}>
                  Печать / PDF
                </Button>
                {!d.replaced && (
                  <Menu width={260} trigger={(toggle) => <Button size="sm" variant="ghost" icon={Send} onClick={toggle}>Клиенту</Button>}>
                    {(close) => (
                      <>
                        <MenuItem icon={Send} hint="В мессенджер клиента, ссылка на 30 дней" onClick={() => (close(), void share(d.id, true))}>
                          Отправить клиенту
                        </MenuItem>
                        <MenuItem icon={Copy} hint="Отправить самому — например, по почте" onClick={() => (close(), void share(d.id, false))}>
                          Скопировать ссылку
                        </MenuItem>
                        <MenuItem icon={RefreshCw} hint="Новый номер; прежний станет «заменён»" onClick={() => (close(), void issue(d.kind, true))}>
                          Выпустить заново
                        </MenuItem>
                      </>
                    )}
                  </Menu>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
