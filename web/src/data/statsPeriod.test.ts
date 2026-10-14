// @vitest-environment node
// Периоды «Аналитики»: пресеты по Алматы и проверка своего периода.
import { describe, expect, test } from "vitest";
import { presetRange, rangeProblem } from "./statsPeriod";

// 14 октября 2026, 01:30 по Алматы — в UTC ещё 13-е: день отчёта — по Алматы.
const NOW = Date.parse("2026-10-13T20:30:00Z");
const NONE = { from: "", to: "" };

describe("периоды аналитики", () => {
  test("пресеты считают дни по Алматы, обе границы включительно", () => {
    expect(presetRange("today", NONE, NOW)).toEqual({ from: "2026-10-14", to: "2026-10-14" });
    expect(presetRange("7d", NONE, NOW)).toEqual({ from: "2026-10-08", to: "2026-10-14" });
    expect(presetRange("month", NONE, NOW)).toEqual({ from: "2026-10-01", to: "2026-10-14" });
    expect(presetRange("prevMonth", NONE, NOW)).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("365d", NONE, NOW)).toEqual({ from: "2025-10-15", to: "2026-10-14" });
    expect(presetRange("custom", { from: "2026-01-05", to: "2026-02-10" }, NOW)).toEqual({ from: "2026-01-05", to: "2026-02-10" });
  });

  test("свой период: обе даты, начало не позже конца, не длиннее года", () => {
    expect(rangeProblem({ from: "", to: "2026-10-01" })).toBe("Укажите обе даты");
    expect(rangeProblem({ from: "2026-10-02", to: "2026-10-01" })).toBe("Начало периода позже его конца");
    expect(rangeProblem({ from: "2025-01-01", to: "2026-10-01" })).toMatch("не длиннее");
    expect(rangeProblem({ from: "2025-10-15", to: "2026-10-14" })).toBeNull();
  });
});
