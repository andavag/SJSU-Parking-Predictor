// Run by deploy-west-garage.sh as root, against the loopback API and real MySQL.
import assert from "node:assert/strict";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createPool } from "mysql2/promise";
if (process.getuid?.() !== 0) throw new Error("Run via the root deployment script; cleanup uses local MySQL admin access.");
const pool = createPool(process.env.PARKING_VISITS_DATABASE_URL!);
const code = String(randomInt(100_000, 1_000_000)) + String(randomInt(100_000, 1_000_000));
const codeHash = createHash("sha256").update(code).digest("hex");
const event = { clientEventId: randomUUID(), garageId: "west", trackingConfigVersion: 2,
  radiusMeters: 50, direction: "entered", callbackReceivedAt: new Date().toISOString(),
  speedMetersPerSecond: null, speedMeasuredAt: null, accuracyMeters: null };
async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(`http://127.0.0.1:3000${path}`, { method: "POST", signal: AbortSignal.timeout(5000),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const path = "/v1/parking-crossings/batch";
try {
  assert.equal((await fetch("http://127.0.0.1:3000/health")).status, 200);
  assert.equal((await post(path, { events: [event] })).status, 401);
  await pool.execute("INSERT INTO parking_enrollment_codes (code_hash, expires_at_utc) VALUES (?, ?)", [codeHash, Date.now() + 60_000]);
  const enrollment = await post("/v1/installations/enroll", { code });
  assert.equal(enrollment.status, 201);
  const { token, installationId } = enrollment.body;
  assert.equal((await post("/v1/installations/enroll", { code })).status, 400);
  assert.equal((await post(path, { events: [] }, token)).status, 400);
  const malformed = await post(path, { events: [{ ...event, latitude: 37 }] }, token);
  assert.equal(malformed.status, 200);
  assert.equal(malformed.body.acknowledgements[0].status, "rejected");
  const accepted = await post(path, { events: [event] }, token);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.acknowledgements[0].status, "accepted");
  assert.equal((await post(path, { events: [event] }, token)).body.acknowledgements[0].status, "duplicate");
  assert.equal((await post(path, { events: [{ ...event, direction: "exited" }] }, token)).body.acknowledgements[0].status, "rejected");
  await pool.execute("UPDATE parking_installations SET revoked_at_utc = ? WHERE id = ?", [Date.now(), installationId]);
  assert.equal((await post(path, { events: [event] }, token)).status, 401);
  console.log("Crossing smoke checks passed: enrollment, authorization, validation, insertion, retry, conflict, revocation.");
} finally {
  await pool.end();
  // Only this run's synthetic enrollment/installation/event are removed. The API
  // writer deliberately has no DELETE grant. No token or code is printed.
  execFileSync("mysql", ["sjsu_parking"], { input: `
    SET @smoke_installation = (SELECT installation_id FROM parking_enrollment_codes WHERE code_hash = '${codeHash}');
    DELETE FROM parking_crossing_events WHERE client_event_id = '${event.clientEventId}' AND installation_id = @smoke_installation;
    DELETE FROM parking_enrollment_codes WHERE code_hash = '${codeHash}';
    DELETE FROM parking_installations WHERE id = @smoke_installation;
  `, stdio: ["pipe", "pipe", "pipe"] });
}
