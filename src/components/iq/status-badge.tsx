import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type Tone = "bullish" | "bearish" | "warning" | "info" | "neutral";

interface StatusBadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  size?: "sm" | "md";
}

const toneStyles: Record<Tone, string> = {
  bullish: "bg-bullish-soft text-bullish",
  bearish: "bg-bearish-soft text-bearish",
  warning: "bg-warning-soft text-warning",
  info: "bg-info-soft text-info",
  neutral: "bg-muted text-muted-foreground",
};

export function StatusBadge({
  tone = "neutral",
  children,
  className,
  size = "sm",
}: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md font-semibold uppercase tracking-wider",
        size === "sm" ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-xs",
        toneStyles[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
