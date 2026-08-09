import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { AssetIcon } from "@/components/features/asset-icon";
import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { SkeletonCard } from "@/components/features/skeletons";
import { StatusBadge } from "@/components/features/status-badge";
import { useRallyWatcher, type RallyRead, type RallyTarget } from "@/hooks/useRallyWatcher";
import { humanRelative } from "@/lib/time";
import { cn } from "@/lib/utils";

const N = "components.rallyWatcher.";

function formatPrice(price: number): string {
  if (price >= 1000) return price.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(2);
  return price.toPrecision(4);
}

function TargetChip({
  labelKey,
  target,
  expanded,
  onToggle,
}: {
  labelKey: string;
  target: RallyTarget;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const sign = target.distance_pct >= 0 ? "+" : "";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        "rounded-md border px-1.5 py-0.5 text-[10px] font-medium transition-colors",
        expanded
          ? "border-info bg-info-soft text-info"
          : "border-border bg-muted/30 text-muted-foreground",
      )}
    >
      {t(`${N}targets.${labelKey}`)} {formatPrice(target.price)}{" "}
      <span className="num">
        {sign}
        {target.distance_pct.toFixed(1)}%
      </span>
    </button>
  );
}

function RallyRow({ rally }: { rally: RallyRead }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);

  const chips: Array<{ key: string; labelKey: string; target: RallyTarget }> = [
    ...(rally.targets.smcPool
      ? [{ key: "smcPool", labelKey: "smcPool", target: rally.targets.smcPool }]
      : []),
    ...(rally.targets.resistance
      ? [{ key: "resistance", labelKey: "resistance", target: rally.targets.resistance }]
      : []),
    ...(rally.targets.liquidation
      ? [{ key: "liquidation", labelKey: "liquidation", target: rally.targets.liquidation }]
      : []),
  ];
  const expandedDetail = chips.find((c) => c.key === expanded)?.target.detail;

  return (
    <li className="px-4 py-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <Link
          to="/token/$symbol"
          params={{ symbol: rally.symbol }}
          className="group flex min-w-0 items-center gap-2"
        >
          <AssetIcon ticker={rally.symbol} className="h-6 w-6 shrink-0" />
          <span className="truncate text-sm font-semibold group-hover:text-info">
            {rally.symbol}
          </span>
        </Link>
        {rally.extended && (
          <StatusBadge tone="warning" className="shrink-0">
            {t(`${N}extended`)}
          </StatusBadge>
        )}
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="num text-base font-bold text-bullish">+{rally.gainPct.toFixed(1)}%</span>
        <span className="text-[10px] text-muted-foreground">
          <span className="num">{rally.volumeMult.toFixed(1)}×</span> {t(`${N}volume`)}
        </span>
        <span className="text-[10px] text-muted-foreground">
          · {humanRelative(rally.evaluatedAt * 1000)}
        </span>
      </div>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {chips.map((chip) => (
          <TargetChip
            key={chip.key}
            labelKey={chip.labelKey}
            target={chip.target}
            expanded={expanded === chip.key}
            onToggle={() => setExpanded((cur) => (cur === chip.key ? null : chip.key))}
          />
        ))}
      </div>

      {expandedDetail && (
        <p className="mb-2 text-[10px] leading-relaxed text-muted-foreground">{expandedDetail}</p>
      )}

      <p className="text-[11px] leading-relaxed text-foreground">{rally.explanation}</p>

      {rally.extended && (
        <p className="mt-1 text-[10px] italic text-warning">{t(`${N}extendedNote`)}</p>
      )}
      {!rally.oiAvailable && (
        <p className="mt-1 text-[10px] italic text-muted-foreground">{t(`${N}oiUnavailable`)}</p>
      )}
    </li>
  );
}

/**
 * RALLY WATCHER — live "what's rallying right now" scan (last ~15 minutes,
 * confirming volume) over the dynamic perp universe. Answers "where is the
 * move heading and what's above/below" with three targets: the nearest SMC
 * buy-side-liquidity pool, technical resistance, and an ESTIMATED
 * average-leverage short-liquidation cluster. Live watch, no persistence, no
 * win-rate claim — mounted before the REACCUMULATION scan card as the
 * "what's moving right now" view.
 */
export function RallyWatcherCard() {
  const { t } = useTranslation();
  const { data, isFetching, refetch } = useRallyWatcher();

  if (!data) return <SkeletonCard height={280} />;

  return (
    <IqCard padded={false}>
      <div className="flex items-center justify-between p-4 pb-3 sm:p-5 sm:pb-3">
        <div className="flex items-center gap-2">
          <CardEyebrow>{t(`${N}title`)}</CardEyebrow>
          <span className="text-[10px] text-muted-foreground">{t(`${N}subtitle`)}</span>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {t(`${N}refresh`)}
        </button>
      </div>
      <p className="px-4 pb-3 text-[11px] leading-relaxed text-muted-foreground sm:px-5">
        {t(`${N}description`)}
      </p>

      {data.rallies.length === 0 && data.scanning ? (
        <div className="border-t border-border px-4 py-4 sm:px-5">
          <p className="text-sm text-muted-foreground">{t(`${N}scanning`)}</p>
        </div>
      ) : data.rallies.length === 0 ? (
        <div className="border-t border-border px-4 py-4 sm:px-5">
          <p className="text-sm text-muted-foreground">{t(`${N}emptyState`)}</p>
          <p className="mt-1 text-[10px] italic text-muted-foreground">{t(`${N}emptyStateNote`)}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {data.rallies.map((rally) => (
            <RallyRow key={rally.symbol} rally={rally} />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between border-t border-border px-4 py-2 sm:px-5">
        <span className="text-[10px] italic text-muted-foreground">{t(`${N}footer`)}</span>
        <span className="text-[10px] text-muted-foreground">
          {t(`${N}updated`, { time: humanRelative(data.updatedAt) })}
        </span>
      </div>
    </IqCard>
  );
}
