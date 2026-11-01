import * as Crypto from "expo-crypto";
import * as SQLite from "expo-sqlite";
import { NO_SPEED, type Crossing, type Direction, type Radius, type SpeedSample, type StoredCrossing } from "./crossingTypes";

export const DATABASE_NAME = "west-garage-crossings-v2.db";
let dbPromise: Promise<SQLite.SQLiteDatabase> | undefined;
let writes: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
export function subscribeCrossings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function changed() { for (const listener of listeners) listener(); }
function write<T>(action: (db: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const result = writes.then(async () => action(await database()));
  writes = result.catch(() => undefined);
  return result.then(value => { changed(); return value; });
}
async function database(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= (async () => {
    const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
    await db.execAsync(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), enabled INTEGER NOT NULL, last_error TEXT);
      INSERT OR IGNORE INTO settings (id, enabled) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS crossings (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, client_event_id TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL, sample_state TEXT NOT NULL, sync_state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL, last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS crossings_due ON crossings(sync_state, next_attempt_at);
      UPDATE crossings SET sample_state = 'ready' WHERE sample_state = 'collecting';`);
    // Initialization precedes new callbacks in this JS runtime. An unfinished
    // sample from the prior process is already stored with unavailable speed.
    return db;
  })().catch(error => { dbPromise = undefined; throw error; });
  return dbPromise;
}
export async function getLoggingSettings(): Promise<{ enabled: boolean; lastError: string | null }> {
  const row = await (await database()).getFirstAsync<{ enabled: number; last_error: string | null }>("SELECT enabled, last_error FROM settings WHERE id = 1");
  return { enabled: Boolean(row?.enabled), lastError: row?.last_error ?? null };
}
export const saveLoggingEnabled = (enabled: boolean) => write(db => db.runAsync("UPDATE settings SET enabled = ?, last_error = NULL WHERE id = 1", enabled ? 1 : 0));
export const saveLoggingError = (message: string) => write(db => db.runAsync("UPDATE settings SET last_error = ? WHERE id = 1", message.slice(0, 300)));

// Enqueued immediately at callback receipt, before any native sampling awaits.
// Sequence (not device wall-clock time) preserves receipt order, even if the clock changes.
export function recordCrossing(radius: Radius, direction: Direction, at: number): Promise<string | undefined> {
  const event: Crossing = { clientEventId: Crypto.randomUUID(), garageId: "west", trackingConfigVersion: 2,
    radiusMeters: radius, direction, callbackReceivedAt: new Date(at).toISOString(), ...NO_SPEED };
  return write(async db => {
    let inserted = false;
    await db.withExclusiveTransactionAsync(async tx => {
      const settings = await tx.getFirstAsync<{ enabled: number }>("SELECT enabled FROM settings WHERE id = 1");
      if (!settings?.enabled) return;
      await tx.runAsync("INSERT INTO crossings (client_event_id, payload, sample_state, next_attempt_at) VALUES (?, ?, 'collecting', ?)",
        event.clientEventId, JSON.stringify(event), at + 86_400_000);
      inserted = true;
    });
    return inserted ? event.clientEventId : undefined;
  });
}
export function finishSpeed(id: string, sample: SpeedSample): Promise<void> {
  return write(async db => {
    await db.withExclusiveTransactionAsync(async tx => {
      const row = await tx.getFirstAsync<{ payload: string }>("SELECT payload FROM crossings WHERE client_event_id = ? AND sample_state = 'collecting' AND sync_state = 'pending'", id);
      if (!row) return; // Clear history or a completed upload must never be undone.
      const event = JSON.parse(row.payload) as Crossing;
      await tx.runAsync("UPDATE crossings SET payload = ?, sample_state = 'ready' WHERE client_event_id = ?", JSON.stringify({ ...event, ...sample }), id);
    });
  });
}
type Row = { sequence: number; payload: string; sample_state: StoredCrossing["sampleState"]; sync_state: StoredCrossing["syncState"]; attempts: number; next_attempt_at: number; last_error: string | null };
function decode(row: Row): StoredCrossing {
  return { ...JSON.parse(row.payload) as Crossing, sequence: row.sequence, sampleState: row.sample_state,
    syncState: row.sync_state, attempts: row.attempts, nextAttemptAt: row.next_attempt_at, lastError: row.last_error };
}
export async function getRecentCrossings(limit = 50): Promise<StoredCrossing[]> {
  return (await (await database()).getAllAsync<Row>("SELECT * FROM crossings ORDER BY sequence DESC LIMIT ?", limit)).map(decode);
}
export function getDueCrossings(now: number): Promise<StoredCrossing[]> {
  return write(async db => {
    // A process killed during sampling left a durable event with null speed.
    // Finalize it before uploading so its payload cannot change on a retry.
    await db.runAsync("UPDATE crossings SET sample_state = 'ready' WHERE sample_state = 'collecting' AND next_attempt_at <= ?", now);
    return (await db.getAllAsync<Row>("SELECT * FROM crossings WHERE sync_state = 'pending' AND next_attempt_at <= ? ORDER BY sequence LIMIT 25", now)).map(decode);
  });
}
export const markCrossingSynced = (id: string) => write(db => db.runAsync("UPDATE crossings SET sync_state = 'synced', last_error = NULL WHERE client_event_id = ?", id));
export const markCrossingRejected = (id: string, message: string) => write(db => db.runAsync("UPDATE crossings SET sync_state = 'blocked', last_error = ? WHERE client_event_id = ?", message.slice(0, 300), id));
export const markCrossingFailed = (id: string, attempts: number, now: number) => write(db => db.runAsync(
  "UPDATE crossings SET attempts = ?, next_attempt_at = ? WHERE client_event_id = ? AND sync_state = 'pending'",
  attempts, now + Math.min(86_400_000, 900_000 * 2 ** Math.min(attempts, 7)), id));
export const clearCrossings = () => write(db => db.runAsync("DELETE FROM crossings"));
