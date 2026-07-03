import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";
import type { SparkPoint } from "@/lib/types";

interface MiniChartProps {
  data: SparkPoint[];
  tone?: "bullish" | "bearish" | "neutral";
  height?: number;
  strokeWidth?: number;
}

export function MiniChart({
  data,
  tone = "neutral",
  height = 36,
  strokeWidth = 1.5,
}: MiniChartProps) {
  const stroke =
    tone === "bullish"
      ? "var(--color-bullish)"
      : tone === "bearish"
        ? "var(--color-bearish)"
        : "var(--color-muted-foreground)";
  return (
    <div style={{ width: "100%", height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <YAxis hide domain={["dataMin", "dataMax"]} />
          <Line
            type="monotone"
            dataKey="v"
            stroke={stroke}
            strokeWidth={strokeWidth}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
