// Печатный вид документа (ТЗ п.19.9): «Счёт на оплату» и «Акт выполненных работ» на лист A4 — из снимка, сохранённого
// при выпуске. «Скачать PDF» — печать браузера → «Сохранить как PDF» (без новых зависимостей).
import { DOC_KIND, docDate, docMoney, type DocParty, type DocumentSnapshot } from "../data/documents";

/** Поля листа A4 и прячем всё, кроме документа. Текст стиля статичный — пользовательских данных в нём нет. */
const PRINT_CSS = "@page { size: A4; margin: 14mm; } @media print { html, body { background: #fff !important; } }";

function Party({ title, p }: { title: string; p: DocParty }) {
  const parts = [p.name, p.bin ? `БИН/ИИН ${p.bin}` : "", p.address ?? "", p.phone ? `тел. ${p.phone.length === 11 ? `+${p.phone}` : p.phone}` : ""].filter(Boolean);
  return (
    <tr>
      <td className="w-[120px] py-1 pr-3 align-top text-[12px] text-[#555]">{title}:</td>
      <td className="py-1 align-top font-medium">{parts.join(", ")}</td>
    </tr>
  );
}

const cell = "border border-[#222] px-2 py-1";

export function DocumentView({ doc }: { doc: DocumentSnapshot }) {
  const { data: d } = doc;
  const invoice = doc.kind === "invoice";
  const due = Math.max(0, d.total - d.paid);
  return (
    <article className="mx-auto w-full max-w-[794px] bg-white p-8 text-[13px] leading-snug text-[#111] shadow-[0_2px_24px_rgba(0,0,0,0.08)] print:max-w-none print:p-0 print:shadow-none">
      <style>{PRINT_CSS}</style>
      {invoice && (
        <table className="mb-5 w-full border-collapse text-[12px]">
          <tbody>
            <tr>
              <td className={cell} rowSpan={2}>
                <div className="text-[11px] text-[#555]">Бенефициар</div>
                <div className="font-semibold">{d.seller.name}</div>
                <div>БИН/ИИН: {d.seller.bin}</div>
              </td>
              <td className={`${cell} text-center`}>
                <div className="text-[11px] text-[#555]">ИИК</div>
                <div className="font-semibold">{d.seller.iik}</div>
              </td>
              <td className={`${cell} text-center`}>
                <div className="text-[11px] text-[#555]">КБе</div>
                <div className="font-semibold">{d.seller.kbe}</div>
              </td>
            </tr>
            <tr>
              <td className={`${cell} text-center`} colSpan={2}>
                <div className="text-[11px] text-[#555]">Банк бенефициара · БИК</div>
                <div className="font-semibold">
                  {d.seller.bank} · {d.seller.bik}
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      )}
      <h1 className="border-b-2 border-[#111] pb-2 text-[18px] font-bold">
        {DOC_KIND[doc.kind].title} № {doc.label} от {docDate(doc.date)}
      </h1>
      <table className="mt-3 w-full">
        <tbody>
          <Party title={invoice ? "Поставщик" : "Исполнитель"} p={d.seller} />
          <Party title={invoice ? "Покупатель" : "Заказчик"} p={d.buyer} />
          {d.basis && (
            <tr>
              <td className="py-1 pr-3 text-[12px] text-[#555]">Основание:</td>
              <td className="py-1">{d.basis}</td>
            </tr>
          )}
        </tbody>
      </table>
      <table className="mt-4 w-full border-collapse text-[12.5px]">
        <thead>
          <tr className="bg-[#f3f3f3]">
            <th className={`${cell} w-8`}>№</th>
            <th className={`${cell} text-left`}>Наименование {invoice ? "товаров (работ, услуг)" : "работ (услуг)"}</th>
            <th className={`${cell} w-14`}>Кол-во</th>
            <th className={`${cell} w-12`}>Ед.</th>
            <th className={`${cell} w-28`}>Цена, KZT</th>
            <th className={`${cell} w-28`}>Сумма, KZT</th>
          </tr>
        </thead>
        <tbody>
          {d.lines.map((l, i) => (
            <tr key={i}>
              <td className={`${cell} text-center`}>{i + 1}</td>
              <td className={cell}>{l.name}</td>
              <td className={`${cell} text-center`}>{l.qty}</td>
              <td className={`${cell} text-center`}>{l.unit}</td>
              <td className={`${cell} text-right tabular-nums`}>{docMoney(l.price)}</td>
              <td className={`${cell} text-right tabular-nums`}>{docMoney(l.sum)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 ml-auto w-full max-w-[320px] text-[13px]">
        <div className="flex justify-between font-semibold">
          <span>Итого:</span>
          <span className="tabular-nums">{docMoney(d.total)}</span>
        </div>
        <div className="flex justify-between">
          <span>{d.vatNote}</span>
        </div>
        {invoice && d.paid > 0 && (
          <>
            <div className="flex justify-between">
              <span>Оплачено:</span>
              <span className="tabular-nums">{docMoney(d.paid)}</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>К оплате:</span>
              <span className="tabular-nums">{docMoney(due)}</span>
            </div>
          </>
        )}
      </div>
      <p className="mt-3">
        Всего наименований {d.lines.length}, на сумму {docMoney(d.total)} KZT
      </p>
      <p className="font-semibold">{invoice ? "Всего к оплате" : "Сумма"}: {d.totalWords}</p>
      {!invoice && <p className="mt-3 text-[12.5px]">Вышеперечисленные работы (услуги) выполнены полностью и в срок. Заказчик претензий по объёму, качеству и срокам оказания услуг не имеет.</p>}
      <div className={`mt-10 grid gap-10 ${invoice ? "grid-cols-1" : "grid-cols-2"}`}>
        <div>
          <div className="text-[12px] text-[#555]">{invoice ? "Руководитель" : "Сдал (Исполнитель)"}</div>
          <div className="mt-6 border-b border-[#111]" />
          <div className="mt-1 text-[12px]">{d.seller.director} · М.П.</div>
        </div>
        {!invoice && (
          <div>
            <div className="text-[12px] text-[#555]">Принял (Заказчик)</div>
            <div className="mt-6 border-b border-[#111]" />
            <div className="mt-1 text-[12px]">{d.buyer.name}</div>
          </div>
        )}
      </div>
    </article>
  );
}
