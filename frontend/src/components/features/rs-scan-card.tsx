import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Badge } from "@/components/ui/badge";
import { AssetIcon } from "@/components/features/asset-icon";
import { Change } from "@/components/features/change";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { SkeletonCard } from "@/components/features/skeletons";
import { StatusBadge } from "@/components/features/status-badge";
import { useRsScan } from "@/hooks/queries";
import type { RsRow, RsTransitionFlag } from "@/lib/engine/rs-scan";
import { cn } from "@/lib/utils";

/**
 * Full-exchange relative strength vs BTC — leaders and laggards across every
 * liquid Binance USDT pair, with trend-transition flags marking rotation
 * candidates (a laggard whose daily structure just confirmed up is a very
 * different read from one still trending down). Discovery-plane: a ranking,
 * never a verdict; rows link into the token page where the assistant lives.
 */

function formatTurnover(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${Math.round(value / 1e6)}M`;
  return `$${Math.round(value / 1e3)}K`;
}

const TREND_SHORT: Record<string, string> = {
  uptrend: "up",
  downtrend: "down",
  range: "range",
};

function TransitionBadge({ flag }: { flag: RsTransitionFlag }) {
  const { t } = useTranslation();
  const confirmed = flag.phase === "confirmed";
  const bullish = flag.to === "uptrend";
  const n = "components.batchC.rsScan.";
  return (
    <Badge
      variant="outline"
      title={t(`${n}transitionTooltip`, {
        from: flag.from,
        to: flag.to,
        status: confirmed ? t(`${n}confirmed`) : t(`${n}chochHint`),
        days: flag.barsAgo,
      })}
      className={cn(
        "px-1 py-0 text-[9px] font-semibold uppercase",
        confirmed
          ? bullish
            ? "border-bullish/30 bg-bullish-soft text-bullish"
            : "border-bearish/30 bg-bearish-soft text-bearish"
          : "border-warning/30 bg-warning-soft text-warning",
      )}
    >
      {confirmed ? `${TREND_SHORT[flag.from]}→${TREND_SHORT[flag.to]}` : `${TREND_SHORT[flag.to]}?`}{" "}
      {flag.barsAgo}d
    </Badge>
  );
}

function RsScanRow({ row, rank }: { row: RsRow; rank: number }) {
  const { t } = useTranslation();
  const n = "components.batchC.rsScan.";
  return (
    <li>
      <Link
        to="/token/$symbol"
        params={{ symbol: row.ticker }}
        className="group flex items-center gap-2.5 px-4 py-2.5 transition-colors hover:bg-surface/60"
      >
        <span className="num w-4 shrink-0 text-xs text-muted-foreground">{rank}</span>
        <AssetIcon ticker={row.ticker} className="h-6 w-6 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-semibold group-hover:text-info">{row.ticker}</span>
            {row.tracked && (
              <StatusBadge tone="info">{t(`${n}tracked`)}</StatusBadge>
            )}
            {row.transition && <TransitionBadge flag={row.transition} />}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {formatTurnover(row.quoteVolume24h)} {t(`${n}volumeSuffix24h`)}
            {row.rsBtc7d !== null && (
              <>
                {" · "}
                {t(`${n}vsBtc7d`)}{" "}
                <span className={row.rsBtc7d >= 0 ? "text-bullish" : "text-bearish"}>
                  {row.rsBtc7d >= 0 ? "+" : ""}
                  {row.rsBtc7d.toFixed(1)}%
                </span>
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <Change value={row.rsBtc24h} />
          <div className="num text-[10px] text-muted-foreground">P{row.rsPercentile24h}</div>
        </div>
      </Link>
    </li>
  );
}

/** Rows per column before the card collapses behind "show all". */
const COLLAPSED_ROWS = 6;

export function RsScanCard() {
  const { t } = useTranslation();
  const { data } = useRsScan();
  // Fifteen rows per side stacked into one column on a phone buries the page
  // — each column collapses to its strongest few until expanded.
  const [expanded, setExpanded] = useState(false);
  if (!data) return <SkeletonCard height={320} />;
  const n = "components.batchC.rsScan.";

  const column = (title: string, tone: string, rows: RsRow[]) => (
    <div className="min-w-0 flex-1">
      <div className={cn("px-4 pb-1 pt-3 text-[10px] font-semibold uppercase", tone)}>{title}</div>
      <ul className="divide-y divide-border/60">
        {(expanded ? rows : rows.slice(0, COLLAPSED_ROWS)).map((row, i) => (
          <RsScanRow key={row.ticker} row={row} rank={i + 1} />
        ))}
      </ul>
    </div>
  );

  const hiddenCount = expanded
    ? 0
    : Math.max(0, data.leaders.length - COLLAPSED_ROWS) +
      Math.max(0, data.laggards.length - COLLAPSED_ROWS);

  return (
    <IqCard padded={false}>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
        <CardEyebrow>{t(`${n}eyebrow`)}</CardEyebrow>
        <span className="text-[10px] text-muted-foreground">
          {t(`${n}pairsRanked`, { count: data.pairsRanked })}
          {data.source === "demo" && ` · ${t(`${n}demoData`)}`}
        </span>
      </div>
      <p className="px-4 pt-1 text-[11px] leading-relaxed text-muted-foreground">
        {t(`${n}description`)}
      </p>
      <div className="flex flex-col divide-y divide-border/60 sm:flex-row sm:divide-x sm:divide-y-0">
        {column(t(`${n}leaders`), "text-bullish", data.leaders)}
        {column(t(`${n}laggards`), "text-bearish", data.laggards)}
      </div>
      {(hiddenCount > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-border py-2 text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? t(`${n}showFewer`) : t(`${n}showAll`, { count: hiddenCount })}
        </button>
      )}
    </IqCard>
  );
}
