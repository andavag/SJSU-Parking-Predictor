import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseParkingPage } from "../src/parkingParser.js";

const fixturePath = fileURLToPath(new URL("./fixtures/parking-status.html", import.meta.url));

describe("parseParkingPage", () => {
  it("normalizes all garages, the source timestamp, and shuttle links", async () => {
    const parsed = parseParkingPage(await readFile(fixturePath, "utf8"));
    expect(parsed.sourceUpdatedAt).toBe("9/13/2026, 10:45:11 PM");
    expect(parsed.garages).toHaveLength(4);
    expect(parsed.garages.map((garage) => garage.fullnessPercent)).toEqual([7, 28, 100, 2]);
    expect(parsed.garages[2]).toMatchObject({ name: "South Garage", isFull: true });
    expect(parsed.shuttles).toMatchObject({
      realtimeLocationUrl: "https://sjsuparkingstatus.sjsu.edu/shuttle-map",
      informationUrl: "https://parking.sjsu.edu/shuttles"
    });
  });
});
