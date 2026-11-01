import express from "express";
import { ParkingHistoryService } from "./parkingHistoryService.js";
import { ParkingStatusService } from "./parkingService.js";
import { ALGORITHMS, PredictionInputError, PredictionService } from "./predictionService.js";
import { ParkingVisitService, validateBatchEnvelope, VisitInputError } from "./parkingVisits.js";
import { ParkingCrossingService, validateCrossingEnvelope, CrossingInputError } from "./parkingCrossings.js";

const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 30;

export function createApp(
  service = new ParkingStatusService(),
  historyService = new ParkingHistoryService(),
  predictionService = new PredictionService(historyService),
  visitService = new ParkingVisitService(),
  crossingService = new ParkingCrossingService()
) {
  const app = express();
  // Caddy is the only process that can reach this loopback-only API.  Trusting
  // that proxy lets Express use Caddy's X-Forwarded-For value for per-client
  // rate limiting without accepting a spoofed header from the public internet.
  app.set("trust proxy", "loopback");
  const requestCounts = new Map<string, { windowStartedAt: number; count: number }>();

  app.use("/v1", (request, response, next) => {
    const now = Date.now();
    const clientAddress = request.ip ?? "unknown";
    const previous = requestCounts.get(clientAddress);
    const current = !previous || now - previous.windowStartedAt >= RATE_LIMIT_WINDOW_MS
      ? { windowStartedAt: now, count: 0 }
      : previous;
    current.count += 1;
    requestCounts.set(clientAddress, current);
    if (current.count > MAX_REQUESTS_PER_WINDOW) {
      response.status(429).json({ error: "Too many requests. Please try again in a minute." });
      return;
    }
    next();
  });

  const writeCounts = new Map<string, { startedAt: number; count: number }>();
  const writeLimit = (maximum: number) => (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const key = `${request.path}:${request.ip ?? "unknown"}`;
    const now = Date.now();
    const previous = writeCounts.get(key);
    const current = !previous || now - previous.startedAt >= 60_000 ? { startedAt: now, count: 0 } : previous;
    current.count += 1;
    writeCounts.set(key, current);
    if (current.count > maximum) { response.status(429).json({ error: "Too many write requests. Try again later." }); return; }
    next();
  };
  const parseVisitJson = express.json({ limit: "64kb", strict: true });
  app.post("/v1/installations/enroll", writeLimit(5), parseVisitJson, async (request, response) => {
    response.set("Cache-Control", "no-store");
    try { response.status(201).json(await visitService.enroll(request.body?.code)); }
    catch (error) {
      response.status(error instanceof VisitInputError ? 400 : 503).json({
        error: error instanceof VisitInputError ? error.message : "Enrollment is temporarily unavailable."
      });
    }
  });
  app.post("/v1/parking-visits/batch", writeLimit(10), parseVisitJson, async (request, response) => {
    response.set("Cache-Control", "no-store");
    try {
      const installationId = await visitService.authenticate(request.get("authorization"));
      if (!installationId) { response.status(401).json({ error: "Installation authorization is missing or revoked." }); return; }
      const visits = validateBatchEnvelope(request.body);
      response.json({ acknowledgements: await visitService.processBatch(installationId, visits) });
    } catch (error) {
      response.status(error instanceof VisitInputError ? 400 : 503).json({
        error: error instanceof VisitInputError ? error.message : "Visit upload is temporarily unavailable."
      });
    }
  });

  app.post("/v1/parking-crossings/batch", writeLimit(10), parseVisitJson, async (request, response) => {
    response.set("Cache-Control", "no-store");
    try {
      const installationId = await visitService.authenticate(request.get("authorization"));
      if (!installationId) { response.status(401).json({ error: "Installation authorization is missing or revoked." }); return; }
      const events = validateCrossingEnvelope(request.body);
      response.json({ acknowledgements: await crossingService.processBatch(installationId, events) });
    } catch (error) {
      response.status(error instanceof CrossingInputError ? 400 : 503).json({
        error: error instanceof CrossingInputError ? error.message : "Crossing upload is temporarily unavailable."
      });
    }
  });

  app.get("/health", (_request, response) => response.json({ ok: true }));
  app.get("/v1/prediction-algorithms", (_request, response) => {
    response.set("Cache-Control", "no-store").json({ apiVersion: 1, algorithms: ALGORITHMS });
  });
  app.get("/v1/prediction-evaluation", async (_request, response) => {
    response.set("Cache-Control", "no-store");
    try {
      response.json(await predictionService.evaluation());
    } catch {
      response.status(503).json({ error: "Prediction evaluation is temporarily unavailable." });
    }
  });
  app.get("/v1/parking-predictions", async (request, response) => {
    response.set("Cache-Control", "no-store");
    try {
      const read = (name: string) => {
        const value = request.query[name];
        if (value !== undefined && typeof value !== "string") throw new PredictionInputError(`Invalid ${name}.`);
        return value;
      };
      response.json(await predictionService.predict({ algorithm: read("algorithm"),
        targetTime: read("targetTime"), minutesAhead: read("minutesAhead") }));
    } catch (error) {
      response.status(error instanceof PredictionInputError ? 400 : 503).json({
        error: error instanceof PredictionInputError ? error.message : "Parking predictions are temporarily unavailable."
      });
    }
  });
  app.get("/v1/parking-status", async (request, response) => {
    try {
      const status = await service.getStatus(request.query.refresh === "1");
      response.set("Cache-Control", "no-store").json(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to retrieve SJSU parking data.";
      response.status(503).json({ error: message });
    }
  });
  app.get("/v1/parking-history", async (_request, response) => {
    try {
      const history = await historyService.getLatestReadings();
      response.set("Cache-Control", "no-store").json(history);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to retrieve parking history.";
      response.status(503).json({ error: message });
    }
  });
  return app;
}
