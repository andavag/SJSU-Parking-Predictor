import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { createPool, type RowDataPacket } from "mysql2/promise";
import { CAMPUS_TIMEZONE } from "../src/predictionService.js";

const base = process.argv[2] ?? "http://127.0.0.1:3001";
async function request(path: string) {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
const models = await request("/v1/prediction-algorithms");
assert.equal(models.apiVersion, 1);
assert.equal(models.algorithms[0].id, "same_time_previous_week");
assert.deepEqual(models.algorithms.map((algorithm: { id: string }) => algorithm.id), [
  "same_time_previous_week", "linear_regression", "logistic_regression", "polynomial_regression",
  "kalman_filter", "knn_regression", "sarima", "gradient_boosting", "mlp", "ensemble"
]);
const now = await request("/v1/parking-predictions");
assert.equal(now.predictions.length, 4);
assert.equal(now.graph.series.length, 4);
assert.equal(Date.parse(now.graph.endTime) - Date.parse(now.currentTime), 90 * 60_000);
assert.equal(Date.parse(now.currentTime) - Date.parse(now.graph.startTime), 90 * 60_000);
const relative = await request("/v1/parking-predictions?minutesAhead=90");
assert.equal(Date.parse(relative.targetTime) - Date.parse(relative.currentTime), 90 * 60_000);
assert.equal(relative.graph.series[0].forecast.length, 91);
for (const algorithm of ["linear_regression", "logistic_regression", "polynomial_regression", "kalman_filter", "knn_regression", "sarima", "gradient_boosting", "mlp", "ensemble"]) {
  const model = await request(`/v1/parking-predictions?algorithm=${algorithm}`);
  assert.equal(model.predictions.length, 4);
  for (const prediction of model.predictions) {
    assert.ok(prediction.fullnessPercent === null || (prediction.fullnessPercent >= 0 && prediction.fullnessPercent <= 100));
    assert.equal(prediction.sourceTime, null);
  }
  assert.equal(model.graph.series[0].forecast.length, 91);
}
const evaluation = await request("/v1/prediction-evaluation");
assert.equal(evaluation.apiVersion, 1);
assert.ok(Array.isArray(evaluation.metrics));
const bad = await fetch(`${base}/v1/parking-predictions?minutesAhead=91`);
assert.equal(bad.status, 400);
const repeated = await fetch(`${base}/v1/parking-predictions?minutesAhead=1&minutesAhead=2`);
assert.equal(repeated.status, 400);

const pool = createPool(process.env.PARKING_DATABASE_URL!);
try {
  const [rows] = await pool.query<RowDataPacket[]>(`
    SELECT garage_name AS name, fullness_percent AS percent,
      DATE_FORMAT(log_time, '%Y-%m-%dT%H:%i:%s') AS time
    FROM parking_history WHERE log_time < ? ORDER BY log_time DESC, id DESC LIMIT 1
  `, [DateTime.now().setZone(CAMPUS_TIMEZONE).toFormat("yyyy-MM-dd HH:mm:ss")]);
  assert.ok(rows[0], "Need a real historical reading for integration verification");
  const target = DateTime.fromISO(rows[0].time, { zone: CAMPUS_TIMEZONE }).plus({ weeks: 1 }).toISO()!;
  const exact = await request(`/v1/parking-predictions?targetTime=${encodeURIComponent(target)}`);
  const card = exact.predictions.find((garage: { name: string }) => garage.name === rows[0].name);
  assert.equal(card.fullnessPercent, Number(rows[0].percent));
  console.log(JSON.stringify({ verified: true, algorithms: models.algorithms.length,
    garages: exact.predictions.length, observedMinutes: 91, forecastMinutes: 91,
    realReadingMatched: rows[0].name, percentage: card.fullnessPercent }));
} finally { await pool.end(); }
