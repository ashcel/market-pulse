import { IqCard, CardEyebrow } from "./iq-card";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

interface MetricCardProps {
  label: string;
  value: ReactNode;
  accent?: "bullish" | "bearish" | "warning" | "info" | "neutral";
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  children?: ReactNode;
  className?: string;
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
}: MetricCardProps) {
  return (
    <IqCard interactive className={cn("flex flex-col gap-3", className)}>
      <CardEyebrow>{label}</CardEyebrow>
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
}
