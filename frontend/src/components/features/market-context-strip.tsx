import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import { CardEyebrow, IqCard } from "./iq-card";
import { MiniChart } from "./mini-chart";
import { SkeletonCard } from "./skeletons";
import { useAssets, useRegime, useRotation, useSentiment, useVolatility } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import type { SparkPoint } from "@/lib/types";

/**
 * The five context reads under the attention feed — the same snapshot calls
 * the dedicated pages render, condensed to one tappable row. Sparklines are
 * drawn only where a real series exists (regime timeline, sector leader,
 * BTC ATR); breadth and sentiment are point-in-time and render as meters
 * rather than invented history.
 */

function ContextTile({
  label,
  value,
  tone,
  detail,
  to,
  children,
}: {
  label: string;
  value: string;
  tone: "bullish" | "bearish" | "warning" | "neutral";
  detail: string;
  to: string;
  children?: React.ReactNode;
}) {
  return (
    <Link to={to} className="group/ctx block h-full">
      <IqCard interactive className="flex h-full flex-col gap-2">
        <div className="flex items-start justify-between">
          <CardEyebrow>{label}</CardEyebrow>
          <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground/60 transition-colors group-hover/ctx:text-info" />
        </div>
        <div
          className={cn(
            "text-lg font-bold tracking-tight",
            tone === "bullish" && "text-bullish",
            tone === "bearish" && "text-bearish",
            tone === "warning" && "text-warning",
            tone === "neutral" && "text-foreground",
          )}
        >
          {value}
        </div>
        <div className="text-[11px] text-muted-foreground">{detail}</div>
        <div className="mt-auto pt-1">{children}</div>
      </IqCard>
    </Link>
  );
}

function Meter({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div
        className={cn("h-full rounded-full", tone)}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  );
}

export function MarketContextStrip() {
  const regime = useRegime();
  const rotation = useRotation();
  const sentiment = useSentiment();
  const volatility = useVolatility();
  const assets = useAssets();

  if (!regime.data || !rotation.data || !sentiment.data || !volatility.data) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonCard key={i} height={130} />
        ))}
      </div>
    );
  }

  const r = regime.data;
  const breadth = r.pillars.find((p) => p.label === "Breadth");
  const leader = assets.data?.find((a) => a.sector === rotation.data?.winning);
  const regimeSpark: SparkPoint[] = r.timeline.map((p) => ({ t: p.t, v: p.value }));

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
      <ContextTile
        label="Regime"
        value={r.regime}
        tone={r.regime === "Risk On" ? "bullish" : r.regime === "Risk Off" ? "bearish" : "warning"}
        detail={`${r.confidence}% rule confidence · trend ${r.trendStrength.toLowerCase()}`}
        to="/regime"
      >
        {regimeSpark.length > 1 && (
          <MiniChart
            data={regimeSpark}
            tone={r.regime === "Risk Off" ? "bearish" : "bullish"}
            height={28}
          />
        )}
      </ContextTile>

      <ContextTile
        label="Rotation"
        value={`${rotation.data.losing} → ${rotation.data.winning}`}
        tone={rotation.data.strength === "High" ? "bullish" : "neutral"}
        detail={`${rotation.data.strength} rotation strength`}
        to="/rotation"
      >
        {leader && (
          <MiniChart
            data={leader.spark}
            tone={leader.change24h >= 0 ? "bullish" : "bearish"}
            height={28}
          />
        )}
      </ContextTile>

      <ContextTile
        label="Sentiment"
        value={sentiment.data.label}
        tone={
          sentiment.data.label === "Bullish"
            ? "bullish"
            : sentiment.data.label === "Bearish"
              ? "bearish"
              : "warning"
        }
        detail={`${sentiment.data.score} / 100${sentiment.data.source === "proxy" ? " · estimated" : ""}`}
        to="/news"
      >
        <Meter
          value={sentiment.data.score}
          tone={
            sentiment.data.label === "Bullish"
              ? "bg-bullish"
              : sentiment.data.label === "Bearish"
                ? "bg-bearish"
                : "bg-warning"
          }
        />
      </ContextTile>

      <ContextTile
        label="Breadth"
        value={breadth ? `${breadth.score}%` : "—"}
        tone={
          !breadth
            ? "neutral"
            : breadth.score >= 60
              ? "bullish"
              : breadth.score >= 40
                ? "warning"
                : "bearish"
        }
        detail={breadth?.description ?? "Participation across the tracked universe"}
        to="/regime"
      >
        {breadth && (
          <Meter
            value={breadth.score}
            tone={
              breadth.score >= 60 ? "bg-bullish" : breadth.score >= 40 ? "bg-warning" : "bg-bearish"
            }
          />
        )}
      </ContextTile>

      <ContextTile
        label="Volatility"
        value={volatility.data.label}
        tone={
          volatility.data.label === "High"
            ? "bearish"
            : volatility.data.label === "Medium"
              ? "warning"
              : "neutral"
        }
        detail={`BTC ATR (1D) ${volatility.data.vix.toFixed(1)}%`}
        to="/technical"
      >
        <MiniChart data={volatility.data.spark} tone="bearish" height={28} />
      </ContextTile>
    </div>
  );
}
