import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";

export type CrossingUpload = {
  clientEventId: string; garageId: "west"; trackingConfigVersion: 2;
  radiusMeters: 50 | 100 | 150 | 160; direction: "entered" | "exited";
  callbackReceivedAt: string; speedMetersPerSecond: number | null;
  speedMeasuredAt: string | null; accuracyMeters: number | null;
};
export type CrossingAcknowledgement = { clientEventId: string; status: "accepted" | "duplicate" | "rejected"; error?: string };
export class CrossingInputError extends Error {}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = ["clientEventId", "garageId", "trackingConfigVersion", "radiusMeters", "direction", "callbackReceivedAt", "speedMetersPerSecond", "speedMeasuredAt", "accuracyMeters"];
function utc(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}
function nonnegative(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function validateCrossing(value: unknown): CrossingUpload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrossingInputError("Event must be an object.");
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(item, key))) throw new CrossingInputError("Event fields are invalid; coordinates and extra fields are not accepted.");
  if (typeof item.clientEventId !== "string" || !UUID.test(item.clientEventId)) throw new CrossingInputError("Invalid clientEventId.");
  if (item.garageId !== "west" || item.trackingConfigVersion !== 2) throw new CrossingInputError("Unsupported garage configuration.");
  if (![50, 100, 150, 160].includes(item.radiusMeters as number) || !["entered", "exited"].includes(item.direction as string)) throw new CrossingInputError("Invalid radius or direction.");
  if (!utc(item.callbackReceivedAt)) throw new CrossingInputError("callbackReceivedAt must be a valid UTC timestamp.");
  if (item.speedMetersPerSecond === null) {
    if (item.speedMeasuredAt !== null || item.accuracyMeters !== null) throw new CrossingInputError("Unavailable speed requires null sample time and accuracy.");
  } else if (!nonnegative(item.speedMetersPerSecond) || !nonnegative(item.accuracyMeters) || !utc(item.speedMeasuredAt)) {
    throw new CrossingInputError("Speed requires a finite nonnegative speed, accuracy, and valid UTC sample time.");
  }
  // Fixed field order makes retry equality independent of JSON property ordering.
  return Object.fromEntries(FIELDS.map(key => [key, item[key]])) as CrossingUpload;
}
export function validateCrossingEnvelope(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "events") throw new CrossingInputError("Expected only an events array.");
  const events = (value as { events: unknown }).events;
  if (!Array.isArray(events) || events.length < 1 || events.length > 25) throw new CrossingInputError("Batch must contain 1 to 25 events.");
  for (const event of events) {
    const id = event && typeof event === "object" && !Array.isArray(event) ? (event as Record<string, unknown>).clientEventId : undefined;
    if (typeof id !== "string" || !UUID.test(id)) throw new CrossingInputError("Every event needs a valid clientEventId.");
  }
  return events;
}
type Existing = RowDataPacket & { installation_id: string; payload_json: string };
export class ParkingCrossingService {
  private pool?: Pool;
  constructor(private readonly databaseUrl = process.env.PARKING_VISITS_DATABASE_URL, pool?: Pool) { this.pool = pool; }
  private database(): Pool {
    if (this.pool) return this.pool;
    if (!this.databaseUrl) throw new Error("Crossing upload database is not configured.");
    return this.pool = createPool({ uri: this.databaseUrl, connectionLimit: 5 });
  }
  async processBatch(installationId: string, items: unknown[]): Promise<CrossingAcknowledgement[]> {
    const results: CrossingAcknowledgement[] = [];
    for (const item of items) {
      let event: CrossingUpload;
      try { event = validateCrossing(item); }
      catch (error) {
        if (!(error instanceof CrossingInputError)) throw error;
        results.push({ clientEventId: (item as { clientEventId: string }).clientEventId, status: "rejected", error: error.message });
        continue;
      }
      const payload = JSON.stringify(event);
      try {
        await this.database().execute("INSERT INTO parking_crossing_events (client_event_id, installation_id, payload_json, created_at_utc) VALUES (?, ?, ?, ?)", [event.clientEventId, installationId, payload, Date.now()]);
        results.push({ clientEventId: event.clientEventId, status: "accepted" });
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        const [rows] = await this.database().execute<Existing[]>("SELECT installation_id, payload_json FROM parking_crossing_events WHERE client_event_id = ?", [event.clientEventId]);
        results.push(rows[0]?.installation_id === installationId && rows[0]?.payload_json === payload
          ? { clientEventId: event.clientEventId, status: "duplicate" }
          : { clientEventId: event.clientEventId, status: "rejected", error: "Event ID conflicts with an existing record." });
      }
    }
    return results;
  }
  async close(): Promise<void> { await this.pool?.end(); }
}
