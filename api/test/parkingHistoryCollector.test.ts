import { describe, expect, it } from "vitest";
import { sourceTimestampToSqlDatetime } from "../src/parkingHistoryCollector.js";

describe("sourceTimestampToSqlDatetime", () => {
  it("preserves SJSU's wall-clock timestamp in SQL format", () => {
    expect(sourceTimestampToSqlDatetime("9/13/2026, 10:45:11 PM")).toBe("2026-09-13 22:45:11");
    expect(sourceTimestampToSqlDatetime("1/2/2026, 12:00:01 AM")).toBe("2026-01-02 00:00:01");
  });

  it("rejects impossible source timestamps", () => {
    expect(() => sourceTimestampToSqlDatetime("2/30/2026, 1:00:00 PM")).toThrow("invalid");
  });
});
