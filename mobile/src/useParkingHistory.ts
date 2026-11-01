import { useCallback, useEffect, useRef, useState } from "react";
import { getParkingHistory } from "./api";
import type { ParkingHistoryResponse } from "./types";

/** Keeps history only in React state for the current app session. */
export function useParkingHistory(enabled: boolean) {
  const [data, setData] = useState<ParkingHistoryResponse>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const dataRef = useRef<ParkingHistoryResponse | undefined>(undefined);

  const load = useCallback(async (isManualRefresh = false) => {
    setError(undefined);
    if (isManualRefresh || dataRef.current) setIsRefreshing(true);
    else setIsLoading(true);

    try {
      const history = await getParkingHistory();
      dataRef.current = history;
      setData(history);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Parking history is temporarily unavailable.");
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  return { data, error, isLoading, isRefreshing, refresh: () => load(true) };
}
