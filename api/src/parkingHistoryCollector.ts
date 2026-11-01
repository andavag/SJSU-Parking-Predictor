import { createPool, type Pool, type ResultSetHeader } from "mysql2/promise";
import { ParkingStatusService } from "./parkingService.js";
import type { GarageStatus } from "./types.js";

const INSERT_READING_QUERY = `
  INSERT IGNORE INTO parking_history (garage_name, fullness_percent, log_time)
  VALUES (?, ?, ?)
`;

const SOURCE_TIMESTAMP = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)$/i;

export interface CollectionResult {
  sourceUpdatedAt: string;
  insertedReadings: number;
  duplicateReadings: number;
}

/**
 * Converts the timestamp printed by SJSU into a timezone-neutral SQL DATETIME.
 * The source reports local campus time, and the database deliberately stores
 * that wall-clock timestamp so its unique constraint can de-duplicate readings.
 */
export function sourceTimestampToSqlDatetime(sourceUpdatedAt: string): string {
  const match = SOURCE_TIMESTAMP.exec(sourceUpdatedAt.trim());
  if (!match) throw new Error(`The SJSU timestamp is not recognized: ${sourceUpdatedAt}`);

  const [, monthText, dayText, yearText, hourText, minuteText, secondText, meridiem] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour12 = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 || month > 12 || day < 1 || day > 31 || hour12 < 1 || hour12 > 12
    || minute > 59 || second > 59
  ) {
    throw new Error(`The SJSU timestamp is invalid: ${sourceUpdatedAt}`);
  }

  const hour24 = (hour12 % 12) + (meridiem.toUpperCase() === "PM" ? 12 : 0);
  const date = new Date(Date.UTC(year, month - 1, day, hour24, minute, second));
  if (
    date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
  ) {
    throw new Error(`The SJSU timestamp is invalid: ${sourceUpdatedAt}`);
  }

  const pad = (value: number) => String(value).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour24)}:${pad(minute)}:${pad(second)}`;
}

export class ParkingHistoryCollector {
  private pool?: Pool;

  constructor(
    private readonly statusService = new ParkingStatusService(),
    private readonly databaseUrl = process.env.PARKING_COLLECTOR_DATABASE_URL
  ) {}

  async collect(): Promise<CollectionResult> {
    if (!this.databaseUrl) {
      throw new Error("Parking history collection is not configured on this server.");
    }

    const status = await this.statusService.getStatus(true);
    if (status.stale) {
      throw new Error("SJSU data is stale, so no history readings were stored.");
    }

    const reportedAt = sourceTimestampToSqlDatetime(status.sourceUpdatedAt);
    this.pool ??= createPool(this.databaseUrl);
    let insertedReadings = 0;
    for (const garage of status.garages) {
      insertedReadings += await this.insertReading(garage, reportedAt);
    }
    return {
      sourceUpdatedAt: status.sourceUpdatedAt,
      insertedReadings,
      duplicateReadings: status.garages.length - insertedReadings
    };
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private async insertReading(garage: GarageStatus, reportedAt: string): Promise<number> {
    const [result] = await this.pool!.execute<ResultSetHeader>(INSERT_READING_QUERY, [
      garage.name,
      garage.fullnessPercent,
      reportedAt
    ]);
    return result.affectedRows;
  }
}
