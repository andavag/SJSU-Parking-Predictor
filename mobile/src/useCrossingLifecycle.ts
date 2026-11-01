import NetInfo from "@react-native-community/netinfo";
import { useEffect } from "react";
import { AppState, Platform } from "react-native";
import { reconcileLogging } from "./crossingRuntime";
import { saveLoggingError } from "./crossingStore";
import { syncDueCrossings } from "./crossingSync";

export function useCrossingLifecycle(): void {
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const resume = async () => {
      try {
        if (await reconcileLogging() === "logging active") await syncDueCrossings();
      } catch (error) { await saveLoggingError(error instanceof Error ? error.message : "Logger setup failed."); }
    };
    void resume();
    const foreground = AppState.addEventListener("change", state => { if (state === "active") void resume(); });
    const network = NetInfo.addEventListener(info => {
      if (info.isConnected && info.isInternetReachable !== false) void resume();
    });
    const timer = setInterval(() => { if (AppState.currentState === "active") void resume(); }, 30_000);
    return () => { foreground.remove(); network(); clearInterval(timer); };
  }, []);
}
