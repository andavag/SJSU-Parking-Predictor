import * as Location from "expo-location";
import { useCallback, useEffect, useState } from "react";
import { Alert, AppState, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { GEOFENCE_TASK, loggingStatus, setLoggingEnabled, type LoggingStatus } from "./crossingRuntime";
import { clearCrossings, getLoggingSettings, getRecentCrossings, subscribeCrossings } from "./crossingStore";
import { enrollInstallation, hasInstallationToken, pauseCrossingSync, syncDueCrossings } from "./crossingSync";
import type { StoredCrossing } from "./crossingTypes";

const message = (error: unknown) => error instanceof Error ? error.message : "The logger could not finish that action.";
function confirm(title: string, body: string, action: string): Promise<boolean> {
  return new Promise(resolve => Alert.alert(title, body, [
    { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
    { text: action, onPress: () => resolve(true) }
  ], { cancelable: true, onDismiss: () => resolve(false) }));
}
export function WestGarageCrossings() {
  const [enabled, setEnabled] = useState<boolean>();
  const [status, setStatus] = useState<LoggingStatus>("logging paused");
  const [events, setEvents] = useState<StoredCrossing[]>([]);
  const [limit, setLimit] = useState(50);
  const [enrolled, setEnrolled] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [settings, rows, token, nextStatus] = await Promise.all([getLoggingSettings(), getRecentCrossings(limit), hasInstallationToken(), loggingStatus()]);
      const registered = nextStatus !== "logging active" || await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
      setEnabled(settings.enabled); setRuntimeError(settings.lastError); setEvents(rows); setEnrolled(token);
      setStatus(registered ? nextStatus : "background tracking unavailable");
    } catch (failure) { setError(message(failure)); }
  }, [limit]);
  useEffect(() => {
    let live = true;
    let refreshing = false;
    let requested = false;
    const update = async () => {
      requested = true;
      if (refreshing) return;
      refreshing = true;
      try { while (requested && live) { requested = false; await refresh(); } }
      finally { refreshing = false; }
    };
    void update();
    const unsubscribe = subscribeCrossings(() => { void update(); });
    const foreground = AppState.addEventListener("change", next => { if (next === "active") void update(); });
    const timer = setInterval(() => { if (AppState.currentState === "active") void update(); }, 5_000);
    return () => { live = false; unsubscribe(); foreground.remove(); clearInterval(timer); };
  }, [refresh]);
  const toggle = async () => {
    if (busy || enabled === undefined) return;
    setBusy(true); setError(undefined);
    try {
      if (enabled) { setStatus(await setLoggingEnabled(false)); return; }
      if (!await confirm("Enable West Garage crossing log?", "Save when Android reports entering or exiting the 50, 100, 150 and 160 m circles, plus an available speed reading. Precise location is required.", "Continue")) return;
      const foreground = await Location.requestForegroundPermissionsAsync();
      if (!foreground.granted || foreground.android?.accuracy !== "fine") throw new Error("Enable precise location for SJSU Parking in Android Settings, then try again.");
      if (!(await Location.getBackgroundPermissionsAsync()).granted) {
        if (!await confirm("Allow background location?", "To log with the screen off, choose Allow all the time. Android 11 and later opens Settings for this step.", "Continue to settings")) return;
        if (!(await Location.requestBackgroundPermissionsAsync()).granted) throw new Error("Allow background location in Android Settings to enable the crossing log.");
      }
      setStatus(await setLoggingEnabled(true));
      await syncDueCrossings();
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); await refresh(); }
  };
  const enroll = async () => {
    setBusy(true); setError(undefined);
    try { await enrollInstallation(code); setCode(""); await syncDueCrossings(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); await refresh(); }
  };
  const clear = async () => {
    if (!await confirm("Clear local crossing history?", "This discards local crossings, including those waiting to upload. An upload already received by the server cannot be recalled; server records remain. Archived v1 history is preserved.", "Clear crossings")) return;
    setBusy(true);
    try { pauseCrossingSync(); await clearCrossings(); setLimit(50); await refresh(); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  };
  return <View style={styles.section}>
    <Text style={styles.title}>West Garage crossing logger</Text>
    <Text style={styles.body}>Log every entry and exit reported at 50, 100, 150 and 160 m from West Garage.</Text>
    <Text style={styles.status}>Status: {status}</Text>
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: busy || enabled === undefined }} disabled={busy || enabled === undefined} onPress={() => void toggle()} style={styles.button}>
      <Text style={styles.buttonText}>{enabled ? "Turn off crossing logging" : "Enable West Garage crossing logging"}</Text>
    </Pressable>
    <Text style={styles.hint}>Times show when Android delivered each event. Speed is a nearby location sample, which may be before or after the crossing. Small circles and poor garage signal can produce delayed, repeated or missing events. Force-close and battery restrictions can stop logging. No coordinates or routes are saved.</Text>
    <Text style={styles.subtitle}>Daily crossing upload</Text>
    {enrolled ? <Text style={styles.body}>Installation enrolled. Crossings become due after 24 hours and upload when logging is on and Android allows it.</Text> : <View>
      <Text style={styles.body}>Logging works locally. A one-time server code enables automatic uploads for this phone.</Text>
      <TextInput accessibilityLabel="One-time enrollment code" value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={12} placeholder="12-digit enrollment code" style={styles.input} />
      <Pressable accessibilityRole="button" disabled={busy || !/^\d{12}$/.test(code)} onPress={() => void enroll()} style={styles.secondaryButton}><Text style={styles.secondaryText}>Enroll this installation</Text></Pressable>
    </View>}
    <Text style={styles.subtitle}>Recent local crossings</Text>
    <Text style={styles.hint}>Newest received first. History stays on this phone until cleared.</Text>
    {!events.length ? <Text style={styles.body}>No crossing callbacks received yet.</Text> : events.map(event => <View key={event.clientEventId} style={styles.row}>
      <Text style={styles.rowTitle}>{event.direction === "entered" ? "Entered" : "Exited"} {event.radiusMeters} m · {new Date(event.callbackReceivedAt).toLocaleString()}</Text>
      <Text style={styles.body}>{event.speedMetersPerSecond === null ? "Speed unavailable" : `${(event.speedMetersPerSecond * 3.6).toFixed(1)} km/h · sample ${new Date(event.speedMeasuredAt!).toLocaleString()} · ±${Math.round(event.accuracyMeters!)} m`}</Text>
      <Text style={styles.hint}>{event.sampleState === "collecting" ? "Speed check may be pending · " : ""}{event.syncState}{event.lastError ? ` · ${event.lastError}` : ""}</Text>
    </View>)}
    {events.length >= limit ? <Pressable accessibilityRole="button" onPress={() => setLimit(value => value + 50)} style={styles.secondaryButton}><Text style={styles.secondaryText}>Show older crossings</Text></Pressable> : null}
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void clear()} style={styles.clearButton}><Text style={styles.clearText}>Clear local crossing history</Text></Pressable>
    {error || runtimeError ? <Text style={styles.error}>{error ?? runtimeError}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  section: { borderTopColor: "#D0D5DD", borderTopWidth: 1, marginTop: 12, paddingTop: 22, paddingBottom: 20 },
  title: { color: "#101828", fontSize: 20, fontWeight: "800", marginBottom: 8 },
  subtitle: { color: "#101828", fontSize: 17, fontWeight: "700", marginTop: 20, marginBottom: 8 },
  body: { color: "#344054", fontSize: 15, lineHeight: 22, marginBottom: 8 },
  hint: { color: "#667085", fontSize: 13, lineHeight: 19, marginTop: 8 },
  status: { color: "#0055A5", fontSize: 15, fontWeight: "700", marginVertical: 12 },
  button: { backgroundColor: "#0055A5", borderRadius: 8, padding: 14, marginVertical: 8 },
  buttonText: { color: "#FFFFFF", fontWeight: "800", textAlign: "center" },
  secondaryButton: { borderColor: "#0055A5", borderRadius: 8, borderWidth: 1, padding: 12 },
  secondaryText: { color: "#0055A5", fontWeight: "700", textAlign: "center" },
  input: { backgroundColor: "#FFFFFF", borderColor: "#D0D5DD", borderRadius: 8, borderWidth: 1, padding: 12, marginVertical: 8 },
  row: { borderBottomColor: "#EAECF0", borderBottomWidth: 1, paddingVertical: 12 },
  rowTitle: { color: "#344054", fontSize: 14, fontWeight: "700", lineHeight: 22 },
  clearButton: { marginTop: 14, paddingVertical: 8 },
  clearText: { color: "#B42318", fontWeight: "700" },
  error: { color: "#B42318", fontSize: 14, marginTop: 8 }
});
