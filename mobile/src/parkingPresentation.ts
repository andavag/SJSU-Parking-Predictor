import type { GarageStatus } from "./types";

export const REFRESH_INTERVAL_MS = 30_000;
export type GarageDisplay = { label: "Available" | "Busy" | "Full"; color: string };

export function getGarageDisplay(garage: GarageStatus): GarageDisplay {
  if (garage.isFull || garage.fullnessPercent >= 100) return { label: "Full", color: "#B42318" };
  if (garage.fullnessPercent >= 60) return { label: "Busy", color: "#B54708" };
  return { label: "Available", color: "#027A48" };
}
