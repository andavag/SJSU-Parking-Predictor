import { createHash, randomInt } from "node:crypto";
import { createPool } from "mysql2/promise";

const databaseUrl = process.env.PARKING_VISITS_DATABASE_URL;
if (!databaseUrl) throw new Error("PARKING_VISITS_DATABASE_URL is required.");
const pool = createPool(databaseUrl);

try {
  const [command, value] = process.argv.slice(2);
  if (command === "code") {
    const code = randomInt(0, 1_000_000_000_000).toString().padStart(12, "0");
    const codeHash = createHash("sha256").update(code).digest("hex");
    await pool.execute("INSERT INTO parking_enrollment_codes (code_hash, expires_at_utc) VALUES (?, ?)", [codeHash, Date.now() + 15 * 60_000]);
    console.log(`One-time code (expires in 15 minutes): ${code}`);
  } else if (command === "revoke" && value) {
    const [result] = await pool.execute("UPDATE parking_installations SET revoked_at_utc = ? WHERE id = ? AND revoked_at_utc IS NULL", [Date.now(), value]);
    console.log(`Installations revoked: ${(result as { affectedRows: number }).affectedRows}`);
  } else if (command === "list") {
    const [rows] = await pool.execute("SELECT id, created_at_utc, revoked_at_utc FROM parking_installations ORDER BY created_at_utc DESC");
    console.table(rows);
  } else {
    throw new Error("Usage: npm run visits:admin -- code | list | revoke <installation-id>");
  }
} finally { await pool.end(); }
