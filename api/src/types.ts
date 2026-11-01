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

export interface ParkingVisitUpload {
  clientVisitId: string;
  garageId: "west";
  startedAt: string;
  completedAt: string;
  elapsedSeconds: number;
  classification: "arrived_by_vehicle";
  confidence: "high" | "medium" | "low";
  trackingConfigVersion: 1;
}

export interface ParkingVisitAcknowledgement {
  clientVisitId: string;
  status: "accepted" | "duplicate" | "rejected";
  error?: string;
}

export interface ParkingVisitBatchResponse {
  acknowledgements: ParkingVisitAcknowledgement[];
}

export interface InstallationEnrollmentResponse {
  installationId: string;
  token: string;
}
