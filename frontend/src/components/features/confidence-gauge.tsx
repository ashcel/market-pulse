import { RadialBarChart, RadialBar, PolarAngleAxis, ResponsiveContainer } from "recharts";

interface ConfidenceGaugeProps {
  value: number;
  size?: number;
  label?: string;
  showValue?: boolean;
  /**
   * CSS color overriding the value-based tint. Use when the gauge sits next
   * to a verdict: the ring then echoes the verdict's color instead of scoring
   * the number on its own green/amber/red scale.
   */
  tone?: string;
}

export function ConfidenceGauge({
  value,
  size = 88,
  label,
  showValue = true,
  tone: toneOverride,
}: ConfidenceGaugeProps) {
  const tone =
    toneOverride ??
    (value >= 70
      ? "var(--color-bullish)"
      : value >= 45
        ? "var(--color-warning)"
        : "var(--color-bearish)");
  const data = [{ name: "v", value, fill: tone }];
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <ResponsiveContainer>
        <RadialBarChart
          innerRadius="72%"
          outerRadius="100%"
          data={data}
          startAngle={90}
          endAngle={-270}
          barSize={8}
        >
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar
            dataKey="value"
            cornerRadius={20}
            background={{ fill: "var(--color-muted)" }}
          />
        </RadialBarChart>
      </ResponsiveContainer>
      {showValue && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div className="num text-lg font-semibold tracking-tight" style={{ color: tone }}>
            {value}%
          </div>
          {label && (
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {label}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
