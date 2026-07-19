import { useEffect, useState } from "react";
import type { IChartApi, ISeriesApi } from "lightweight-charts";
import { Button } from "@/components/ui/button";
import { Zap, Lock } from "lucide-react";
import type { RiskRewardPlan } from "@/lib/engine/quant";
import { cn } from "@/lib/utils";

interface TradeActionOverlayProps {
  chart: IChartApi | null;
  series: ISeriesApi<"Candlestick"> | null;
  plan: RiskRewardPlan | null;
  planStrong: boolean;
  onTrade: () => void;
}

export function TradeActionOverlay({
  chart,
  series,
  plan,
  planStrong,
  onTrade,
}: TradeActionOverlayProps) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!chart || !series || !plan || !planStrong || plan.direction === "none") {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const y = series.priceToCoordinate(plan.entry);
      const timeScale = chart.timeScale();
      const chartWidth = timeScale.width();
      const x = chartWidth - 140; // 140px from right edge to give room for price scale and labels

      if (y !== null && x > 0 && y > 0) {
        setPosition({ top: y, left: x });
      } else {
        setPosition(null);
      }
    };

    updatePosition();
    const ts = chart.timeScale();
    const ps = series.priceScale();

    // Lightweight charts requires listening to logical range change to handle pan/zoom
    ts.subscribeVisibleLogicalRangeChange(updatePosition);
    ts.subscribeVisibleTimeRangeChange(updatePosition);

    let reqId: number;
    const loop = () => {
      updatePosition();
      reqId = requestAnimationFrame(loop);
    };
    reqId = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(reqId);
      ts.unsubscribeVisibleLogicalRangeChange(updatePosition);
      ts.unsubscribeVisibleTimeRangeChange(updatePosition);
    };
  }, [chart, series, plan, planStrong]);

  if (!position || !plan || !planStrong || plan.direction === "none") return null;

  const isLong = plan.direction === "long";
  const entryStr = plan.entry < 10 ? plan.entry.toPrecision(5) : plan.entry.toFixed(2);

  return (
    <div
      style={{
        position: "absolute",
        top: position.top - 16,
        left: position.left,
        zIndex: 20,
      }}
      className="flex items-center gap-2"
    >
      <div className="flex h-8 items-center gap-1 rounded bg-background/80 px-2 text-[11px] font-bold shadow ring-1 ring-border backdrop-blur-sm">
        <span className="text-muted-foreground">Entry</span>
        <span className="text-foreground">{entryStr}</span>
      </div>
      <Button
        onClick={onTrade}
        size="sm"
        className={cn(
          "h-8 gap-1.5 px-3 font-bold shadow-lg transition-transform hover:scale-105",
          isLong 
            ? "bg-bullish text-bullish-foreground hover:bg-bullish/90" 
            : "bg-bearish text-bearish-foreground hover:bg-bearish/90"
        )}
      >
        <Zap className="h-3.5 w-3.5" />
        {isLong ? "LONG" : "SHORT"}
      </Button>
    </div>
  );
}
