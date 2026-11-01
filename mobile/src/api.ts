import type { ParkingHistoryResponse, ParkingStatusResponse, PredictionAlgorithm, PredictionResponse, PredictionSelection } from "./types";

export const REQUEST_TIMEOUT_MS = 12_000;

export function getApiBaseUrl(): string {
  const configuredUrl = process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, "");
  if (!configuredUrl) throw new Error("The secure parking server address has not been configured yet.");
  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    throw new Error("The secure parking server address is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("The parking app requires a secure HTTPS server address.");
  return url.toString().replace(/\/$/, "");
}

export async function getParkingStatus(forceRefresh = false): Promise<ParkingStatusResponse> {
  return request<ParkingStatusResponse>(`/v1/parking-status${forceRefresh ? "?refresh=1" : ""}`);
}

export async function getParkingHistory(): Promise<ParkingHistoryResponse> {
  return request<ParkingHistoryResponse>("/v1/parking-history");
}

export async function getPredictionAlgorithms() {
  const result = await request<{ apiVersion: number; algorithms: PredictionAlgorithm[] }>("/v1/prediction-algorithms");
  if (result.apiVersion !== 1) throw new Error("This prediction API requires an app update.");
  return result.algorithms;
}

export async function getParkingPredictions(algorithm: string, selection: PredictionSelection) {
  const query = new URLSearchParams({ algorithm });
  if (selection.mode === "relative") query.set("minutesAhead", String(selection.minutes));
  if (selection.mode === "exact") query.set("targetTime", selection.time);
  const result = await request<PredictionResponse>(`/v1/parking-predictions?${query}`);
  if (result.apiVersion !== 1) throw new Error("This prediction API requires an app update.");
  return result;
}

async function request<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const baseUrl = getApiBaseUrl();
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { "Cache-Control": "no-store" },
      signal: controller.signal
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? "Parking data is temporarily unavailable.");
    }
    return (await response.json()) as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("The secure parking server took too long to respond. Check your connection and try again.");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
