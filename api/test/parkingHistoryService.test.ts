import { describe, expect, it } from "vitest";
import { ParkingHistoryService } from "../src/parkingHistoryService.js";

describe("ParkingHistoryService", () => {
  it("returns the latest SQL readings in the API shape", async () => {
    const service = new ParkingHistoryService(undefined, async () => [
      { garageName: "South Garage", fullnessPercent: "73", reportedAt: "2026-09-16T08:30:00" },
      { garageName: "North Garage", fullnessPercent: 51, reportedAt: "2026-09-16T08:25:00" }
    ]);

    await expect(service.getLatestReadings()).resolves.toEqual({
      readings: [
        { garageName: "South Garage", fullnessPercent: 73, reportedAt: "2026-09-16T08:30:00" },
        { garageName: "North Garage", fullnessPercent: 51, reportedAt: "2026-09-16T08:25:00" }
      ]
    });
  });

  it("does not attempt a database connection when the laptop database is not configured", async () => {
    const service = new ParkingHistoryService(undefined);
    await expect(service.getLatestReadings()).rejects.toThrow("not configured");
  });
});
