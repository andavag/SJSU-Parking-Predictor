export interface WorkerForecastPoint { time: string; fullnessPercent: number | null }
export interface WorkerGaragePrediction {
  garageName: string; fullnessPercent: number | null; sourceTime: string | null; reportedAt: string | null;
}
export interface WorkerForecastResponse {
  predictions: WorkerGaragePrediction[];
  forecast: Record<string, WorkerForecastPoint[]>;
  trainedAt?: string;
}

export interface ForecastWorker {
  forecast(input: { algorithm: string; now: string; target: string; graphMinutes: number }): Promise<WorkerForecastResponse>;
  evaluation(): Promise<Record<string, unknown>>;
}

/** A bounded loopback client; the Python service is never publicly routed. */
export class ForecastWorkerClient implements ForecastWorker {
  constructor(private readonly baseUrl = process.env.PARKING_FORECAST_WORKER_URL ?? "http://127.0.0.1:3002") {}

  async forecast(input: { algorithm: string; now: string; target: string; graphMinutes: number }): Promise<WorkerForecastResponse> {
    return this.request<WorkerForecastResponse>("/v1/internal/forecast", { method: "POST", body: JSON.stringify(input) });
  }

  async evaluation(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>("/v1/internal/evaluation");
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { "content-type": "application/json", ...options.headers },
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`Forecast worker responded with ${response.status}.`);
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
