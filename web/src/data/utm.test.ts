// @vitest-environment node
// Метки рекламы (ТЗ п.6.6): форма /zayavka берёт utm_* из своего адреса — во встроенной форме сниппет дописывает
// туда адрес страницы сайта (location.search родителя).
import { describe, expect, test } from "vitest";
import { campaignOf, cleanUtmValue, utmFromRecord, utmFromSearch, utmParams, utmText } from "./utm";

describe("метки рекламы", () => {
  test("из адреса формы и из адреса родителя iframe (сниппет: ?embed=1&<search родителя>)", () => {
    expect(utmFromSearch("?service=ac-clean&utm_source=instagram&utm_campaign=ac-oct")).toEqual({ source: "instagram", campaign: "ac-oct" });
    const parentSearch = "?utm_source=google&utm_medium=cpc&utm_campaign=wm%20autumn&gclid=xyz";
    const iframeSrc = `https://app.homemax.kz/zayavka?embed=1&${parentSearch.slice(1)}`;
    expect(utmFromSearch(new URL(iframeSrc).search)).toEqual({ source: "google", medium: "cpc", campaign: "wm autumn" });
    expect(utmFromSearch("?embed=1")).toBeUndefined();
  });

  test("очистка: пробелы, управляющие символы, формулы Excel, длина", () => {
    expect(cleanUtmValue("  ac\u0000-oct \n")).toBe("ac -oct");
    expect(cleanUtmValue("=cmd|' /C calc'!A0")).toBe("cmd|' /C calc'!A0");
    expect(cleanUtmValue("x".repeat(300))).toHaveLength(100);
    expect(cleanUtmValue(5)).toBeUndefined();
    expect(cleanUtmValue("   ")).toBeUndefined();
  });

  test("тело запроса: плоские utm_* важнее объекта utm; кампания — явная или utm_campaign", () => {
    const u = utmFromRecord({ utm_source: "2gis", utm: { source: "ignored", campaign: "c1" } });
    expect(u).toEqual({ source: "2gis", campaign: "c1" });
    expect(campaignOf(u)).toBe("c1");
    expect(campaignOf(u, "Партнёр")).toBe("Партнёр");
    expect(utmParams(u)).toEqual({ utm_source: "2gis", utm_campaign: "c1" });
    expect(utmText(u)).toBe("utm_source=2gis, utm_campaign=c1");
    expect(utmFromRecord({ utm: ["x"] })).toBeUndefined();
  });
});
