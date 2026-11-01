import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Updates from "expo-updates";

export function UpdateControl() {
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<string>();
  if (!Updates.isEnabled) return null;
  const check = async () => {
    setBusy(true);
    try {
      if (ready) { await Updates.reloadAsync(); return; }
      const update = await Updates.checkForUpdateAsync();
      if (update.isAvailable || update.isRollBackToEmbedded) {
        const result = await Updates.fetchUpdateAsync();
        setReady(result.isNew || result.isRollBackToEmbedded);
        setMessage("Update ready. Restart the app to apply it.");
      } else setMessage("Your app is up to date.");
    } catch { setMessage("Unable to check for an app update. Try again when connected."); }
    finally { setBusy(false); }
  };
  return <View style={styles.container}>
    <Pressable accessibilityRole="button" disabled={busy} onPress={() => void check()} style={styles.button}>
      <Text style={styles.text}>{busy ? "Checking…" : ready ? "Restart to apply update" : "Check for app update"}</Text>
    </Pressable>
    {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
  </View>;
}
const styles = StyleSheet.create({
  container: { marginTop: 24 }, button: { paddingVertical: 14 },
  text: { color: "#0055A5", fontSize: 14, textAlign: "center" },
  message: { color: "#667085", fontSize: 13, textAlign: "center" }
});
