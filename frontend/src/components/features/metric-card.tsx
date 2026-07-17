import { Link } from "@tanstack/react-router";
import { ArrowUpRight } from "lucide-react";

import { IqCard, CardEyebrow } from "./iq-card";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface MetricCardProps {
  label: ReactNode;
  value: ReactNode;
  accent?: "bullish" | "bearish" | "warning" | "info" | "neutral";
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** Route this card drills into — the whole card becomes a link. */
  to?: string;
}

const accentText: Record<NonNullable<MetricCardProps["accent"]>, string> = {
  bullish: "text-bullish",
  bearish: "text-bearish",
  warning: "text-warning",
  info: "text-info",
  neutral: "text-foreground",
};

export function MetricCard({
  label,
  value,
  accent = "neutral",
  footerLeft,
  footerRight,
  children,
  className,
  to,
}: MetricCardProps) {
  const card = (
    <IqCard interactive className={cn("flex h-full flex-col gap-3", className)}>
      <div className="flex items-start justify-between gap-2">
        <CardEyebrow>{label}</CardEyebrow>
        {to && (
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/metric:text-info" />
        )}
      </div>
      <div className={cn("text-2xl font-semibold tracking-tight sm:text-3xl", accentText[accent])}>
        {value}
      </div>
      {children}
      {(footerLeft || footerRight) && (
        <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-xs text-muted-foreground">
          <div>{footerLeft}</div>
          <div className="font-medium text-foreground">{footerRight}</div>
        </div>
      )}
    </IqCard>
  );

  if (!to) return card;
  return (
    <Link to={to} className="group/metric block h-full">
      {card}
    </Link>
  );
}
