import { parseParkingPage, SOURCE_URL } from "./parkingParser.js";
import type { ParkingStatusResponse } from "./types.js";

export const CACHE_TTL_MS = 30_000;

export class ParkingStatusService {
  private cached?: ParkingStatusResponse;

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly sourceUrl = SOURCE_URL
  ) {}

  async getStatus(forceRefresh = false): Promise<ParkingStatusResponse> {
    if (!forceRefresh && this.cached && this.ageMs(this.cached) < CACHE_TTL_MS) return this.cached;

    try {
      const response = await this.fetchImplementation(this.sourceUrl, { headers: { "user-agent": "sjsu-parking-app/1.0" } });
      if (!response.ok) throw new Error(`SJSU returned HTTP ${response.status}.`);
      const parsed = parseParkingPage(await response.text());
      this.cached = { ...parsed, fetchedAt: this.now().toISOString(), stale: false };
      return this.cached;
    } catch (error) {
      if (this.cached) return { ...this.cached, stale: true };
      throw error instanceof Error ? error : new Error("Unable to retrieve SJSU parking data.");
    }
  }

  private ageMs(status: ParkingStatusResponse): number {
    return this.now().getTime() - new Date(status.fetchedAt).getTime();
  }
}
