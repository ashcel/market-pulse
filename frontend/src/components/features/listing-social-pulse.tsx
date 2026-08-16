import { useTranslation } from "react-i18next";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { StatusBadge } from "@/components/features/status-badge";
import type { SocialPulseRead } from "@/hooks/useListings";
import { cn } from "@/lib/utils";

/**
 * Realtime social pulse.
 *
 * Two numbers do the work: the reach-weighted sentiment, and the share of
 * collected posts judged spam. Showing them together is the point — buzz that
 * is 90% farm is a different signal from the same buzz organically produced,
 * and a sentiment score alone cannot tell them apart.
 *
 * When no collector is configured this says so rather than rendering a
 * neutral zero, which would read as genuine indifference.
 */

function sentimentTone(sentiment: number): "bullish" | "bearish" | "neutral" {
  if (sentiment > 0.15) return "bullish";
  if (sentiment < -0.15) return "bearish";
  return "neutral";
}

type Translate = ReturnType<typeof useTranslation>["t"];

function relativeAge(hours: number, t: Translate): string {
  if (hours < 1) {
    return t("listings.social.minutesAgo", { count: Math.max(1, Math.round(hours * 60)) });
  }
  if (hours < 24) return t("listings.social.hoursAgo", { count: Math.round(hours) });
  return t("listings.social.daysAgo", { count: Math.round(hours / 24) });
}

export function ListingSocialPulse({
  pulse,
  symbol,
  className,
}: {
  pulse: SocialPulseRead | null;
  symbol: string;
  className?: string;
}) {
  const { t } = useTranslation();

  if (!pulse || pulse.unavailableReason) {
    const reason = pulse?.unavailableReason ?? "not_collected";
    return (
      <IqCard className={className}>
        <CardEyebrow>{t("listings.social.title")}</CardEyebrow>
        <p className="mt-3 text-sm text-muted-foreground">
          {t(`listings.social.unavailable.${reason}`, {
            defaultValue: t("listings.social.unavailable.generic"),
          })}
        </p>
      </IqCard>
    );
  }

  const sentiment = pulse.sentiment ?? 0;
  const tone = sentimentTone(sentiment);
  const farmed = pulse.spamRatio > 0.6;

  return (
    <IqCard className={className}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardEyebrow>{t("listings.social.title")}</CardEyebrow>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("listings.social.subtitle", { symbol })}
          </p>
        </div>
        <StatusBadge tone={tone}>{t(`listings.social.tone.${tone}`)}</StatusBadge>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("listings.social.sentiment")}
          </span>
          <span
            className={cn(
              "num text-sm font-semibold",
              tone === "bullish" && "text-bullish",
              tone === "bearish" && "text-bearish",
            )}
          >
            {sentiment > 0 ? "+" : ""}
            {sentiment.toFixed(2)}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("listings.social.posts")}
          </span>
          <span className="num text-sm font-semibold">{pulse.posts24h}</span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("listings.social.velocity")}
          </span>
          <span className="num text-sm font-semibold">
            {pulse.velocity != null ? `${pulse.velocity.toFixed(1)}x` : "—"}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("listings.social.spam")}
          </span>
          <span className={cn("num text-sm font-semibold", farmed && "text-warning")}>
            {Math.round(pulse.spamRatio * 100)}%
          </span>
        </div>
      </div>

      {farmed && (
        <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-[11px] leading-relaxed text-warning">
          {t("listings.social.farmedWarning")}
        </p>
      )}

      {pulse.topPosts.length > 0 && (
        <ul className="mt-4 flex flex-col divide-y divide-border border-t border-border">
          {pulse.topPosts.map((post) => (
            <li key={post.id} className="py-2.5">
              <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="text-xs font-semibold text-foreground">
                  {post.author ? `@${post.author}` : post.source}
                </span>
                <span className="num text-[10px] text-muted-foreground">
                  {post.followers.toLocaleString()} {t("listings.social.followers")}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  · {relativeAge(post.ageHours, t)}
                </span>
                <span
                  className={cn(
                    "num ml-auto text-[10px] font-semibold",
                    post.sentiment > 0.05 && "text-bullish",
                    post.sentiment < -0.05 && "text-bearish",
                    Math.abs(post.sentiment) <= 0.05 && "text-muted-foreground",
                  )}
                >
                  {post.sentiment > 0 ? "+" : ""}
                  {post.sentiment.toFixed(2)}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-foreground">{post.text}</p>
              <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="num">
                  {post.likes.toLocaleString()} {t("listings.social.likes")}
                </span>
                <span className="num">
                  {post.reposts.toLocaleString()} {t("listings.social.reposts")}
                </span>
                {post.url && (
                  <a
                    href={post.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="ml-auto font-medium text-info hover:underline"
                  >
                    {t("listings.social.open")}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </IqCard>
  );
}
