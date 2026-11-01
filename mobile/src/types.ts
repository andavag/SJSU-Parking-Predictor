export type GarageId = "north" | "west" | "south" | "south-campus";

export interface GarageStatus {
  id: GarageId;
  name: string;
  address: string;
  fullnessPercent: number;
  isFull: boolean;
}

export interface ShuttleLinks {
  description: string;
  realtimeLocationUrl?: string;
  informationUrl?: string;
}

export interface ParkingStatusResponse {
  sourceUpdatedAt: string;
  fetchedAt: string;
  stale: boolean;
  garages: GarageStatus[];
  shuttles: ShuttleLinks;
}

export interface ParkingHistoryReading {
  garageName: string;
  fullnessPercent: number;
  reportedAt: string;
}

export interface ParkingHistoryResponse {
  readings: ParkingHistoryReading[];
}

export interface PredictionAlgorithm { id: string; name: string; version: string; description: string }
export type PredictionSelection = { mode: "now" } | { mode: "relative"; minutes: number } | { mode: "exact"; time: string };
export interface ForecastPoint { time: string; fullnessPercent: number | null }
export interface PredictionResponse {
  apiVersion: 1; currentTime: string; targetTime: string; timezone: string;
  algorithm: PredictionAlgorithm;
  predictions: { id: GarageId; name: string; fullnessPercent: number | null; sourceTime: string | null; reportedAt: string | null }[];
  graph: { startTime: string; endTime: string; series: {
    id: GarageId; name: string; observed: ForecastPoint[]; forecast: ForecastPoint[];
  }[] };
}
