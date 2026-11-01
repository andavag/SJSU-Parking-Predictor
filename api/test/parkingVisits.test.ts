import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ParkingVisitService, validateBatch, validateVisit } from "../src/parkingVisits.js";
import type { Pool } from "mysql2/promise";

const visit = {
  clientVisitId: "123e4567-e89b-42d3-a456-426614174000", garageId: "west", startedAt: "2026-10-20T08:00:00.000Z",
  completedAt: "2026-10-20T08:09:00.000Z", elapsedSeconds: 540, classification: "arrived_by_vehicle",
  confidence: "high", trackingConfigVersion: 1
};

describe("parking visit uploads", () => {
  it("validates the summary contract and batch limits", () => {
    expect(validateVisit(visit)).toEqual(visit);
    expect(validateBatch({ visits: [visit] })).toHaveLength(1);
    expect(() => validateBatch({ visits: [] })).toThrow();
    expect(() => validateVisit({ ...visit, elapsedSeconds: 10 })).toThrow();
    expect(() => validateVisit({ ...visit, garageId: "north" })).toThrow();
  });

  it("acknowledges a repeated clientVisitId once without accepting a conflicting record", async () => {
    const rows = new Map<string, { installation_id: string; payload_json: string }>();
    const fake = { execute: async (sql: string, args: unknown[]) => {
      if (sql.startsWith("INSERT")) {
        const [id, installation, payload] = args as string[];
        if (rows.has(id)) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
        rows.set(id, { installation_id: installation, payload_json: payload });
        return [{ affectedRows: 1 }, []];
      }
      if (sql.startsWith("SELECT installation_id")) return [[rows.get(args[0] as string)], []];
      return [[], []];
    } } as unknown as Pool;
    const service = new ParkingVisitService(undefined, fake);
    const valid = validateVisit(visit);
    expect((await service.saveBatch("install-1", [valid]))[0].status).toBe("accepted");
    expect((await service.saveBatch("install-1", [valid]))[0].status).toBe("duplicate");
    expect((await service.saveBatch("install-2", [valid]))[0].status).toBe("rejected");
    expect((await service.saveBatch("install-2", [{ ...valid, confidence: "low" }]))[0].status).toBe("rejected");
    expect(rows.size).toBe(1);
    const partial = await service.processBatch("install-1", [valid, { ...valid, clientVisitId: "123e4567-e89b-42d3-a456-426614174001", elapsedSeconds: 1 }]);
    expect(partial.map(item => item.status)).toEqual(["duplicate", "rejected"]);
  });

  it("rejects missing and revoked installation tokens", async () => {
    const fake = { execute: async () => [[], []] } as unknown as Pool;
    const service = new ParkingVisitService(undefined, fake);
    await expect(service.authenticate(undefined)).resolves.toBeUndefined();
    await expect(service.authenticate(`Bearer ${"a".repeat(43)}`)).resolves.toBeUndefined();
  });

  it("redeems a one-time code for a hashed token and rejects code reuse", async () => {
    let redeemed = false;
    let savedHash = "";
    const connection = {
      beginTransaction: async () => undefined, commit: async () => undefined, rollback: async () => undefined,
      release: () => undefined,
      execute: async (sql: string, args: unknown[]) => {
        if (sql.startsWith("SELECT code_hash")) return [redeemed ? [] : [{ code_hash: args[0] }], []];
        if (sql.startsWith("INSERT INTO parking_installations")) savedHash = args[1] as string;
        if (sql.startsWith("UPDATE parking_enrollment_codes")) redeemed = true;
        return [{ affectedRows: 1 }, []];
      }
    };
    const fake = { getConnection: async () => connection } as unknown as Pool;
    const service = new ParkingVisitService(undefined, fake);
    const enrolled = await service.enroll("123456789012");
    expect(enrolled.installationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(savedHash).toBe(createHash("sha256").update(enrolled.token).digest("hex"));
    expect(savedHash).not.toBe(enrolled.token);
    await expect(service.enroll("123456789012")).rejects.toThrow("expired or already used");
  });
});
