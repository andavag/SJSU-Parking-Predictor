import { DateTime } from "luxon";
import { ForecastWorkerClient, type ForecastWorker, type WorkerForecastPoint } from "./forecastWorkerClient.js";
import { ParkingHistoryService } from "./parkingHistoryService.js";
import { GARAGES } from "./parkingParser.js";
import type { GarageId, ParkingHistoryReading } from "./types.js";

export const CAMPUS_TIMEZONE = "America/Los_Angeles";
export const ALGORITHMS = [
  { id: "same_time_previous_week", name: "Same time last week", version: "3", description: "Uses the closest recorded percentage to the same campus day and time one week earlier." },
  { id: "linear_regression", name: "Linear regression", version: "2", description: "Learns recurring daily and weekly time patterns from reported history." },
  { id: "logistic_regression", name: "Logistic regression (bounded)", version: "2", description: "Learns recurring patterns on a bounded logistic scale." },
  { id: "polynomial_regression", name: "Polynomial regression (last 10 readings)", version: "2", description: "Fits a quadratic curve to each garage's newest ten 15-minute readings." },
  { id: "kalman_filter", name: "Kalman filter", version: "1", description: "Smooths the current occupancy state and short-term rate of change." },
  { id: "knn_regression", name: "kNN regression", version: "1", description: "Finds historically similar calendar and occupancy situations." },
  { id: "sarima", name: "SARIMA", version: "1", description: "Learns repeating daily and, when enough data exists, weekly time-series cycles." },
  { id: "gradient_boosting", name: "Gradient boosting", version: "1", description: "Learns nonlinear time and recent-occupancy patterns from historical examples." },
  { id: "mlp", name: "MLP neural network", version: "1", description: "A small neural network trained from time and occupancy features." },
  { id: "ensemble", name: "Ensemble", version: "1", description: "Combines the best recently validated forecast models." }
] as const;

export class PredictionInputError extends Error {}
export interface PredictionRequest { algorithm?: string; targetTime?: string; minutesAhead?: string }
export interface ForecastPoint { time: string; fullnessPercent: number | null }
export interface GaragePrediction { id: GarageId; name: string; fullnessPercent: number | null; sourceTime: string | null; reportedAt: string | null }
export interface PredictionResponse {
  apiVersion: 1; currentTime: string; targetTime: string; timezone: string;
  algorithm: typeof ALGORITHMS[number]; predictions: GaragePrediction[];
  graph: { startTime: string; endTime: string; series: { id: GarageId; name: string; observed: ForecastPoint[]; forecast: ForecastPoint[] }[] };
}

type HistoryReader = Pick<ParkingHistoryService, "getReadingsBetween">;
const iso = (date: DateTime) => date.toISO()!;
const sqlTime = (date: DateTime) => date.toFormat("yyyy-MM-dd HH:mm:ss");
const minuteKey = (date: DateTime) => date.toFormat("yyyy-MM-dd'T'HH:mm");
const reportedDate = (reading: ParkingHistoryReading) => DateTime.fromISO(reading.reportedAt, { zone: CAMPUS_TIMEZONE });

export class PredictionService {
  constructor(
    private readonly history: HistoryReader = new ParkingHistoryService(),
    private readonly clock: () => DateTime = () => DateTime.now(),
    private readonly worker: ForecastWorker = new ForecastWorkerClient()
  ) {}

  async predict(input: PredictionRequest): Promise<PredictionResponse> {
    const requested = input.algorithm === "same_time_previous_day" ? "same_time_previous_week" : (input.algorithm ?? "same_time_previous_week");
    const algorithm = ALGORITHMS.find(candidate => candidate.id === requested);
    if (!algorithm) throw new PredictionInputError("Unknown prediction algorithm.");
    if (input.targetTime !== undefined && input.minutesAhead !== undefined) throw new PredictionInputError("Choose either an exact time or minutes ahead.");
    const now = this.clock().setZone(CAMPUS_TIMEZONE).startOf("minute");
    let target = now;
    if (input.minutesAhead !== undefined) {
      if (!/^\d{1,2}$/.test(input.minutesAhead) || Number(input.minutesAhead) < 1 || Number(input.minutesAhead) > 90) {
        throw new PredictionInputError("Minutes ahead must be between 1 and 90.");
      }
      target = now.plus({ minutes: Number(input.minutesAhead) });
    }
    if (input.targetTime !== undefined) {
      if (!/(Z|[+-]\d{2}:\d{2})$/i.test(input.targetTime)) throw new PredictionInputError("Exact time must include a timezone offset.");
      target = DateTime.fromISO(input.targetTime, { setZone: true }).setZone(CAMPUS_TIMEZONE).startOf("minute");
      if (!target.isValid) throw new PredictionInputError("Invalid prediction time.");
    }
    const start = now.minus({ minutes: 90 });
    const end = now.plus({ minutes: 90 });
    const [observedRows, forecast] = await Promise.all([
      this.history.getReadingsBetween(sqlTime(start), sqlTime(end.plus({ minutes: 1 }))),
      this.worker.forecast({ algorithm: algorithm.id, now: iso(now), target: iso(target), graphMinutes: 91 })
    ]);
    const observed = new Map<string, ParkingHistoryReading>();
    for (const row of observedRows) {
      const date = reportedDate(row);
      if (!date.isValid || !Number.isFinite(row.fullnessPercent) || row.fullnessPercent < 0 || row.fullnessPercent > 100) continue;
      const key = `${row.garageName}|${minuteKey(date)}`;
      const previous = observed.get(key);
      if (!previous || previous.reportedAt < row.reportedAt) observed.set(key, row);
    }
    const predictionByGarage = new Map(forecast.predictions.map(prediction => [prediction.garageName, prediction]));
    const workerPoints = (name: string) => new Map((forecast.forecast[name] ?? []).map(point => [minuteKey(DateTime.fromISO(point.time, { setZone: true }).setZone(CAMPUS_TIMEZONE)), point]));
    return {
      apiVersion: 1, currentTime: iso(now), targetTime: iso(target), timezone: CAMPUS_TIMEZONE, algorithm,
      predictions: GARAGES.map(garage => {
        const prediction = predictionByGarage.get(garage.name);
        return { id: garage.id, name: garage.name, fullnessPercent: prediction?.fullnessPercent ?? null,
          sourceTime: prediction?.sourceTime ?? null, reportedAt: prediction?.reportedAt ?? null };
      }),
      graph: { startTime: iso(start), endTime: iso(end), series: GARAGES.map(garage => {
        const points = workerPoints(garage.name);
        return {
          id: garage.id, name: garage.name,
          observed: Array.from({ length: 91 }, (_, index) => {
            const time = start.plus({ minutes: index });
            return { time: iso(time), fullnessPercent: observed.get(`${garage.name}|${minuteKey(time)}`)?.fullnessPercent ?? null };
          }),
          forecast: Array.from({ length: 91 }, (_, index) => {
            const time = now.plus({ minutes: index });
            const point: WorkerForecastPoint | undefined = points.get(minuteKey(time));
            return { time: iso(time), fullnessPercent: point?.fullnessPercent ?? null };
          })
        };
      }) }
    };
  }

  async evaluation(): Promise<Record<string, unknown>> {
    return this.worker.evaluation();
  }
}
