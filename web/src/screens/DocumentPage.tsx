// Печатная страница документа заказа (ТЗ п.19.9): /docs/<invoice|act>/<заказ> — для сотрудников, без меню. Документа
// ещё нет — выпускаем один раз (повторное открытие возвращает тот же номер). /d/<токен> — та же страница для клиента,
// только чтение, без входа.
import { useConvexAuth, useQuery } from "convex/react";
import { Link2Off, Printer } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { DocumentView } from "../components/DocumentView";
import { Button, Loading } from "../components/ui";
import { issueDocument } from "../data/adapterActions";
import { APP_NAME } from "../data/catalog";
import { DOC_KIND, isDocumentKind, type DocumentKind, type DocumentSnapshot } from "../data/documents";
import { useMe } from "../data/hooks";

function usePageTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

function Toolbar({ doc }: { doc: DocumentSnapshot }) {
  return (
    <div className="mx-auto mb-4 flex w-full max-w-[794px] flex-wrap items-center justify-between gap-3 print:hidden">
      <div className="text-[14px] text-muted">
        {DOC_KIND[doc.kind].title} № {doc.label}
      </div>
      <Button icon={Printer} onClick={() => window.print()}>
        Печать / Скачать PDF
      </Button>
    </div>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-page px-4 py-6 print:bg-white print:p-0">{children}</div>;
}

function Message({ text }: { text: string }) {
  return (
    <Page>
      <div className="mx-auto mt-20 flex max-w-sm flex-col items-center gap-3 text-center">
        <Link2Off size={36} className="text-muted" aria-hidden />
        <p className="text-[15px] text-ink-2">{text}</p>
      </div>
    </Page>
  );
}

/** Сотрудник: /docs/:kind/:orderId. */
export function StaffDocumentPage() {
  const { kind = "", orderId = "" } = useParams();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const me = useMe();
  const loc = useLocation();
  const valid = isDocumentKind(kind);
  const staff = me?.role === "owner" || me?.role === "operator";
  const doc = useQuery(api.documents.latest, valid && staff ? { orderId: orderId as Id<"orders">, kind: kind as DocumentKind } : "skip");
  const [error, setError] = useState("");
  const tried = useRef(false);
  usePageTitle(doc ? `${DOC_KIND[doc.kind].short} №${doc.label} — ${APP_NAME}` : APP_NAME);

  useEffect(() => {
    if (doc !== null || tried.current || !valid) return;
    tried.current = true;
    void issueDocument(orderId, kind as DocumentKind).then((r) => !r.ok && setError(r.error));
  }, [doc, valid, orderId, kind]);

  if (isLoading || (isAuthenticated && me === undefined)) return <Loading />;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (!staff) return <Message text="Документы заказа доступны владельцу и операторам." />;
  if (!valid) return <Message text="Такого документа нет." />;
  if (error) return <Message text={error} />;
  if (!doc) return <Loading text="Готовим документ…" />;
  return (
    <Page>
      <Toolbar doc={doc} />
      {doc.replaced && <p className="mx-auto mb-3 max-w-[794px] text-[13px] text-warn-ink print:hidden">Этот документ заменён новым — печатайте актуальный из карточки заказа.</p>}
      <DocumentView doc={doc} />
    </Page>
  );
}

/** Клиент: /d/:token — только чтение, без входа. */
export function PublicDocumentPage() {
  const { token = "" } = useParams();
  const doc = useQuery(api.documents.publicView, { token });
  usePageTitle(doc ? `${DOC_KIND[doc.kind].short} №${doc.label} — ${APP_NAME}` : APP_NAME);
  if (doc === undefined) return <Loading />;
  if (!doc) return <Message text="Ссылка на документ устарела или неверна. Попросите компанию прислать новую." />;
  return (
    <Page>
      <Toolbar doc={doc} />
      <DocumentView doc={doc} />
    </Page>
  );
}
