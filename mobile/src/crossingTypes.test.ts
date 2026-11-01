import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSpeed, NO_SPEED, RADII, radiusForRegion, regionId, validSpeed, WEST_GARAGE } from "./crossingTypes";
const now = Date.parse("2026-10-22T12:00:00Z");
const fix = { timestamp: now, coords: { speed: 4, accuracy: 8, latitude: 37, longitude: -121 } };
afterEach(() => vi.useRealTimers());
describe("crossing speed projection", () => {
  it("uses the agreed center and four distinct boundaries", () => {
    expect(WEST_GARAGE).toEqual({ latitude: 37.3316667, longitude: -121.8827222 });
    expect(RADII).toEqual([50, 100, 150, 160]);
    for (const radius of RADII) expect(radiusForRegion(regionId(radius))).toBe(radius);
    expect(radiusForRegion("west:inner")).toBeUndefined();
  });
  it("projects a fresh fix without coordinates, including zero speed and boundary accuracy/age", () => {
    expect(validSpeed(fix, now)).toEqual({ speedMetersPerSecond: 4, speedMeasuredAt: new Date(now).toISOString(), accuracyMeters: 8 });
    expect(validSpeed({ timestamp: now - 30_000, coords: { speed: 0, accuracy: 50 } }, now)?.speedMetersPerSecond).toBe(0);
  });
  it.each([
    null, { ...fix, timestamp: now - 30_001 }, { ...fix, timestamp: now + 1 },
    ...[null, -1, NaN, Infinity].map(speed => ({ ...fix, coords: { speed, accuracy: 8 } })),
    ...[null, -1, 51, NaN, Infinity].map(accuracy => ({ ...fix, coords: { speed: 4, accuracy } }))
  ])("rejects stale, future, missing or inaccurate samples: %j", value => expect(validSpeed(value, now)).toBeUndefined());
  it("uses cached valid speed without requesting GPS", async () => {
    const current = vi.fn();
    expect(await captureSpeed(async () => fix, current, () => now)).toEqual(validSpeed(fix, now));
    expect(current).not.toHaveBeenCalled();
  });
  it("falls back once to GPS after stale or failed cached lookup", async () => {
    const current = vi.fn(async () => fix);
    expect(await captureSpeed(async () => ({ ...fix, timestamp: now - 40_000 }), current, () => now)).toEqual(validSpeed(fix, now));
    expect(current).toHaveBeenCalledTimes(1);
    expect(await captureSpeed(async () => { throw new Error("denied"); }, async () => { throw new Error("denied"); }, () => now)).toEqual(NO_SPEED);
  });
  it("finishes a stuck GPS call after ten seconds, without using its late result", async () => {
    vi.useFakeTimers();
    let resolve!: (value: typeof fix) => void;
    const result = captureSpeed(async () => null, () => new Promise(done => { resolve = done; }), () => now);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toEqual(NO_SPEED);
    resolve(fix);
    expect(await result).toEqual(NO_SPEED);
  });
});
