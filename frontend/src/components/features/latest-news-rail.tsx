import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { CardEyebrow, IqCard } from "./iq-card";
import { SkeletonCard } from "./skeletons";
import { useNews } from "@/hooks/queries";
import { cn } from "@/lib/utils";

/** Headline rail — the newest tagged stories, impact-coloured, newest first. */
export function LatestNewsRail({ limit = 6 }: { limit?: number }) {
  const { t } = useTranslation();
  const { data, isLoading } = useNews();

  return (
    <IqCard padded={false} className="flex flex-col p-5">
      <div className="flex items-center justify-between">
        <CardEyebrow>{t("components.batchB.latestNewsRail.title")}</CardEyebrow>
        <Link to="/news" className="text-xs font-medium text-info hover:underline">
          {t("components.batchB.latestNewsRail.viewAll")}
        </Link>
      </div>

      {isLoading ? (
        <div className="mt-4 flex flex-col gap-2">
          <SkeletonCard height={56} />
          <SkeletonCard height={56} />
        </div>
      ) : !data || data.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">
          {t("components.batchB.latestNewsRail.empty")}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border">
          {data.slice(0, limit).map((n) => (
            <li key={n.id}>
              <Link to="/news" className="flex gap-3 py-3 transition-colors hover:bg-surface/50">
                <span
                  className={cn(
                    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold",
                    n.direction === "bullish" && "bg-bullish-soft text-bullish",
                    n.direction === "bearish" && "bg-bearish-soft text-bearish",
                    n.direction === "neutral" && "bg-muted/50 text-muted-foreground",
                  )}
                >
                  {n.assets[0]?.slice(0, 3) ?? "MKT"}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium leading-snug">{n.headline}</p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {n.minutesAgo < 60
                      ? t("components.batchB.timeAgo.minutes", { count: n.minutesAgo })
                      : t("components.batchB.timeAgo.hours", {
                          count: Math.round(n.minutesAgo / 60),
                        })}{" "}
                    · {n.source}
                    {n.impact === "high" && (
                      <span className="ml-1 font-semibold text-bearish">
                        · {t("components.batchB.latestNewsRail.highImpact")}
                      </span>
                    )}
                  </p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </IqCard>
  );
}
