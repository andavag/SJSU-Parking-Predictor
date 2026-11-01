import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";

import { getGarageDisplay } from "./src/parkingPresentation";
import type { ParkingStatusResponse } from "./src/types";
import { useParkingStatus } from "./src/useParkingStatus";
import { PredictionScreen, usePredictionScreen } from "./src/PredictionScreen";
import { UpdateControl } from "./src/UpdateControl";
import { WestGarageCrossings } from "./src/WestGarageCrossings";
import { useCrossingLifecycle } from "./src/useCrossingLifecycle";

type ViewMode = "reported" | "expected";

export default function App() {
  useCrossingLifecycle();
  const [viewMode, setViewMode] = useState<ViewMode>("reported");
  const { data, error, isLoading, isRefreshing, refresh } = useParkingStatus();
  const prediction = usePredictionScreen(viewMode === "expected");
  const [linkError, setLinkError] = useState<string>();

  const openLink = async (url?: string) => {
    if (!url) {
      setLinkError("This official shuttle link is temporarily unavailable.");
      return;
    }
    try {
      await Linking.openURL(url);
      setLinkError(undefined);
    } catch {
      setLinkError("Unable to open the official shuttle link.");
    }
  };

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <View style={styles.container}>
        <Text accessibilityRole="header" style={styles.title}>SJSU Parking</Text>

        <View accessibilityRole="tablist" style={styles.segmentedControl}>
          <Segment label="Reported Data" isActive={viewMode === "reported"} onPress={() => setViewMode("reported")} />
          <Segment label="Expected Values" isActive={viewMode === "expected"} onPress={() => setViewMode("expected")} isSecond />
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl
            refreshing={viewMode === "reported" ? isRefreshing : prediction.isRefreshing}
            onRefresh={viewMode === "reported" ? refresh : prediction.refresh}
            tintColor="#0055A5"
          />}
        >
          {viewMode === "reported" ? (
            <ReportedData
              data={data}
              error={error}
              isLoading={isLoading}
              linkError={linkError}
              onOpenRealtime={() => void openLink(data?.shuttles.realtimeLocationUrl)}
              onOpenInformation={() => void openLink(data?.shuttles.informationUrl)}
            />
          ) : <PredictionScreen screen={prediction} />}
          <UpdateControl />
        </ScrollView>
        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function Segment({ label, isActive, onPress, isSecond = false }: {
  label: string;
  isActive: boolean;
  onPress: () => void;
  isSecond?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: isActive }}
      onPress={onPress}
      style={[styles.segment, isSecond && styles.secondSegment, isActive && styles.activeSegment]}
    >
      <Text style={[styles.segmentText, isActive && styles.activeSegmentText]}>{label}</Text>
    </Pressable>
  );
}

