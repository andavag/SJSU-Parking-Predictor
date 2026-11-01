import { DateTime } from "luxon";
import { describe, expect, it, vi } from "vitest";
import { ALGORITHMS, PredictionService } from "../src/predictionService.js";
import type { ForecastWorker, WorkerForecastResponse } from "../src/forecastWorkerClient.js";
import type { ParkingHistoryReading } from "../src/types.js";

const garages = ["North Garage", "West Garage", "South Garage", "South Campus Garage"];

function fixture(rows: ParkingHistoryReading[] = []) {
  const getReadingsBetween = vi.fn(async () => rows);
  const forecast = vi.fn(async (input: { algorithm: string; now: string; target: string; graphMinutes: number }): Promise<WorkerForecastResponse> => ({
    predictions: garages.map((garageName, index) => ({ garageName, fullnessPercent: 20 + index * 10,
      sourceTime: input.algorithm === "same_time_previous_week" ? "2026-10-05T12:30:00-07:00" : null,
      reportedAt: input.algorithm === "same_time_previous_week" ? "2026-10-05T12:30:00-07:00" : null })),
    forecast: Object.fromEntries(garages.map((garageName, index) => [garageName,
      Array.from({ length: 91 }, (_, minute) => ({
        time: DateTime.fromISO(input.now).plus({ minutes: minute }).toISO()!, fullnessPercent: 20 + index * 10
      }))]))
  }));
  const evaluation = vi.fn(async () => ({ apiVersion: 1, metrics: [], conformal: [] }));
  const worker: ForecastWorker = { forecast, evaluation };
  return {
    getReadingsBetween, forecast, evaluation,
    service: new PredictionService({ getReadingsBetween }, () => DateTime.fromISO("2026-10-12T12:30:40-07:00"), worker)
  };
}

describe("worker-backed predictions", () => {
  it("lists the ten picker algorithms", () => {
    expect(ALGORITHMS.map(algorithm => algorithm.id)).toEqual([
      "same_time_previous_week", "linear_regression", "logistic_regression", "polynomial_regression",
      "kalman_filter", "knn_regression", "sarima", "gradient_boosting", "mlp", "ensemble"
    ]);
  });

  it("preserves the version-one response, observed graph, and weekly source metadata", async () => {
    const { service, forecast, getReadingsBetween } = fixture([
      { garageName: "North Garage", reportedAt: "2026-10-12T12:30:20", fullnessPercent: 48 }
    ]);
    const result = await service.predict({});
    expect(result.algorithm.id).toBe("same_time_previous_week");
    expect(result.predictions).toHaveLength(4);
    expect(result.predictions[0]).toMatchObject({ fullnessPercent: 20, sourceTime: "2026-10-05T12:30:00-07:00" });
    expect(result.graph.series[0].observed.at(-1)?.fullnessPercent).toBe(48);
    expect(result.graph.series.every(series => series.forecast.length === 91)).toBe(true);
    expect(forecast).toHaveBeenCalledWith(expect.objectContaining({ algorithm: "same_time_previous_week", graphMinutes: 91 }));
    expect(getReadingsBetween).toHaveBeenCalledTimes(1);
  });

  it("sends each learning algorithm to the worker and preserves model-estimate metadata", async () => {
    for (const algorithm of ALGORITHMS.slice(1)) {
      const { service, forecast } = fixture();
      const result = await service.predict({ algorithm: algorithm.id, minutesAhead: "30" });
      expect(forecast).toHaveBeenCalledWith(expect.objectContaining({ algorithm: algorithm.id }));
      expect(result.predictions.every(prediction => prediction.sourceTime === null && prediction.reportedAt === null)).toBe(true);
    }
  });

  it("supports an arbitrary exact future target and the previous OTA algorithm alias", async () => {
    const { service, forecast } = fixture();
    const exact = await service.predict({ targetTime: "2030-01-01T12:00:00Z" });
    expect(exact.targetTime).toBe("2030-01-01T04:00:00.000-08:00");
    await service.predict({ algorithm: "same_time_previous_day" });
    expect(forecast).toHaveBeenLastCalledWith(expect.objectContaining({ algorithm: "same_time_previous_week" }));
  });

  it.each([
    { minutesAhead: "0" }, { minutesAhead: "91" }, { minutesAhead: "1.5" }, { algorithm: "unknown" },
    { targetTime: "2026-10-12T12:00:00" }, { targetTime: "invalidZ" },
    { targetTime: "2026-10-12T12:00:00Z", minutesAhead: "5" }
  ])("rejects invalid request %j before calling the worker", async input => {
    const { service, forecast, getReadingsBetween } = fixture();
    await expect(service.predict(input)).rejects.toThrow();
    expect(forecast).not.toHaveBeenCalled();
    expect(getReadingsBetween).not.toHaveBeenCalled();
  });

  it("proxies the read-only evaluation report", async () => {
    const { service, evaluation } = fixture();
    await expect(service.evaluation()).resolves.toMatchObject({ apiVersion: 1 });
    expect(evaluation).toHaveBeenCalledOnce();
  });
});
