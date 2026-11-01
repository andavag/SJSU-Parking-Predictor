import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createPool, type Pool, type RowDataPacket } from "mysql2/promise";
import type { ParkingVisitAcknowledgement, ParkingVisitUpload } from "./types.js";

export class VisitInputError extends Error {}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const CODE = /^\d{12}$/;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }

export function validateVisit(value: unknown): ParkingVisitUpload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VisitInputError("Visit must be an object.");
  const item = value as Record<string, unknown>;
  const keys = ["clientVisitId", "garageId", "startedAt", "completedAt", "elapsedSeconds", "classification", "confidence", "trackingConfigVersion"];
  if (Object.keys(item).length !== keys.length || keys.some(key => !(key in item))) throw new VisitInputError("Visit fields are invalid.");
  if (typeof item.clientVisitId !== "string" || !UUID.test(item.clientVisitId)) throw new VisitInputError("Invalid clientVisitId.");
  if (item.garageId !== "west" || item.trackingConfigVersion !== 1) throw new VisitInputError("Unsupported garage configuration.");
  if (item.classification !== "arrived_by_vehicle") throw new VisitInputError("Invalid classification.");
  if (!["high", "medium", "low"].includes(String(item.confidence))) throw new VisitInputError("Invalid confidence.");
  if (typeof item.startedAt !== "string" || typeof item.completedAt !== "string" || !ISO_UTC.test(item.startedAt) || !ISO_UTC.test(item.completedAt)) {
    throw new VisitInputError("Timestamps must be ISO UTC.");
  }
  const start = Date.parse(item.startedAt), end = Date.parse(item.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 60 * 60_000) throw new VisitInputError("Invalid visit duration.");
  if (typeof item.elapsedSeconds !== "number" || !Number.isInteger(item.elapsedSeconds) || item.elapsedSeconds < 120 || Math.abs(item.elapsedSeconds - Math.round((end - start) / 1000)) > 1) {
    throw new VisitInputError("elapsedSeconds does not match timestamps.");
  }
  return item as unknown as ParkingVisitUpload;
}

export function validateBatch(value: unknown): ParkingVisitUpload[] {
  return validateBatchEnvelope(value).map(validateVisit);
}

export function validateBatchEnvelope(value: unknown): unknown[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join() !== "visits") {
    throw new VisitInputError("Expected a visits array.");
  }
  const visits = (value as { visits: unknown }).visits;
  if (!Array.isArray(visits) || visits.length < 1 || visits.length > 25) throw new VisitInputError("Batch must contain 1 to 25 visits.");
  for (const item of visits) {
    const id = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).clientVisitId : undefined;
    if (typeof id !== "string" || !UUID.test(id)) {
      throw new VisitInputError("Every visit needs a valid clientVisitId.");
    }
  }
  return visits;
}

type InstallationRow = RowDataPacket & { id: string };
type ExistingVisitRow = RowDataPacket & { installation_id: string; payload_json: string };

export class ParkingVisitService {
  private pool?: Pool;
  constructor(private readonly databaseUrl = process.env.PARKING_VISITS_DATABASE_URL, pool?: Pool) { this.pool = pool; }

  private database(): Pool {
    if (this.pool) return this.pool;
    if (!this.databaseUrl) throw new Error("Visit upload database is not configured.");
    this.pool ??= createPool({ uri: this.databaseUrl, connectionLimit: 5 });
    return this.pool;
  }

  async enroll(code: unknown): Promise<{ installationId: string; token: string }> {
    if (typeof code !== "string" || !CODE.test(code)) throw new VisitInputError("Invalid enrollment code.");
    const connection = await this.database().getConnection();
    try {
      await connection.beginTransaction();
      const [codes] = await connection.execute<RowDataPacket[]>(
        "SELECT code_hash FROM parking_enrollment_codes WHERE code_hash = ? AND redeemed_at_utc IS NULL AND expires_at_utc > ? FOR UPDATE",
        [hash(code), Date.now()]
      );
      if (codes.length !== 1) throw new VisitInputError("Enrollment code expired or already used.");
      const installationId = randomUUID();
      const token = randomBytes(32).toString("base64url");
      await connection.execute("INSERT INTO parking_installations (id, token_hash, created_at_utc) VALUES (?, ?, ?)", [installationId, hash(token), Date.now()]);
      await connection.execute("UPDATE parking_enrollment_codes SET redeemed_at_utc = ?, installation_id = ? WHERE code_hash = ?", [Date.now(), installationId, hash(code)]);
      await connection.commit();
      return { installationId, token };
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }

  async authenticate(header: string | undefined): Promise<string | undefined> {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? "");
    if (!match) return undefined;
    const [rows] = await this.database().execute<InstallationRow[]>(
      "SELECT id FROM parking_installations WHERE token_hash = ? AND revoked_at_utc IS NULL LIMIT 1", [hash(match[1])]
    );
    return rows[0]?.id;
  }

  async saveBatch(installationId: string, visits: ParkingVisitUpload[]): Promise<ParkingVisitAcknowledgement[]> {
    const results: ParkingVisitAcknowledgement[] = [];
    for (const visit of visits) {
      const payload = JSON.stringify(visit);
      try {
        await this.database().execute(
          "INSERT INTO parking_visit_summaries (client_visit_id, installation_id, payload_json, created_at_utc) VALUES (?, ?, ?, ?)",
          [visit.clientVisitId, installationId, payload, Date.now()]
        );
        results.push({ clientVisitId: visit.clientVisitId, status: "accepted" });
      } catch (error) {
        if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
        const [rows] = await this.database().execute<ExistingVisitRow[]>(
          "SELECT installation_id, payload_json FROM parking_visit_summaries WHERE client_visit_id = ?", [visit.clientVisitId]
        );
        results.push(rows[0]?.installation_id === installationId && rows[0]?.payload_json === payload
          ? { clientVisitId: visit.clientVisitId, status: "duplicate" }
          : { clientVisitId: visit.clientVisitId, status: "rejected", error: "Visit ID conflicts with an existing record." });
      }
    }
    return results;
  }

  async processBatch(installationId: string, items: unknown[]): Promise<ParkingVisitAcknowledgement[]> {
    const results: ParkingVisitAcknowledgement[] = [];
    for (const item of items) {
      try { results.push(...await this.saveBatch(installationId, [validateVisit(item)])); }
      catch (error) {
        if (!(error instanceof VisitInputError)) throw error;
        results.push({ clientVisitId: (item as { clientVisitId: string }).clientVisitId, status: "rejected", error: error.message });
      }
    }
    return results;
  }

  async close(): Promise<void> { await this.pool?.end(); }
}