function ReportedData({
  data,
  error,
  isLoading,
  linkError,
  onOpenRealtime,
  onOpenInformation
}: {
  data?: ParkingStatusResponse;
  error?: string;
  isLoading: boolean;
  linkError?: string;
  onOpenRealtime: () => void;
  onOpenInformation: () => void;
}) {
  if (isLoading && !data) {
    return (
      <View style={styles.loadingState}>
        <ActivityIndicator accessibilityLabel="Loading parking data" color="#0055A5" size="large" />
        <Text style={styles.loadingText}>Loading live parking data…</Text>
      </View>
    );
  }

  return (
    <View>
      {data ? <Text style={styles.updated}>Last updated: {data.sourceUpdatedAt}</Text> : null}
      {data?.stale ? <Text style={styles.warning}>Showing the most recently reported data while SJSU refreshes.</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {data?.garages.map((garage) => {
        const display = getGarageDisplay(garage);
        return (
          <View key={garage.id} accessibilityLabel={`${garage.name}, ${garage.fullnessPercent} percent, ${display.label}`} style={styles.garageCard}>
            <View style={styles.garageHeading}>
              <Text style={styles.garageName}>{garage.name}</Text>
              <Text style={[styles.status, { color: display.color }]}>{display.label}</Text>
            </View>
            <Text style={styles.address}>{garage.address}</Text>
            <Text style={styles.percent}>{garage.fullnessPercent}%</Text>
          </View>
        );
      })}

      {Platform.OS === "android" ? <WestGarageCrossings /> : null}

      {data ? <View style={styles.shuttleSection}>
        <Text style={styles.shuttleTitle}>Parking Shuttle Information</Text>
        <Text style={styles.shuttleDescription}>{data.shuttles.description}</Text>
        <Pressable accessibilityRole="button" onPress={onOpenRealtime} style={styles.actionButton}>
          <Text style={styles.actionButtonText}>Realtime Shuttle Location</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onOpenInformation} style={styles.secondaryButton}>
          <Text style={styles.secondaryButtonText}>SJSU Shuttle Information</Text>
        </Pressable>
      </View> : null}

      {linkError ? <Text style={styles.error}>{linkError}</Text> : null}
      {!data && !error ? <Text style={styles.empty}>No parking data is available yet.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#F7F9FC" },
  container: { flex: 1, paddingHorizontal: 20, paddingTop: 34 },
  title: { color: "#0055A5", fontSize: 30, fontWeight: "800" },
  segmentedControl: {
    backgroundColor: "#FFFFFF",
    borderColor: "#D0D5DD",
    borderWidth: 1,
    flexDirection: "row",
    marginTop: 22
  },
  segment: { alignItems: "center", flex: 1, justifyContent: "center", minHeight: 48, paddingHorizontal: 8 },
  secondSegment: { borderLeftColor: "#D0D5DD", borderLeftWidth: 1 },
  activeSegment: { backgroundColor: "#F2F7FF" },
  segmentText: { color: "#475467", fontSize: 14, fontWeight: "700", textAlign: "center" },
  activeSegmentText: { color: "#0055A5" },
  content: { flexGrow: 1, paddingBottom: 32, paddingTop: 20 },
  loadingState: { alignItems: "center", paddingTop: 52 },
  loadingText: { color: "#475467", fontSize: 15, marginTop: 14 },
  updated: { color: "#475467", fontSize: 14, marginBottom: 12 },
  warning: { color: "#7A2E0E", fontSize: 14, marginBottom: 12 },
  error: { color: "#B42318", fontSize: 14, marginTop: 12 },
  garageCard: { backgroundColor: "#FFFFFF", borderColor: "#D0D5DD", borderRadius: 12, borderWidth: 1, marginBottom: 12, padding: 16 },
  garageHeading: { alignItems: "center", flexDirection: "row", gap: 12, justifyContent: "space-between" },
  garageName: { color: "#101828", flex: 1, fontSize: 18, fontWeight: "800" },
  status: { fontSize: 14, fontWeight: "800" },
  address: { color: "#667085", fontSize: 14, lineHeight: 20, marginTop: 6 },
  percent: { color: "#101828", fontSize: 20, fontWeight: "800", marginTop: 14 },
  shuttleSection: { borderTopColor: "#D0D5DD", borderTopWidth: 1, marginTop: 10, paddingTop: 22 },
  shuttleTitle: { color: "#101828", fontSize: 20, fontWeight: "800", marginBottom: 8 },
  shuttleDescription: { color: "#344054", fontSize: 16, lineHeight: 24, marginBottom: 18 },
  actionButton: { backgroundColor: "#0055A5", borderRadius: 8, marginBottom: 12, padding: 15 },
  actionButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "800", textAlign: "center" },
  secondaryButton: { borderColor: "#0055A5", borderRadius: 8, borderWidth: 1, padding: 15 },
  secondaryButtonText: { color: "#0055A5", fontSize: 16, fontWeight: "800", textAlign: "center" },
  empty: { color: "#667085", fontSize: 16 },
  historyTitle: { color: "#101828", fontSize: 20, fontWeight: "800", marginBottom: 8 },
  historyHint: { color: "#667085", fontSize: 14, marginBottom: 18 },
  historyLine: { color: "#344054", fontSize: 16, lineHeight: 26 }
});
