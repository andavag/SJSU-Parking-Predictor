import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  handlers: new Map<string, (input: unknown) => Promise<unknown>>(), enabled: false, precise: true, background: true,
  registered: new Set<string>(), fences: new Set<string>(), order: [] as string[],
  record: vi.fn(async () => "event-id"), finish: vi.fn(), pause: vi.fn(), sync: vi.fn(), start: vi.fn(), saveError: vi.fn()
}));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
vi.mock("expo-task-manager", () => ({
  defineTask: (name: string, handler: (input: unknown) => Promise<unknown>) => mock.handlers.set(name, handler),
  isAvailableAsync: async () => true,
  isTaskRegisteredAsync: async (name: string) => mock.registered.has(name),
  unregisterTaskAsync: async (name: string) => { mock.order.push(`unregister:${name}`); mock.registered.delete(name); }
}));
vi.mock("expo-location", () => ({
  GeofencingEventType: { Enter: 1, Exit: 2 }, Accuracy: { High: 4 },
  hasServicesEnabledAsync: async () => true, isBackgroundLocationAvailableAsync: async () => true,
  getForegroundPermissionsAsync: async () => ({ granted: true, android: { accuracy: mock.precise ? "fine" : "coarse" } }),
  getBackgroundPermissionsAsync: async () => ({ granted: mock.background }),
  hasStartedGeofencingAsync: async (name: string) => mock.fences.has(name),
  stopGeofencingAsync: async (name: string) => { mock.order.push(`stop:${name}`); mock.fences.delete(name); },
  startGeofencingAsync: async (name: string, regions: unknown) => { mock.order.push(`start:${name}`); mock.start(name, regions); mock.fences.add(name); },
  getLastKnownPositionAsync: async () => null,
  getCurrentPositionAsync: async () => { expect(mock.record).toHaveBeenCalled(); throw new Error("GPS unavailable"); }
}));
vi.mock("expo-background-task", () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 }, BackgroundTaskStatus: { Available: 2 },
  getStatusAsync: async () => 2,
  unregisterTaskAsync: async (name: string) => { mock.order.push(`unregister:${name}`); mock.registered.delete(name); },
  registerTaskAsync: async (name: string, options: unknown) => { expect(options).toEqual({ minimumInterval: 1440 }); mock.registered.add(name); }
}));
vi.mock("./crossingStore", () => ({
  getLoggingSettings: async () => ({ enabled: mock.enabled }),
  saveLoggingEnabled: async (enabled: boolean) => { mock.enabled = enabled; },
  recordCrossing: mock.record, finishSpeed: mock.finish, saveLoggingError: mock.saveError
}));
vi.mock("./crossingSync", () => ({ pauseCrossingSync: mock.pause, syncDueCrossings: mock.sync }));
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mock.handlers.clear(); mock.order.length = 0;
  mock.enabled = false; mock.precise = true; mock.background = true;
  mock.registered = new Set(["west-garage-geofence-v1", "west-garage-sync-v1"]);
  mock.fences = new Set(["west-garage-geofence-v1"]);
});
it("retires v1 on first launch even with v2 off, without registering v2", async () => {
  const runtime = await import("./crossingRuntime");
  await runtime.reconcileLogging();
  expect(mock.registered.size).toBe(0); expect(mock.fences.size).toBe(0);
  expect(mock.start).not.toHaveBeenCalled();
  await runtime.setLoggingEnabled(true);
  expect(mock.start).toHaveBeenCalledWith(runtime.GEOFENCE_TASK, [50, 100, 150, 160].map(radius => ({ radius,
    latitude: 37.3316667, longitude: -121.8827222, identifier: `west:crossing:v2:${radius}`, notifyOnEnter: true, notifyOnExit: true })));
  expect(mock.order.indexOf("unregister:west-garage-sync-v1")).toBeLessThan(mock.order.indexOf(`start:${runtime.GEOFENCE_TASK}`));
  await runtime.reconcileLogging(); expect(mock.start).toHaveBeenCalledTimes(1);
});
it("stops registrations on permission loss and on disable, preserving the queue", async () => {
  const runtime = await import("./crossingRuntime");
  await runtime.setLoggingEnabled(true);
  mock.precise = false;
  expect(await runtime.reconcileLogging()).toBe("precise location missing");
  expect(mock.fences.size).toBe(0); expect(mock.registered.size).toBe(0);
  mock.precise = true; mock.background = false;
  expect(await runtime.reconcileLogging()).toBe("background permission missing");
  expect(await runtime.setLoggingEnabled(false)).toBe("logging paused");
  expect(mock.pause).toHaveBeenCalled();
});
it("dispatches all eight directional callbacks and repeated out-of-order events before sampling", async () => {
  const runtime = await import("./crossingRuntime");
  const handler = mock.handlers.get(runtime.GEOFENCE_TASK)!;
  for (const radius of [160, 50, 150, 100]) for (const eventType of [2, 1]) {
    await handler({ data: { eventType, region: { identifier: `west:crossing:v2:${radius}` } } });
    expect(mock.record).toHaveBeenLastCalledWith(radius, eventType === 1 ? "entered" : "exited", expect.any(Number));
  }
  await handler({ data: { eventType: 2, region: { identifier: "west:crossing:v2:100" } } });
  expect(mock.record).toHaveBeenCalledTimes(9);
  expect(mock.finish).toHaveBeenCalledTimes(9);
  expect(mock.finish).toHaveBeenLastCalledWith("event-id", { speedMetersPerSecond: null, speedMeasuredAt: null, accuracyMeters: null });
});
it("legacy headless callbacks only retire old tasks", async () => {
  await import("./crossingRuntime");
  await mock.handlers.get("west-garage-geofence-v1")!({});
  expect(mock.record).not.toHaveBeenCalled(); expect(mock.sync).not.toHaveBeenCalled();
  expect(mock.registered.size).toBe(0);
});
