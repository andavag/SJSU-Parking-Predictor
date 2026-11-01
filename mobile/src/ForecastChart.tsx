import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Svg, { Circle, Line, Path, Text as SvgText } from "react-native-svg";
import { forecastPath, formatCampusTime } from "./forecastPresentation";
import type { PredictionResponse } from "./types";

const COLORS = ["#0055A5", "#B54708", "#067647", "#9333EA"];
export function ForecastChart({ data }: { data: PredictionResponse }) {
  const [width, setWidth] = useState(300);
  const height = 240;
  const start = new Date(data.graph.startTime).getTime(), end = new Date(data.graph.endTime).getTime();
  const nowX = 38 + (width - 50) / 2;
  const hasPoints = data.graph.series.some(series => [...series.observed, ...series.forecast].some(p => p.fullnessPercent !== null));
  return <View onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <Text style={styles.title}>Past & future occupancy</Text>
    <Text style={styles.hint}>Solid: reported · Dashed: predicted · Campus time</Text>
    <Svg width={width} height={height} accessibilityLabel="Garage fullness, from 90 minutes before now to 90 minutes after now. Solid lines show reports; dashed lines show predictions.">
      {[0, 25, 50, 75, 100].map(value => {
        const y = 16 + (100 - value) / 100 * (height - 52);
        return <ViewlessGrid key={value} width={width} y={y} value={value} />;
      })}
      <Line x1={nowX} x2={nowX} y1={16} y2={height - 36} stroke="#667085" strokeDasharray="3 3" />
      {data.graph.series.map((series, index) => {
        const color = COLORS[index % COLORS.length];
        return [<Path key={`${series.id}-observed`} d={forecastPath(series.observed, start, end, width, height)} stroke={color} strokeWidth={2} fill="none" />,
          <Path key={`${series.id}-forecast`} d={forecastPath(series.forecast, start, end, width, height)} stroke={color} strokeWidth={2} strokeDasharray="5 4" fill="none" />,
          ...[...series.observed, ...series.forecast].filter(point => point.fullnessPercent !== null).map((point, i) =>
            <Circle key={`${series.id}-point-${i}`} cx={38 + (new Date(point.time).getTime() - start) / (end - start) * (width - 50)}
              cy={16 + (100 - point.fullnessPercent!) / 100 * (height - 52)} r={1.5} fill={color} />)];
      })}
      <SvgText x={38} y={height - 10} fontSize={11} fill="#475467">{formatCampusTime(data.graph.startTime, false)}</SvgText>
      <SvgText x={nowX} y={height - 10} fontSize={11} textAnchor="middle" fill="#475467">Now</SvgText>
      <SvgText x={width - 12} y={height - 10} fontSize={11} textAnchor="end" fill="#475467">{formatCampusTime(data.graph.endTime, false)}</SvgText>
    </Svg>
    {!hasPoints ? <Text style={styles.hint}>No readings are available in this window yet.</Text> : null}
    <View style={styles.legend}>{data.graph.series.map((series, index) => <Text key={series.id} style={[styles.legendLabel, { color: COLORS[index % COLORS.length] }]}>{series.name}</Text>)}</View>
    <Text style={styles.hint}>Gaps mean no recorded reading was available.</Text>
  </View>;
}
function ViewlessGrid({ width, y, value }: { width: number; y: number; value: number }) {
  return <><Line x1={38} x2={width - 12} y1={y} y2={y} stroke="#D0D5DD" />
    <SvgText x={32} y={y + 4} textAnchor="end" fontSize={11} fill="#475467">{value}%</SvgText></>;
}
const styles = StyleSheet.create({
  title: { fontSize: 19, fontWeight: "700", color: "#101828", marginTop: 18, marginBottom: 8 },
  hint: { fontSize: 13, color: "#667085", marginBottom: 8 },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginBottom: 10 },
  legendLabel: { fontSize: 13, fontWeight: "600" }
});
