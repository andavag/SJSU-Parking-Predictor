import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CACHE_TTL_MS, ParkingStatusService } from "../src/parkingService.js";

const fixturePath = fileURLToPath(new URL("./fixtures/parking-status.html", import.meta.url));

describe("ParkingStatusService", () => {
  it("uses the 30-second cache and returns stale data when a refresh fails", async () => {
    const html = await readFile(fixturePath, "utf8");
    let attempts = 0;
    let currentTime = new Date("2026-09-14T05:00:00.000Z");
    const fakeFetch = async () => {
      attempts += 1;
      if (attempts > 1) throw new Error("Network down");
      return new Response(html, { status: 200 });
    };
    const service = new ParkingStatusService(fakeFetch as typeof fetch, () => currentTime);

    const first = await service.getStatus();
    expect(await service.getStatus()).toEqual(first);
    expect(attempts).toBe(1);

    currentTime = new Date(currentTime.getTime() + CACHE_TTL_MS + 1);
    expect((await service.getStatus()).stale).toBe(true);
    expect(attempts).toBe(2);
  });

  it("fails when no successful source response has been cached", async () => {
    const service = new ParkingStatusService((async () => { throw new Error("Network down"); }) as typeof fetch);
    await expect(service.getStatus()).rejects.toThrow("Network down");
  });
});
