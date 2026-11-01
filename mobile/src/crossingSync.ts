import * as SecureStore from "expo-secure-store";
import { getApiBaseUrl } from "./api";
import { getDueCrossings, getLoggingSettings, markCrossingFailed, markCrossingRejected, markCrossingSynced } from "./crossingStore";
import { uploadCrossings, type Acknowledgement } from "./crossingQueue";

const TOKEN_KEY = "west-garage-installation-token-v1";
let running: Promise<void> | undefined;
let controller: AbortController | undefined;
let pauseGeneration = 0;
class UnauthorizedError extends Error {}
async function post<T>(path: string, body: unknown, token?: string, signalController = new AbortController()): Promise<T> {
  const timeout = setTimeout(() => signalController.abort(), 12_000);
  try {
    const response = await fetch(`${getApiBaseUrl()}${path}`, { method: "POST", signal: signalController.signal,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body) });
    const value = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (response.status === 401 && token) throw new UnauthorizedError("Enrollment expired or was revoked. Enter a new one-time code.");
    if (!response.ok || !value) throw new Error(value?.error ?? `Server returned ${response.status}.`);
    return value;
  } finally { clearTimeout(timeout); }
}
export const hasInstallationToken = async () => Boolean(await SecureStore.getItemAsync(TOKEN_KEY));
export async function enrollInstallation(code: string): Promise<void> {
  const response = await post<{ token: string }>("/v1/installations/enroll", { code: code.trim() });
  if (typeof response.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(response.token)) throw new Error("Invalid installation credential returned by server.");
  await SecureStore.setItemAsync(TOKEN_KEY, response.token);
}
export function pauseCrossingSync(): void { pauseGeneration += 1; controller?.abort(); }
export function syncDueCrossings(): Promise<void> {
  running ??= performSync().finally(() => { running = undefined; });
  return running;
}
async function performSync(): Promise<void> {
  const generation = pauseGeneration;
  if (!(await getLoggingSettings()).enabled) return;
  const token = await SecureStore.getItemAsync(TOKEN_KEY);
  if (!token) return;
  // Drain a bounded backlog (250 events) per wakeup without monopolizing Android.
  for (let batch = 0; batch < 10; batch++) {
    const events = await getDueCrossings(Date.now());
    const settings = await getLoggingSettings();
    if (!events.length || generation !== pauseGeneration || !settings.enabled) return;
    controller = new AbortController();
    try {
      await uploadCrossings(events, async payload => {
        const result = await post<{ acknowledgements: Acknowledgement[] }>("/v1/parking-crossings/batch", { events: payload }, token, controller);
        return result.acknowledgements;
      }, markCrossingSynced, markCrossingFailed, markCrossingRejected);
    } catch (error) {
      if (error instanceof UnauthorizedError) await SecureStore.deleteItemAsync(TOKEN_KEY);
      throw error;
    } finally { controller = undefined; }
  }
}
