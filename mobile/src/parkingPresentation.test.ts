import { describe, expect, it } from "vitest";
import { getGarageDisplay, REFRESH_INTERVAL_MS } from "./parkingPresentation";

describe("garage presentation", () => {
  it("uses clear labels for available, busy, and full garages", () => {
    const baseGarage = { id: "north" as const, name: "North Garage", address: "Address", isFull: false };
    expect(getGarageDisplay({ ...baseGarage, fullnessPercent: 20 }).label).toBe("Available");
    expect(getGarageDisplay({ ...baseGarage, fullnessPercent: 60 }).label).toBe("Busy");
    expect(getGarageDisplay({ ...baseGarage, fullnessPercent: 100, isFull: true }).label).toBe("Full");
  });

  it("uses a 30-second automatic refresh interval", () => {
    expect(REFRESH_INTERVAL_MS).toBe(30_000);
  });
});
