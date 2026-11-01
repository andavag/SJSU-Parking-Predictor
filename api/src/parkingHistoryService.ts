import type { RowDataPacket } from "mysql2";
import { createPool, type Pool } from "mysql2/promise";
import type { ParkingHistoryReading, ParkingHistoryResponse } from "./types.js";

type HistoryRow = Omit<ParkingHistoryReading, "fullnessPercent"> & {
  fullnessPercent: number | string;
};
type DatabaseHistoryRow = RowDataPacket & HistoryRow;

const LATEST_READINGS_QUERY = `
  SELECT
    garage_name AS garageName,
    fullness_percent AS fullnessPercent,
    DATE_FORMAT(log_time, '%Y-%m-%dT%H:%i:%s') AS reportedAt
  FROM parking_history
  ORDER BY id DESC
  LIMIT 10
`;

/**
 * Reads historical data only on the laptop that hosts the API.  The mobile
 * application never receives database credentials or connects to MySQL.
 */
export class ParkingHistoryService {
  private pool?: Pool;

  constructor(
    private readonly databaseUrl = process.env.PARKING_DATABASE_URL,
    private readonly queryRows?: () => Promise<HistoryRow[]>
  ) {}

  async getLatestReadings(): Promise<ParkingHistoryResponse> {
    const rows = this.queryRows ? await this.queryRows() : await this.readDatabase();
    return {
      readings: rows.map((row) => ({
        garageName: row.garageName,
        fullnessPercent: Number(row.fullnessPercent),
        reportedAt: row.reportedAt
      }))
    };
  }

  /** Campus wall-clock bounds; query parameters never become SQL code. */
  async getReadingsBetween(start: string, end: string): Promise<ParkingHistoryReading[]> {
    if (!this.databaseUrl) throw new Error("Parking history is not configured on this server.");
    this.pool ??= createPool(this.databaseUrl);
    const [rows] = await this.pool.execute<DatabaseHistoryRow[]>(`
      SELECT garage_name AS garageName, fullness_percent AS fullnessPercent,
             DATE_FORMAT(log_time, '%Y-%m-%dT%H:%i:%s') AS reportedAt
      FROM parking_history
      WHERE log_time >= ? AND log_time < ?
      ORDER BY log_time ASC, id ASC
    `, [start, end]);
    return rows.map(row => ({ ...row, fullnessPercent: Number(row.fullnessPercent) }));
  }

  /**
   * Returns the two nearest SQL candidates for each garage: one at or before
   * the requested campus wall-clock time and one after it.  PredictionService
   * makes the final choice, which keeps the tie-breaking rule in one place.
   */
  async getClosestReadingsAt(time: string, garageNames: string[]): Promise<ParkingHistoryReading[]> {
    if (!this.databaseUrl) throw new Error("Parking history is not configured on this server.");
    this.pool ??= createPool(this.databaseUrl);
    const candidates = await Promise.all(garageNames.flatMap(async garageName => {
      const select = async (operator: "<=" | ">", direction: "ASC" | "DESC") => {
        const [rows] = await this.pool!.execute<DatabaseHistoryRow[]>(`
          SELECT garage_name AS garageName, fullness_percent AS fullnessPercent,
                 DATE_FORMAT(log_time, '%Y-%m-%dT%H:%i:%s') AS reportedAt
          FROM parking_history
          WHERE garage_name = ? AND log_time ${operator} ?
          ORDER BY log_time ${direction}, id ${direction}
          LIMIT 1
        `, [garageName, time]);
        return rows.map(row => ({ ...row, fullnessPercent: Number(row.fullnessPercent) }));
      };
      return Promise.all([select("<=", "DESC"), select(">", "ASC")]);
    }));
    return candidates.flat(2);
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }

  private async readDatabase(): Promise<HistoryRow[]> {
    if (!this.databaseUrl) {
      throw new Error("Parking history is not configured on this laptop.");
    }

    this.pool ??= createPool(this.databaseUrl);
    const [rows] = await this.pool.query<DatabaseHistoryRow[]>(LATEST_READINGS_QUERY);
    return rows;
  }
}
