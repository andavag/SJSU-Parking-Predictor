import DateTimePicker from "@react-native-community/datetimepicker";
import { useCallback, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { CAMPUS_TIMEZONE, formatCampusTime } from "./forecastPresentation";
import { ForecastChart } from "./ForecastChart";
import type { PredictionAlgorithm, PredictionSelection } from "./types";
import { useParkingPredictions } from "./useParkingPredictions";

export function usePredictionScreen(enabled: boolean) {
  const [selection, setSelection] = useState<PredictionSelection>({ mode: "now" });
  const [algorithm, setAlgorithm] = useState("same_time_previous_week");
  const [algorithms, setAlgorithms] = useState<PredictionAlgorithm[]>([]);
  const updateAlgorithms = useCallback((models: PredictionAlgorithm[]) => setAlgorithms(models), []);
  const forecast = useParkingPredictions(enabled, selection, algorithm, updateAlgorithms);
  return { selection, setSelection, algorithm, setAlgorithm, algorithms, ...forecast };
}

type Screen = ReturnType<typeof usePredictionScreen>;
export function PredictionScreen({ screen }: { screen: Screen }) {
  const [algorithmOpen, setAlgorithmOpen] = useState(false);
  const [rollerOpen, setRollerOpen] = useState(false);
  const [minutes, setMinutes] = useState(15);
  const [exact, setExact] = useState(new Date());
  const [pickerMode, setPickerMode] = useState<"date" | "time">();
  const selectedModel = screen.algorithms.find(model => model.id === screen.algorithm);
  return <View>
    <Text style={styles.label}>Prediction algorithm</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Select prediction algorithm" onPress={() => setAlgorithmOpen(true)} style={styles.field}>
      <Text style={styles.fieldText}>{selectedModel?.name ?? "Same time last week"} ▾</Text>
    </Pressable>
    <Text style={styles.hint}>{selectedModel?.description ?? "Uses the closest recorded percentage at the same day and time last week."}</Text>
    <Text style={styles.label}>Wanted time</Text>
    <View style={styles.modes}>
      {([['now', 'Now'], ['relative', 'In 1–90 min'], ['exact', 'Exact date & time']] as const).map(([mode, label]) =>
        <Pressable key={mode} accessibilityRole="button" accessibilityState={{ selected: screen.selection.mode === mode }} style={[styles.mode, screen.selection.mode === mode && styles.activeMode]}
          onPress={() => {
            if (mode === "now") screen.setSelection({ mode });
            if (mode === "relative") { screen.setSelection({ mode, minutes }); setRollerOpen(true); }
            if (mode === "exact") { screen.setSelection({ mode, time: exact.toISOString() }); setPickerMode("date"); }
          }}><Text style={[styles.modeText, screen.selection.mode === mode && styles.activeText]}>{label}</Text></Pressable>)}
    </View>
    {screen.selection.mode === "relative" ? <Pressable accessibilityRole="button" style={styles.field} onPress={() => setRollerOpen(true)}><Text style={styles.fieldText}>In {screen.selection.minutes} minutes ▾</Text></Pressable> : null}
    {screen.selection.mode === "exact" ? <View style={styles.modes}>
      <Pressable accessibilityRole="button" style={styles.field} onPress={() => setPickerMode("date")}><Text style={styles.fieldText}>Choose date</Text></Pressable>
      <Pressable accessibilityRole="button" style={styles.field} onPress={() => setPickerMode("time")}><Text style={styles.fieldText}>Choose time</Text></Pressable>
    </View> : null}
    {pickerMode ? <DateTimePicker value={exact} mode={pickerMode} timeZoneName={CAMPUS_TIMEZONE} display={Platform.OS === "ios" ? "spinner" : "default"}
      onChange={(event, value) => {
        if (Platform.OS !== "ios") setPickerMode(undefined);
        if (event.type !== "set" || !value) return;
        setExact(value);
        screen.setSelection({ mode: "exact", time: value.toISOString() });
        if (pickerMode === "date" && Platform.OS !== "ios") setPickerMode("time");
      }} /> : null}
    {pickerMode && Platform.OS === "ios" ? <Pressable accessibilityRole="button" onPress={() => setPickerMode(undefined)} style={styles.field}><Text style={styles.fieldText}>Done</Text></Pressable> : null}
    <Text style={styles.hint}>Times are in San José campus time. Predictions refresh each minute.</Text>
    {screen.error ? <Text accessibilityRole="alert" style={styles.error}>{screen.error}</Text> : null}
    {screen.stale ? <Text style={styles.error}>Showing the last successful forecast. Its graph time has not refreshed.</Text> : null}
    {screen.isLoading ? <ActivityIndicator accessibilityLabel="Loading parking predictions" color="#0055A5" style={{ marginVertical: 20 }} /> : null}
    {screen.data ? <>
      <Text style={styles.target}>Expected at {formatCampusTime(screen.data.targetTime)}</Text>
      <View style={styles.cards}>{screen.data.predictions.map(garage => <View key={garage.id} style={styles.card} accessibilityLabel={`${garage.name}: ${garage.fullnessPercent === null ? "unavailable" : `${garage.fullnessPercent} percent full`}`}>
        <Text style={styles.garage}>{garage.name}</Text>
        <Text style={styles.percent}>{garage.fullnessPercent === null ? "Unavailable" : `${garage.fullnessPercent}%`}</Text>
        <Text style={styles.hint}>{garage.fullnessPercent === null ? "Not enough historical data to estimate this" : garage.sourceTime ? `From ${formatCampusTime(garage.sourceTime)}` : "Model estimate from historical data"}</Text>
      </View>)}</View>
      <ForecastChart data={screen.data} />
    </> : null}
    <Modal transparent visible={algorithmOpen} animationType="fade" onRequestClose={() => setAlgorithmOpen(false)}>
      <View style={styles.overlay}><View style={styles.modal}>
        <Text style={styles.label}>Prediction algorithm</Text>
        {screen.algorithms.length === 0 ? <Text style={styles.hint}>Connect to the server to load available algorithms.</Text> : screen.algorithms.map(model =>
          <Pressable key={model.id} accessibilityRole="button" style={styles.field} onPress={() => { screen.setAlgorithm(model.id); setAlgorithmOpen(false); }}><Text style={styles.fieldText}>{model.name}{screen.algorithm === model.id ? " ✓" : ""}</Text></Pressable>)}
        <Pressable accessibilityRole="button" onPress={() => setAlgorithmOpen(false)} style={styles.field}><Text style={styles.fieldText}>Close</Text></Pressable>
      </View></View>
    </Modal>
    {rollerOpen ? <MinuteRoller initial={minutes} onClose={() => setRollerOpen(false)} onSelect={value => { setMinutes(value); screen.setSelection({ mode: "relative", minutes: value }); setRollerOpen(false); }} /> : null}
  </View>;
}

function MinuteRoller({ initial, onClose, onSelect }: { initial: number; onClose: () => void; onSelect: (minutes: number) => void }) {
  const [value, setValue] = useState(initial);
  const list = useRef<FlatList<number>>(null);
  return <Modal transparent visible animationType="fade" onRequestClose={onClose}>
    <View style={styles.overlay}><View style={styles.modal}>
      <Text style={styles.label}>Minutes from now: {value}</Text>
      <View style={styles.roller}>
        <View pointerEvents="none" style={styles.rollerSelection} />
        <FlatList ref={list} data={Array.from({ length: 90 }, (_, i) => i + 1)} keyExtractor={String} initialScrollIndex={initial - 1}
          getItemLayout={(_, index) => ({ length: 48, offset: 48 * index, index })}
          contentContainerStyle={{ paddingVertical: 48 }} snapToInterval={48} decelerationRate="fast" showsVerticalScrollIndicator={false}
          onMomentumScrollEnd={event => setValue(Math.max(1, Math.min(90, Math.round(event.nativeEvent.contentOffset.y / 48) + 1)))}
          renderItem={({ item }) => <Pressable accessibilityRole="button" accessibilityLabel={`${item} minutes`} style={styles.rollerRow} onPress={() => { setValue(item); list.current?.scrollToIndex({ index: item - 1 }); }}>
            <Text style={[styles.rollerText, item === value && styles.activeText]}>{item} min</Text>
          </Pressable>} />
      </View>
      <Pressable accessibilityRole="button" style={styles.mode} onPress={() => onSelect(value)}><Text style={styles.fieldText}>Use {value} minutes</Text></Pressable>
      <Pressable accessibilityRole="button" style={styles.mode} onPress={onClose}><Text style={styles.fieldText}>Cancel</Text></Pressable>
    </View></View>
  </Modal>;
}

const styles = StyleSheet.create({
  label: { fontSize: 16, color: "#101828", fontWeight: "700", marginTop: 12, marginBottom: 8 },
  field: { borderWidth: 1, borderColor: "#D0D5DD", backgroundColor: "#FFFFFF", borderRadius: 8, padding: 14, marginBottom: 10 },
  fieldText: { fontSize: 15, color: "#0055A5", fontWeight: "600" },
  hint: { fontSize: 13, color: "#667085", lineHeight: 19, marginBottom: 8 },
  modes: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  mode: { padding: 12, backgroundColor: "#FFFFFF", borderColor: "#D0D5DD", borderWidth: 1, borderRadius: 8 },
  activeMode: { backgroundColor: "#EAF2FF", borderColor: "#0055A5" },
  modeText: { color: "#475467", fontSize: 13 }, activeText: { color: "#0055A5", fontWeight: "700" },
  error: { color: "#B42318", fontSize: 14, marginVertical: 8 },
  target: { color: "#101828", fontSize: 16, fontWeight: "700", marginVertical: 12 },
  cards: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  card: { width: "48%", flexGrow: 1, padding: 12, backgroundColor: "#FFFFFF", borderColor: "#D0D5DD", borderWidth: 1, borderRadius: 10 },
  garage: { fontSize: 15, color: "#101828", fontWeight: "700" },
  percent: { fontSize: 22, color: "#0055A5", fontWeight: "700", marginVertical: 12 },
  overlay: { flex: 1, backgroundColor: "rgba(16,24,40,0.5)", justifyContent: "center", padding: 24 },
  modal: { backgroundColor: "#FFFFFF", padding: 20, borderRadius: 12 },
  roller: { height: 144, marginBottom: 18 },
  rollerSelection: { position: "absolute", top: 48, left: 0, right: 0, height: 48, backgroundColor: "#EAF2FF", borderRadius: 8 },
  rollerRow: { height: 48, alignItems: "center", justifyContent: "center" },
  rollerText: { fontSize: 20, color: "#667085" }
});
