import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Pool } from "mysql2/promise";
import { expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { ParkingVisitService } from "../src/parkingVisits.js";
import { ParkingCrossingService } from "../src/parkingCrossings.js";
it("serves health, authorizes tokens, rejects revoked tokens, bounds writes and preserves the v1 route", async () => {
  const token = "a".repeat(43), tokenHash = createHash("sha256").update(token).digest("hex");
  let revoked = false;
  const pool = { execute: async (_sql: string, params: string[]) => [params[0] === tokenHash && !revoked ? [{ id: "test-installation" }] : []] } as unknown as Pool;
  const visits = new ParkingVisitService(undefined, pool);
  const crossings = new ParkingCrossingService();
  const process = vi.spyOn(crossings, "processBatch").mockResolvedValue([{ clientEventId: "event-id", status: "accepted" }]);
  const server = createServer(createApp(undefined, undefined, undefined, visits, crossings));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: string, auth?: string, path = "/v1/parking-crossings/batch") => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body
  });
  try {
    expect((await fetch(base + "/health")).status).toBe(200);
    expect((await post('{"events":[]}')).status).toBe(401);
    expect((await post('{"events":[]}', "b".repeat(43))).status).toBe(401);
    expect((await post('{"events":[]}', token)).status).toBe(400);
    expect((await post("{", token)).status).toBe(400);
    expect((await post(JSON.stringify({ events: [], padding: "x".repeat(65_536) }), token)).status).toBe(413);
    const event = { clientEventId: randomUUID() };
    const response = await post(JSON.stringify({ events: [event] }), token);
    expect(response.status).toBe(200);
    expect((await response.json()).acknowledgements).toHaveLength(1);
    expect(process).toHaveBeenCalledWith("test-installation", [event]);
    revoked = true;
    expect((await post(JSON.stringify({ events: [event] }), token)).status).toBe(401);
    expect(process).toHaveBeenCalledTimes(1);
    expect((await post('{"visits":[]}', undefined, "/v1/parking-visits/batch")).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await post('{"events":[]}')).status).toBe(401);
    expect((await post('{"events":[]}')).status).toBe(429);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15_000);
