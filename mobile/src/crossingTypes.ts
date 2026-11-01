export const WEST_GARAGE = { latitude: 37.3316667, longitude: -121.8827222 };
export const RADII = [50, 100, 150, 160] as const;
export type Radius = typeof RADII[number];
export type Direction = "entered" | "exited";
export type SpeedSample = {
  speedMetersPerSecond: number | null;
  speedMeasuredAt: string | null;
  accuracyMeters: number | null;
};
export type Crossing = SpeedSample & {
  clientEventId: string;
  garageId: "west";
  trackingConfigVersion: 2;
  radiusMeters: Radius;
  direction: Direction;
  callbackReceivedAt: string;
};
export type StoredCrossing = Crossing & {
  sequence: number;
  sampleState: "collecting" | "ready";
  syncState: "pending" | "synced" | "blocked";
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};
export const NO_SPEED: SpeedSample = { speedMetersPerSecond: null, speedMeasuredAt: null, accuracyMeters: null };
export const regionId = (radius: Radius) => `west:crossing:v2:${radius}`;
export function radiusForRegion(id: string | undefined): Radius | undefined {
  return RADII.find(radius => regionId(radius) === id);
}

// Coordinates are deliberately absent from the stored/uploaded speed projection.
export type LocationSample = { timestamp: number; coords: { speed: number | null; accuracy: number | null } };
export function validSpeed(fix: LocationSample | null | undefined, now: number): SpeedSample | undefined {
  if (!fix || !Number.isFinite(fix.timestamp) || now - fix.timestamp < 0 || now - fix.timestamp > 30_000) return;
  const { speed, accuracy } = fix.coords;
  if (speed === null || accuracy === null || !Number.isFinite(speed) || speed < 0 || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 50) return;
  return { speedMetersPerSecond: speed, speedMeasuredAt: new Date(fix.timestamp).toISOString(), accuracyMeters: accuracy };
}

async function bounded<T>(work: () => Promise<T>, timeout: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeout); })]);
  } catch { return undefined; }
  finally { if (timer) clearTimeout(timer); }
}

export async function captureSpeed(last: () => Promise<LocationSample | null>, current: () => Promise<LocationSample>, now = Date.now): Promise<SpeedSample> {
  const cached = validSpeed(await bounded(last, 1_000), now());
  if (cached) return cached;
  // Expo's one-shot position API has no cancellation handle. Stop waiting after
  // ten seconds and ignore any later result; never keep the crossing unsaved.
  return validSpeed(await bounded(current, 10_000), now()) ?? { ...NO_SPEED };
}

export function uploadPayload(event: StoredCrossing): Crossing {
  const { clientEventId, garageId, trackingConfigVersion, radiusMeters, direction, callbackReceivedAt,
    speedMetersPerSecond, speedMeasuredAt, accuracyMeters } = event;
  return { clientEventId, garageId, trackingConfigVersion, radiusMeters, direction, callbackReceivedAt,
    speedMetersPerSecond, speedMeasuredAt, accuracyMeters };
}
