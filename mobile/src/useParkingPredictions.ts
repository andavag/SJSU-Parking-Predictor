import { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { getParkingPredictions, getPredictionAlgorithms } from "./api";
import type { PredictionAlgorithm, PredictionResponse, PredictionSelection } from "./types";

export function useParkingPredictions(enabled: boolean, selection: PredictionSelection, algorithm: string,
  onAlgorithms: (algorithms: PredictionAlgorithm[]) => void) {
  const [data, setData] = useState<PredictionResponse>();
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const requestId = useRef(0);
  const inFlight = useRef(false);
  const currentData = useRef<PredictionResponse | undefined>(undefined);
  const selectionKey = JSON.stringify(selection);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    const id = ++requestId.current;
    setError(undefined);
    setIsLoading(!currentData.current);
    setIsRefreshing(Boolean(currentData.current));
    try {
      const [models, response] = await Promise.all([
        getPredictionAlgorithms(), getParkingPredictions(algorithm, JSON.parse(selectionKey) as PredictionSelection)
      ]);
      if (id !== requestId.current) return;
      onAlgorithms(models);
      currentData.current = response;
      setData(response);
      setStale(false);
    } catch (failure) {
      if (id !== requestId.current) return;
      setError(failure instanceof Error ? failure.message : "Unable to refresh predictions.");
      setStale(Boolean(currentData.current));
    } finally {
      if (id === requestId.current) {
        inFlight.current = false;
        setIsLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [algorithm, selectionKey, onAlgorithms]);

  useEffect(() => {
    currentData.current = undefined;
    setData(undefined);
    setStale(false);
    if (enabled && AppState.currentState === "active") void load();
    const timer = setInterval(() => {
      if (enabled && AppState.currentState === "active") void load();
    }, 60_000);
    const subscription = AppState.addEventListener("change", state => {
      if (enabled && state === "active") void load();
    });
    return () => {
      clearInterval(timer);
      subscription.remove();
      ++requestId.current;
      inFlight.current = false;
    };
  }, [enabled, load]);

  return { data, error, stale, isLoading, isRefreshing, refresh: load };
}
