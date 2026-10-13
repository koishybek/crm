// Как подписать клиента мастеру: человека — «Айсулу Н.», компанию — целиком («ТОО «Ромашка»»).
// shortName из lib/format проверяет форму собственности через \b, а \b в JS не видит границу
// после кириллицы — «ТОО «Ромашка»» превращался в «ТОО «.». Здесь граница проверяется явно.
import { shortName } from "../lib/format";

const COMPANY = /^(?:ТОО|ИП|АО|ЖК|ОСИ|КСК)(?=[\s«"']|$)/u;

export function clientShortName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) return "";
  return COMPANY.test(n) ? n : shortName(n);
}
