// Выгрузка для 1С (ТЗ п.19.8): выполненные заказы как документы реализации услуг в формате CommerceML 2
// (стандарт 1С для обмена документами: https://v8.1c.ru/tekhnologii/obmen-dannymi-i-integratsiya/standarty-i-formaty/standart-commerceml-2/).
// В перечне хозяйственных операций CommerceML 2 реализации услуг соответствует «Отпуск товара»; что это именно услуга,
// говорят реквизиты номенклатуры (ВидНоменклатуры / ТипНоменклатуры = Услуга) и реквизит документа «Вид документа».

export interface CmlDocument {
  id: string;
  number: number;
  /** Дата выполнения (ISO). */
  doneAt: string;
  status: string;
  client: { id: string; name: string; phone?: string; address?: string };
  service: { id: string; name: string };
  price: number;
  paid: number;
  refunded: number;
}

/** Текст для XML: спецсимволы экранированы, недопустимые в XML 1.0 управляющие символы убраны. */
export function xmlText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const ALMATY_MS = 5 * 3600_000;
/** Дата и время по Алматы: «2026-10-14», «18:30:00». */
const almaty = (iso: string) => {
  const s = new Date(Date.parse(iso) + ALMATY_MS).toISOString();
  return { date: s.slice(0, 10), time: s.slice(11, 19) };
};
const sum = (n: number) => n.toFixed(2);
const prop = (name: string, value: string) => `<ЗначениеРеквизита><Наименование>${xmlText(name)}</Наименование><Значение>${xmlText(value)}</Значение></ЗначениеРеквизита>`;

function documentXml(d: CmlDocument): string {
  const at = almaty(d.doneAt);
  const contacts = d.client.phone ? `<Контакты><Контакт><Тип>Телефон рабочий</Тип><Значение>+${xmlText(d.client.phone)}</Значение></Контакт></Контакты>` : "";
  const address = d.client.address ? `<АдресРегистрации><Представление>${xmlText(d.client.address)}</Представление></АдресРегистрации>` : "";
  return [
    "  <Документ>",
    `    <Ид>${xmlText(d.id)}</Ид>`,
    `    <Номер>${d.number}</Номер>`,
    `    <Дата>${at.date}</Дата>`,
    `    <Время>${at.time}</Время>`,
    "    <ХозОперация>Отпуск товара</ХозОперация>",
    "    <Роль>Продавец</Роль>",
    "    <Валюта>KZT</Валюта>",
    "    <Курс>1</Курс>",
    `    <Сумма>${sum(d.price)}</Сумма>`,
    "    <Контрагенты>",
    `      <Контрагент><Ид>${xmlText(d.client.id)}</Ид><Наименование>${xmlText(d.client.name)}</Наименование><ПолноеНаименование>${xmlText(d.client.name)}</ПолноеНаименование><Роль>Покупатель</Роль>${address}${contacts}</Контрагент>`,
    "    </Контрагенты>",
    `    <Комментарий>${xmlText(`Заказ №${d.number}: ${d.service.name}`)}</Комментарий>`,
    "    <Товары>",
    `      <Товар><Ид>${xmlText(d.service.id)}</Ид><Наименование>${xmlText(d.service.name)}</Наименование><БазоваяЕдиница Код="796" НаименованиеПолное="Штука" МеждународноеСокращение="PCE">шт</БазоваяЕдиница><ЗначенияРеквизитов>${prop("ВидНоменклатуры", "Услуга")}${prop("ТипНоменклатуры", "Услуга")}</ЗначенияРеквизитов><ЦенаЗаЕдиницу>${sum(d.price)}</ЦенаЗаЕдиницу><Количество>1</Количество><Сумма>${sum(d.price)}</Сумма></Товар>`,
    "    </Товары>",
    `    <ЗначенияРеквизитов>${prop("Вид документа", "Реализация услуг")}${prop("Статус заказа", d.status)}${prop("Оплачено", sum(d.paid))}${d.refunded > 0 ? prop("Возвращено клиенту", sum(d.refunded)) : ""}</ЗначенияРеквизитов>`,
    "  </Документ>",
  ].join("\n");
}

/** Файл CommerceML 2.10: документы по порядку дат. */
export function commerceMl(docs: readonly CmlDocument[], generatedAt: string): string {
  const at = almaty(generatedAt);
  return [`<?xml version="1.0" encoding="UTF-8"?>`, `<КоммерческаяИнформация ВерсияСхемы="2.10" ДатаФормирования="${at.date}T${at.time}">`, ...docs.map(documentXml), "</КоммерческаяИнформация>", ""].join("\n");
}
