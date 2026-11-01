import { ParkingHistoryCollector } from "./parkingHistoryCollector.js";

const collector = new ParkingHistoryCollector();

try {
  const result = await collector.collect();
  console.log(
    `Stored ${result.insertedReadings} parking reading(s) from ${result.sourceUpdatedAt}; `
      + `${result.duplicateReadings} duplicate(s) skipped.`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "Unable to collect parking history.");
  process.exitCode = 1;
} finally {
  await collector.close();
}
