import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus, Brain } from "lucide-react";
import { motion } from "framer-motion";
import type { AiSentimentSnapshot } from "@/lib/types";

function SentimentGauge({
  score,
  size = "md",
}: {
  score: number;
  size?: "sm" | "md";
}) {
  const color =
    score >= 65
      ? "text-bullish"
      : score <= 35
        ? "text-bearish"
        : "text-warning";
  const label =
    score >= 65 ? "Bullish" : score <= 35 ? "Bearish" : "Neutral";

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div
        className={cn(
          "relative flex items-center justify-center",
          size === "sm" ? "h-16 w-16" : "h-20 w-20",
        )}
      >
        <svg className="h-full w-full -rotate-90" viewBox="0 0 36 36">
          <circle
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-border opacity-30"
          />
          <motion.circle
            cx="18"
            cy="18"
            r="15.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            pathLength="1"
            strokeDasharray="1"
            initial={{ strokeDashoffset: 1 }}
            animate={{ strokeDashoffset: 1 - score / 100 }}
            transition={{ type: "spring", stiffness: 48, damping: 16, mass: 0.8 }}
            strokeLinecap="round"
            className={color}
          />
        </svg>
        <span
          className={cn(
            "absolute font-mono font-bold tabular-nums",
            size === "sm" ? "text-lg" : "text-xl",
            color,
          )}
        >
          {Math.round(score)}
        </span>
      </div>
      <span className={cn("text-xs font-semibold uppercase", color)}>
        {label}
      </span>
    </div>
  );
}

function AssetSentimentRow({
  ticker,
  sentiment,
  index,
}: {
  ticker: string;
  sentiment: { direction: string; confidence: number; reason?: string };
  index: number;
}) {
  const Icon =
    sentiment.direction === "bullish"
      ? TrendingUp
      : sentiment.direction === "bearish"
        ? TrendingDown
        : Minus;
  const color =
    sentiment.direction === "bullish"
      ? "text-bullish"
      : sentiment.direction === "bearish"
        ? "text-bearish"
        : "text-muted-foreground";
  const bgColor =
    sentiment.direction === "bullish"
      ? "bg-bullish-soft"
      : sentiment.direction === "bearish"
        ? "bg-bearish-soft"
        : "bg-muted";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.24,
        delay: 0.06 + index * 0.045,
        ease: [0.22, 1, 0.36, 1],
      }}
      className={cn(
        "flex items-center gap-2.5 rounded-md border border-border bg-surface px-3 py-2.5 transition-colors duration-200 hover:bg-surface-elevated",
        index < 3 && "border-info/20 bg-info-soft/30",
      )}
    >
      <div
        className={cn(
          "flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
          bgColor,
          color,
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-bold text-foreground">{ticker}</span>
          <span
            className={cn(
              "text-[10px] font-semibold uppercase",
              color,
            )}
          >
            {sentiment.direction}
          </span>
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
            {Math.round(sentiment.confidence * 100)}%
          </span>
        </div>
        {sentiment.reason && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {sentiment.reason}
          </p>
        )}
      </div>
    </motion.div>
  );
}

export function SentimentGaugeCard({
  data,
  className,
}: {
  data: AiSentimentSnapshot;
  className?: string;
}) {
  const ms = data.marketSentiment;
  const assets = Object.entries(data.assetSentiments).sort(
    ([, a], [, b]) => b.confidence - a.confidence,
  );

  // Ratio display
  const bullishCount = assets.filter(
    ([, s]) => s.direction === "bullish",
  ).length;
  const bearishCount = assets.filter(
    ([, s]) => s.direction === "bearish",
  ).length;
  const neutralCount = assets.filter(
    ([, s]) => s.direction === "neutral",
  ).length;

  return (
    <div
      className={cn(
        "flex flex-col gap-5 rounded-xl border border-border bg-card p-4 text-card-foreground sm:p-5",
        "shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset,0_1px_2px_0_rgba(0,0,0,0.35)]",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-info/20 bg-info-soft text-info">
          <Brain className="h-3.5 w-3.5" />
        </div>
        <h3 className="text-sm font-semibold tracking-tight text-foreground">
          AI News Sentiment
        </h3>
        <span className="ml-auto pt-0.5 text-right font-mono text-[10px] tabular-nums leading-relaxed text-muted-foreground">
          {data.headlinesAnalyzed} headlines ·{" "}
          {new Date(data.snapshotAt).toLocaleTimeString()}
        </span>
      </div>

      {/* Gauge + description */}
      <div className="flex items-center gap-5">
        <SentimentGauge score={ms.score} />
        <div className="flex-1 space-y-2">
          <p className="text-sm font-medium leading-relaxed text-foreground text-pretty">
            {ms.description}
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] tabular-nums text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-bullish" />
              Bullish {bullishCount}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-bearish" />
              Bearish {bearishCount}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
              Neutral {neutralCount}
            </span>
          </div>
        </div>
      </div>

      {/* Key narratives */}
      {data.keyNarratives.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {data.keyNarratives.map((n) => (
            <motion.span
              key={n}
              whileHover={{ scale: 1.025, y: -1 }}
              whileTap={{ scale: 0.98 }}
              transition={{ type: "spring", stiffness: 380, damping: 24 }}
              className="cursor-default rounded-md border border-border bg-surface px-2.5 py-1.5 text-[11px] text-muted-foreground transition-colors duration-200 hover:border-info/25 hover:bg-surface-elevated hover:text-foreground"
            >
              {n}
            </motion.span>
          ))}
        </div>
      )}

      {/* Per-asset breakdown */}
      {assets.length > 0 && (
        <div className="space-y-2.5">
          <h4 className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
            Per Asset
          </h4>
          <div className="grid gap-2 sm:grid-cols-2">
            {assets.slice(0, 8).map(([ticker, sentiment], i) => (
              <AssetSentimentRow
                key={ticker}
                ticker={ticker}
                sentiment={sentiment}
                index={i}
              />
            ))}
          </div>
        </div>
      )}

      {/* AI Brief */}
      {data.aiBrief && (
        <div className="rounded-lg border border-border bg-surface-elevated p-4 shadow-[0_1px_0_0_rgba(255,255,255,0.015)_inset]">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-info">
            AI brief
          </div>
          <p className="text-xs leading-5 text-foreground text-pretty">
            {data.aiBrief}
          </p>
        </div>
      )}
    </div>
  );
}
