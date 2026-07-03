import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

interface ChangeProps {
  value: number;
  suffix?: string;
  showIcon?: boolean;
  className?: string;
  precision?: number;
}

export function Change({
  value,
  suffix = "%",
  showIcon = false,
  className,
  precision = 2,
}: ChangeProps) {
  const dir = value > 0 ? "up" : value < 0 ? "down" : "flat";
  const Icon = dir === "up" ? TrendingUp : dir === "down" ? TrendingDown : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 num text-xs font-medium",
        dir === "up" && "text-bullish",
        dir === "down" && "text-bearish",
        dir === "flat" && "text-muted-foreground",
        className,
      )}
    >
      {showIcon && <Icon className="h-3 w-3" />}
      {value > 0 ? "+" : ""}
      {value.toFixed(precision)}
      {suffix}
    </span>
  );
}
