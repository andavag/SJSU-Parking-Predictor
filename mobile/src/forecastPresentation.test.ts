import { describe, expect, it } from "vitest";
import { forecastPath, formatCampusTime } from "./forecastPresentation";

describe("forecast display", () => {
  it("breaks the chart line where a reading is missing", () => {
    const start = Date.parse("2026-10-12T12:00:00Z");
    const points = [20, 30, null, 40].map((value, minute) => ({ time: new Date(start + minute * 60_000).toISOString(), fullnessPercent: value }));
    expect(forecastPath(points, start, start + 180_000, 350, 240)).toMatch(/^M.* L.*  M/);
  });
  it("formats timestamps in campus timezone", () => {
    expect(formatCampusTime("2026-10-12T19:30:00Z")).toContain("12:30");
  });
});
