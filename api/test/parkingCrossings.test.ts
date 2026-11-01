import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";
import { describe, expect, it } from "vitest";
import { ParkingCrossingService, validateCrossing, validateCrossingEnvelope } from "../src/parkingCrossings.js";
const event = { clientEventId: randomUUID(), garageId: "west", trackingConfigVersion: 2, radiusMeters: 100,
  direction: "entered", callbackReceivedAt: "2026-10-22T12:00:00.000Z", speedMetersPerSecond: null, speedMeasuredAt: null, accuracyMeters: null };
describe("crossing validation", () => {
  it("accepts every radius and direction with available or unavailable speed", () => {
    for (const radiusMeters of [50, 100, 150, 160]) for (const direction of ["entered", "exited"]) {
      expect(validateCrossing({ ...event, radiusMeters, direction })).toMatchObject({ radiusMeters, direction });
      expect(validateCrossing({ ...event, radiusMeters, direction, speedMetersPerSecond: 0, accuracyMeters: 0, speedMeasuredAt: event.callbackReceivedAt })).toMatchObject({ speedMetersPerSecond: 0 });
    }
  });
  it.each([
    { latitude: 37 }, { longitude: -121 }, { coordinates: {} }, { extra: true }, { clientEventId: "bad" },
    { garageId: "north" }, { trackingConfigVersion: 1 }, { radiusMeters: 200 }, { radiusMeters: "100" }, { direction: "enter" },
    { callbackReceivedAt: "2026-02-30T12:00:00Z" }, { callbackReceivedAt: "2026-10-22T12:00:00+00:00" },
    { callbackReceivedAt: "2026-10-22T24:00:00Z" }, { callbackReceivedAt: null },
    { speedMetersPerSecond: -1 }, { speedMetersPerSecond: Infinity }, { speedMetersPerSecond: NaN },
    { speedMetersPerSecond: 1 }, { speedMeasuredAt: event.callbackReceivedAt }, { accuracyMeters: 1 },
    { speedMetersPerSecond: 1, speedMeasuredAt: event.callbackReceivedAt, accuracyMeters: -1 },
    { speedMetersPerSecond: 1, speedMeasuredAt: event.callbackReceivedAt, accuracyMeters: Infinity },
    { speedMetersPerSecond: 1, speedMeasuredAt: "yesterday", accuracyMeters: 8 }
  ])("rejects invalid fields %j", patch => expect(() => validateCrossing({ ...event, ...patch })).toThrow());
  it("requires all exact fields and a bounded, identifiable batch", () => {
    const { accuracyMeters: _, ...missing } = event;
    expect(() => validateCrossing(missing)).toThrow();
    for (const value of [null, [], {}, { events: [] }, { events: Array(26).fill(event) }, { events: [event], coordinates: [] }, { events: [{}] }]) expect(() => validateCrossingEnvelope(value)).toThrow();
    expect(validateCrossingEnvelope({ events: Array(25).fill(event) })).toHaveLength(25);
  });
});
it("acknowledges individually and deduplicates only the same installation and canonical payload", async () => {
  const rows = new Map<string, { installation_id: string; payload_json: string }>();
  const pool = { execute: async (sql: string, args: string[]) => {
    if (sql.startsWith("INSERT")) {
      if (rows.has(args[0])) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
      rows.set(args[0], { installation_id: args[1], payload_json: args[2] }); return [{}];
    }
    return [[rows.get(args[0])]];
  } } as unknown as Pool;
  const service = new ParkingCrossingService(undefined, pool);
  const bad = { ...event, clientEventId: randomUUID(), latitude: 37 };
  expect((await service.processBatch("phone-a", [event, bad])).map(ack => ack.status)).toEqual(["accepted", "rejected"]);
  const reordered = Object.fromEntries(Object.entries(event).reverse());
  expect((await service.processBatch("phone-a", [reordered]))[0].status).toBe("duplicate");
  expect((await service.processBatch("phone-b", [event]))[0].status).toBe("rejected");
  expect((await service.processBatch("phone-a", [{ ...event, direction: "exited" }]))[0].status).toBe("rejected");
  expect(rows.size).toBe(1);
});
