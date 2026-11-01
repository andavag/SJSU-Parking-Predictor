import * as BackgroundTask from "expo-background-task";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { captureSpeed, radiusForRegion, RADII, regionId, WEST_GARAGE } from "./crossingTypes";
import { finishSpeed, getLoggingSettings, recordCrossing, saveLoggingEnabled, saveLoggingError } from "./crossingStore";
import { pauseCrossingSync, syncDueCrossings } from "./crossingSync";

export const GEOFENCE_TASK = "west-garage-crossings-geofence-v2";
export const SYNC_TASK = "west-garage-crossings-sync-v2";
const OLD_GEOFENCE = "west-garage-geofence-v1";
const OLD_SYNC = "west-garage-sync-v1";
type GeofenceData = { eventType: Location.GeofencingEventType; region: Location.LocationRegion };

// Old native registrations may wake the new bundle before the UI has launched.
// These retirement handlers never open the old database or collect/upload visits.
TaskManager.defineTask(OLD_GEOFENCE, async () => { await retireLegacyTasks(); });
TaskManager.defineTask(OLD_SYNC, async () => { await retireLegacyTasks(); return BackgroundTask.BackgroundTaskResult.Success; });
TaskManager.defineTask<GeofenceData>(GEOFENCE_TASK, async ({ data, error }) => {
  const receivedAt = Date.now();
  try {
    if (error) { await saveLoggingError(`Geofence: ${error.message}`); return; }
    if (!data) return;
    const radius = radiusForRegion(data.region.identifier);
    const direction = data.eventType === Location.GeofencingEventType.Enter ? "entered"
      : data.eventType === Location.GeofencingEventType.Exit ? "exited" : undefined;
    if (radius === undefined || direction === undefined) return;
    const id = await recordCrossing(radius, direction, receivedAt);
    if (!id) return;
    const sample = await captureSpeed(
      () => Location.getLastKnownPositionAsync({ maxAge: 30_000, requiredAccuracy: 50 }),
      () => Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High })
    );
    await finishSpeed(id, sample);
  } catch (failure) { await saveLoggingError(failure instanceof Error ? failure.message : "Could not save crossing."); }
});
TaskManager.defineTask(SYNC_TASK, async () => {
  try { await syncDueCrossings(); return BackgroundTask.BackgroundTaskResult.Success; }
  catch { return BackgroundTask.BackgroundTaskResult.Failed; }
});

let retirement: Promise<void> | undefined;
export function retireLegacyTasks(): Promise<void> {
  retirement ??= (async () => {
    if (await Location.hasStartedGeofencingAsync(OLD_GEOFENCE)) await Location.stopGeofencingAsync(OLD_GEOFENCE);
    if (await TaskManager.isTaskRegisteredAsync(OLD_GEOFENCE)) await TaskManager.unregisterTaskAsync(OLD_GEOFENCE);
    if (await TaskManager.isTaskRegisteredAsync(OLD_SYNC)) await BackgroundTask.unregisterTaskAsync(OLD_SYNC);
  })().catch(error => { retirement = undefined; throw error; });
  return retirement;
}
export type LoggingStatus = "logging active" | "logging paused" | "precise location missing" | "background permission missing" | "location services disabled" | "background tracking unavailable";
export async function loggingStatus(): Promise<LoggingStatus> {
  if (Platform.OS !== "android") return "background tracking unavailable";
  if (!(await getLoggingSettings()).enabled) return "logging paused";
  if (!await Location.hasServicesEnabledAsync()) return "location services disabled";
  const permission = await Location.getForegroundPermissionsAsync();
  if (!permission.granted || permission.android?.accuracy !== "fine") return "precise location missing";
  if (!(await Location.getBackgroundPermissionsAsync()).granted) return "background permission missing";
  if (!await TaskManager.isAvailableAsync() || !await Location.isBackgroundLocationAvailableAsync()) return "background tracking unavailable";
  return "logging active";
}
let lifecycle: Promise<unknown> = Promise.resolve();
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const next = lifecycle.then(work);
  lifecycle = next.catch(() => undefined);
  return next;
}
async function reconcile(): Promise<LoggingStatus> {
  if (Platform.OS !== "android") return "background tracking unavailable";
  await retireLegacyTasks();
  const status = await loggingStatus();
  if (status !== "logging active") {
    pauseCrossingSync();
    if (await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) await Location.stopGeofencingAsync(GEOFENCE_TASK);
    if (await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) await BackgroundTask.unregisterTaskAsync(SYNC_TASK);
    return status;
  }
  if (!await Location.hasStartedGeofencingAsync(GEOFENCE_TASK)) {
    await Location.startGeofencingAsync(GEOFENCE_TASK, RADII.map(radius => ({ ...WEST_GARAGE, radius, identifier: regionId(radius), notifyOnEnter: true, notifyOnExit: true })));
  }
  if (await BackgroundTask.getStatusAsync() === BackgroundTask.BackgroundTaskStatus.Available && !await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) {
    await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: 1440 });
  }
  return status;
}
export const reconcileLogging = () => exclusive(reconcile);
export function setLoggingEnabled(enabled: boolean): Promise<LoggingStatus> {
  if (!enabled) pauseCrossingSync();
  return exclusive(async () => { await saveLoggingEnabled(enabled); return reconcile(); });
}
