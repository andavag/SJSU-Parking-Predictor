import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_SPEED, RADII } from "./crossingTypes";
import { uploadCrossings } from "./crossingQueue";
const sqlite = vi.hoisted(() => ({ directory: "", opened: [] as string[], handles: [] as { close(): void }[] }));
vi.mock("expo-crypto", async () => ({ randomUUID: (await import("node:crypto")).randomUUID }));
// Execute the production SQL against real SQLite, preserving the file across a
// module restart. Native Expo bindings are the only replaced layer.
vi.mock("expo-sqlite", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  return { openDatabaseAsync: async (name: string) => {
    sqlite.opened.push(name);
    const db = new DatabaseSync(join(sqlite.directory, name));
    sqlite.handles.push(db);
    const adapter = {
      execAsync: async (sql: string) => { db.exec(sql); },
      runAsync: async (sql: string, ...params: (string | number)[]) => db.prepare(sql).run(...params),
      getFirstAsync: async (sql: string, ...params: (string | number)[]) => db.prepare(sql).get(...params) ?? null,
      getAllAsync: async (sql: string, ...params: (string | number)[]) => db.prepare(sql).all(...params),
      withExclusiveTransactionAsync: async (work: (tx: unknown) => Promise<void>) => {
        db.exec("BEGIN IMMEDIATE");
        try { await work(adapter); db.exec("COMMIT"); } catch (error) { db.exec("ROLLBACK"); throw error; }
      }
    };
    return adapter;
  } };
});
sqlite.directory = mkdtempSync(join(tmpdir(), "west-crossing-test-"));
let store = await import("./crossingStore");
const at = Date.parse("2026-10-22T00:00:00Z");
const due = at + 86_400_000;
beforeEach(async () => { await store.clearCrossings(); await store.saveLoggingEnabled(true); });
afterAll(() => { sqlite.handles.forEach(db => db.close()); rmSync(sqlite.directory, { recursive: true }); });
it("keeps all eight callbacks, repeats and unexpected order in receipt sequence", async () => {
  const callbacks = RADII.flatMap(radius => [store.recordCrossing(radius, "entered", at), store.recordCrossing(radius, "exited", at)]);
  callbacks.push(store.recordCrossing(160, "exited", at - 10_000), store.recordCrossing(160, "exited", at - 10_000));
  await Promise.all(callbacks);
  const rows = await store.getRecentCrossings();
  expect(rows).toHaveLength(10);
  expect(new Set(rows.map(row => row.clientEventId)).size).toBe(10);
  expect(rows.slice(0, 2).map(row => row.direction)).toEqual(["exited", "exited"]);
  expect(rows.map(row => row.sequence)).toEqual([...rows.map(row => row.sequence)].sort((a, b) => b - a));
  expect(await store.getDueCrossings(at)).toHaveLength(0);
});
it("does not log disabled callbacks and preserves existing records", async () => {
  await store.recordCrossing(50, "entered", at);
  await store.saveLoggingEnabled(false);
  expect(await store.recordCrossing(50, "exited", at)).toBeUndefined();
  expect(await store.getRecentCrossings()).toHaveLength(1);
});
it("recovers a saved callback after interruption during sampling without opening v1", async () => {
  const id = await store.recordCrossing(100, "entered", at);
  vi.resetModules();
  store = await import("./crossingStore");
  expect((await store.getRecentCrossings())[0]).toMatchObject({ clientEventId: id, sampleState: "ready", ...NO_SPEED });
  expect((await store.getDueCrossings(due))[0]).toMatchObject({ clientEventId: id, sampleState: "ready" });
  expect(new Set(sqlite.opened)).toEqual(new Set(["west-garage-crossings-v2.db"]));
});
it("persists retries, applies individual acknowledgements and deduplicates interrupted uploads", async () => {
  const ids = await Promise.all([store.recordCrossing(50, "entered", at), store.recordCrossing(50, "exited", at), store.recordCrossing(150, "entered", at)]);
  const batch = await store.getDueCrossings(due);
  await expect(uploadCrossings(batch, async () => { throw new Error("offline"); }, store.markCrossingSynced, store.markCrossingFailed, store.markCrossingRejected, () => due)).rejects.toThrow("offline");
  vi.resetModules(); store = await import("./crossingStore");
  expect(await store.getDueCrossings(due)).toHaveLength(0);
  const retry = await store.getDueCrossings(due + 3_600_000);
  expect(retry).toHaveLength(3);
  await uploadCrossings(retry, async () => [{ clientEventId: ids[0]!, status: "duplicate" }, { clientEventId: ids[1]!, status: "rejected", error: "conflict" }], store.markCrossingSynced, store.markCrossingFailed, store.markCrossingRejected, () => due + 3_600_000);
  const rows = await store.getRecentCrossings();
  expect(rows.find(row => row.clientEventId === ids[0])?.syncState).toBe("synced");
  expect(rows.find(row => row.clientEventId === ids[1])?.syncState).toBe("blocked");
  expect(rows.find(row => row.clientEventId === ids[2])).toMatchObject({ syncState: "pending", attempts: 2 });
});
it("clear removes pending and synced records, late speed and acks cannot resurrect them", async () => {
  const first = await store.recordCrossing(50, "entered", at);
  const second = await store.recordCrossing(100, "entered", at);
  await store.markCrossingSynced(first!);
  await store.clearCrossings();
  await store.finishSpeed(second!, { speedMetersPerSecond: 4, speedMeasuredAt: new Date(at).toISOString(), accuracyMeters: 8 });
  await store.markCrossingSynced(second!);
  expect(await store.getRecentCrossings()).toEqual([]);
  expect(await store.getLoggingSettings()).toMatchObject({ enabled: true });
});
it("freezes payload once ready for upload and limits batches to 25", async () => {
  for (let i = 0; i < 26; i++) await store.recordCrossing(160, "entered", at);
  const rows = await store.getDueCrossings(due);
  expect(rows).toHaveLength(25);
  await store.finishSpeed(rows[0].clientEventId, { speedMetersPerSecond: 12, speedMeasuredAt: new Date(at).toISOString(), accuracyMeters: 9 });
  expect((await store.getDueCrossings(due))[0].speedMetersPerSecond).toBeNull();
});
it("saves speed metadata across restart and emits only wire fields", async () => {
  const id = await store.recordCrossing(150, "exited", at);
  const sample = { speedMetersPerSecond: 1.2, speedMeasuredAt: new Date(at + 2000).toISOString(), accuracyMeters: 9 };
  await store.finishSpeed(id!, sample);
  vi.resetModules(); store = await import("./crossingStore");
  const rows = await store.getDueCrossings(due);
  expect(rows[0]).toMatchObject(sample);
  const upload = vi.fn(async (events) => {
    expect(events[0]).toEqual({ clientEventId: id, garageId: "west", trackingConfigVersion: 2,
      radiusMeters: 150, direction: "exited", callbackReceivedAt: new Date(at).toISOString(), ...sample });
    return [{ clientEventId: id!, status: "accepted" as const }];
  });
  await uploadCrossings(rows, upload, store.markCrossingSynced, store.markCrossingFailed, store.markCrossingRejected);
  expect((await store.getRecentCrossings())[0].syncState).toBe("synced");
});
