import { Link } from "@tanstack/react-router";
import { TrendingUp } from "lucide-react";
import { useOpenTradesPnl } from "@/hooks/useOpenTradesPnl";
import { formatMoney } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

export function FloatingPnlWidget() {
  const { count, totalUnrealized, authenticated, isLoading } = useOpenTradesPnl();

  // Only render when authenticated and have open trades
  if (!authenticated || count === 0 || isLoading) {
    return null;
  }

  const isProfit = totalUnrealized >= 0;
  const formattedPnl = formatMoney(totalUnrealized);
  const signedPnl = isProfit ? `+${formattedPnl}` : `−${formattedPnl.slice(1)}`;

  return (
    <Link
      to="/trades"
      className={cn(
        // Fixed pill just below the sticky h-14 TopBar (clears its controls),
        // top-right of the content area — away from the bottom-right FABs.
        "fixed top-16 right-4 z-30 sm:right-6",
        // Sizing and shape
        "inline-flex items-center gap-2.5 px-3.5 py-2.5",
        "rounded-full text-sm font-medium",
        // Background and border
        "border border-border/50",
        "bg-card backdrop-blur-md",
        "shadow-lg shadow-black/20",
        // Hover state
        "transition-all hover:shadow-xl hover:shadow-black/30",
        // Theme colors
        isProfit ? "text-bullish hover:bg-card/80" : "text-bearish hover:bg-card/80",
      )}
    >
      {/* Pulse dot indicator */}
      <div className="relative inline-flex">
        <div
          className={cn(
            "h-2 w-2 rounded-full",
            isProfit ? "bg-bullish" : "bg-bearish",
            "animate-pulse",
          )}
        />
      </div>

      {/* Count and PnL display */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground text-xs">
          {count === 1 ? "1 open" : `${count} open`}
        </span>
        <div className="h-1 w-1 rounded-full bg-border/50" />
        <span className={cn(isProfit ? "text-bullish" : "text-bearish", "font-semibold")}>
          {signedPnl}
        </span>
      </div>
    </Link>
  );
}
