import { cn } from "@/lib/utils";
import { IqCard, CardEyebrow } from "./iq-card";
import type { Signal } from "@/lib/types";
import { StatusBadge } from "./status-badge";
import { CheckCircle2, AlertTriangle, XCircle, MinusCircle } from "lucide-react";

const toneMap: Record<Signal["status"], { badge: "bullish" | "bearish" | "warning" | "neutral"; Icon: typeof CheckCircle2 }> = {
  bullish: { badge: "bullish", Icon: CheckCircle2 },
  bearish: { badge: "bearish", Icon: XCircle },
  warning: { badge: "warning", Icon: AlertTriangle },
  neutral: { badge: "neutral", Icon: MinusCircle },
};

export function SignalCard({ signal, className }: { signal: Signal; className?: string }) {
  const t = toneMap[signal.status];
  return (
    <IqCard interactive className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between">
        <CardEyebrow>{signal.label}</CardEyebrow>
        <t.Icon
          className={cn(
            "h-4 w-4",
            signal.status === "bullish" && "text-bullish",
            signal.status === "bearish" && "text-bearish",
            signal.status === "warning" && "text-warning",
            signal.status === "neutral" && "text-muted-foreground",
          )}
        />
      </div>
      <div className="flex items-baseline justify-between">
        <div className="text-lg font-semibold tracking-tight">{signal.value}</div>
        <StatusBadge tone={t.badge}>{signal.status}</StatusBadge>
      </div>
      {signal.detail && <p className="text-xs text-muted-foreground">{signal.detail}</p>}
    </IqCard>
  );
}
