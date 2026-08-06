import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { NewsItem } from "@/lib/types";
import type { NewsPriorityResult } from "@/lib/engine/news-priority";
import { StatusBadge } from "./status-badge";
import { IqCard } from "./iq-card";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

function timeAgo(min: number, t: (key: string, opts?: Record<string, unknown>) => string) {
  if (min < 60) return t("components.batchB.timeAgo.minutes", { count: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t("components.batchB.timeAgo.hours", { count: h });
  return t("components.batchB.timeAgo.days", { count: Math.floor(h / 24) });
}

const impactTone = { high: "bearish", medium: "warning", low: "info" } as const;
const dirIcon = { bullish: TrendingUp, bearish: TrendingDown, neutral: Minus };

export function NewsImpactCard({
  item,
  priority,
  className,
}: {
  item: NewsItem;
  /** Why this item was ranked where it is — renders a small "top of feed" badge. */
  priority?: NewsPriorityResult;
  className?: string;
}) {
  const { t } = useTranslation();
  const Icon = dirIcon[item.direction];
  return (
    <IqCard interactive className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge tone={impactTone[item.impact]}>{item.impact}</StatusBadge>
            {priority?.isMacro && (
              <StatusBadge tone="warning">{t("components.batchB.newsImpactCard.macro")}</StatusBadge>
            )}
            {!priority?.isMacro && priority && priority.matchedTickers.length > 0 && (
              <StatusBadge tone="info">{priority.matchedTickers[0]}</StatusBadge>
            )}
            <span className="text-[11px] text-muted-foreground">
              {timeAgo(item.minutesAgo, t)}
            </span>
            <span className="text-[11px] text-muted-foreground">· {item.source}</span>
          </div>
          <h3 className="mt-2 text-sm font-semibold leading-snug sm:text-base">{item.headline}</h3>
        </div>
        <div
          className={cn(
            "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
            item.direction === "bullish" && "bg-bullish-soft text-bullish",
            item.direction === "bearish" && "bg-bearish-soft text-bearish",
            item.direction === "neutral" && "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
      {item.summary && <p className="text-xs text-muted-foreground">{item.summary}</p>}
      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        <span className="eyebrow">{t("components.batchB.newsImpactCard.affects")}</span>
        {item.assets.map((a) => (
          <span
            key={a}
            className="rounded-md border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          >
            {a}
          </span>
        ))}
      </div>
    </IqCard>
  );
}
