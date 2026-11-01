import { useCallback, useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { getParkingStatus } from "./api";
import { REFRESH_INTERVAL_MS } from "./parkingPresentation";
import type { ParkingStatusResponse } from "./types";

export function useParkingStatus() {
  const [data, setData] = useState<ParkingStatusResponse>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const dataRef = useRef<ParkingStatusResponse | undefined>(undefined);

  const load = useCallback(async (forceRefresh = false) => {
    setError(undefined);
    if (forceRefresh || dataRef.current) setIsRefreshing(true);
    else setIsLoading(true);
    try {
      const status = await getParkingStatus(forceRefresh);
      dataRef.current = status;
      setData(status);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : "Parking data is temporarily unavailable.";
      const previous = dataRef.current;
      if (previous) {
        const staleData = { ...previous, stale: true };
        dataRef.current = staleData;
        setData(staleData);
        setError("Unable to refresh live data. Showing the most recently reported data.");
      } else {
        setError(message);
      }
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    let interval: ReturnType<typeof setInterval> | undefined;
    const startInterval = () => {
      if (!interval) interval = setInterval(() => {
        if (appState.current === "active") void load(true);
      }, REFRESH_INTERVAL_MS);
    };
    if (appState.current === "active") startInterval();
    const subscription = AppState.addEventListener("change", (nextState) => {
      const wasInactive = /inactive|background/.test(appState.current);
      if (wasInactive && nextState === "active") {
        void load(true);
        startInterval();
      }
      if (nextState !== "active" && interval) {
        clearInterval(interval);
        interval = undefined;
      }
      appState.current = nextState;
    });
    return () => { if (interval) clearInterval(interval); subscription.remove(); };
  }, [load]);

  return {
    data,
    error,
    isLoading,
    isRefreshing,
    refresh: () => load(true)
  };
}
