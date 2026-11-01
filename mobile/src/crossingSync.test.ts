import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ enabled: true, token: "a".repeat(43) as string | null, events: [] as unknown[], fetch: vi.fn(), synced: vi.fn(), failed: vi.fn(), rejected: vi.fn(), calls: [] as string[] }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => { mock.calls.push(key); return mock.token; },
  setItemAsync: async (_key: string, token: string) => { mock.token = token; },
  deleteItemAsync: async () => { mock.token = null; }
}));
vi.mock("./api", () => ({ getApiBaseUrl: () => "https://example.com" }));
vi.mock("./crossingStore", () => ({
  getLoggingSettings: async () => ({ enabled: mock.enabled }),
  getDueCrossings: async () => mock.events,
  markCrossingSynced: mock.synced, markCrossingFailed: mock.failed, markCrossingRejected: mock.rejected
}));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mock.calls.length = 0; mock.enabled = true; mock.token = "a".repeat(43);
  mock.events = [{ clientEventId: "one", garageId: "west", trackingConfigVersion: 2, radiusMeters: 50,
    direction: "entered", callbackReceivedAt: "2026-10-22T00:00:00Z", speedMetersPerSecond: null,
    speedMeasuredAt: null, accuracyMeters: null, attempts: 0 }];
  vi.stubGlobal("fetch", mock.fetch);
});
afterEach(() => vi.unstubAllGlobals());
it("does no network work while disabled or unenrolled", async () => {
  const sync = await import("./crossingSync");
  mock.enabled = false; await sync.syncDueCrossings();
  mock.enabled = true; mock.token = null; await sync.syncDueCrossings();
  expect(mock.fetch).not.toHaveBeenCalled();
});
it("reuses the v1 credential and serializes overlapping sync calls", async () => {
  const sync = await import("./crossingSync");
  mock.fetch.mockImplementation(async (_url, options) => {
    expect(options.headers.Authorization).toBe(`Bearer ${"a".repeat(43)}`);
    mock.events = [];
    return { ok: true, status: 200, json: async () => ({ acknowledgements: [{ clientEventId: "one", status: "accepted" }] }) };
  });
  await Promise.all([sync.syncDueCrossings(), sync.syncDueCrossings(), sync.syncDueCrossings()]);
  expect(mock.calls).toEqual(["west-garage-installation-token-v1"]);
  expect(mock.fetch).toHaveBeenCalledTimes(1); expect(mock.synced).toHaveBeenCalledWith("one");
});
it("retains the event after a failed request and clears a revoked token", async () => {
  const sync = await import("./crossingSync");
  mock.fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
  await expect(sync.syncDueCrossings()).rejects.toThrow("revoked");
  expect(mock.token).toBeNull(); expect(mock.synced).not.toHaveBeenCalled();
  expect(mock.failed).toHaveBeenCalledWith("one", 1, expect.any(Number));
});
it("rejects failed enrollment without replacing the existing credential", async () => {
  const sync = await import("./crossingSync");
  mock.fetch.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "expired code" }) });
  await expect(sync.enrollInstallation("123456789012")).rejects.toThrow("expired code");
  expect(mock.token).toBe("a".repeat(43));
});
it("aborts an in-flight upload when paused and leaves it pending", async () => {
  const sync = await import("./crossingSync");
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  mock.fetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(new Error("aborted"))); started();
  }));
  const work = sync.syncDueCrossings();
  const assertion = expect(work).rejects.toThrow("aborted");
  await ready; sync.pauseCrossingSync(); await assertion;
  expect(mock.synced).not.toHaveBeenCalled(); expect(mock.failed).toHaveBeenCalledTimes(1);
});
