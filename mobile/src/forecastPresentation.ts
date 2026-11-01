import type { ForecastPoint } from "./types";

export const CAMPUS_TIMEZONE = "America/Los_Angeles";
export const formatCampusTime = (time: string, includeDate = true) => new Date(time).toLocaleString("en-US", {
  timeZone: CAMPUS_TIMEZONE, ...(includeDate ? { month: "short", day: "numeric" } as const : {}),
  hour: "numeric", minute: "2-digit"
});

/** Break lines at missing data; never imply measurements across a gap. */
export function forecastPath(points: ForecastPoint[], start: number, end: number, width: number, height: number) {
  let open = false;
  return points.map(point => {
    if (point.fullnessPercent === null) { open = false; return ""; }
    const x = 38 + (new Date(point.time).getTime() - start) / (end - start) * (width - 50);
    const y = 16 + (100 - point.fullnessPercent) / 100 * (height - 52);
    const segment = `${open ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
    open = true;
    return segment;
  }).join(" ");
}
