import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import type { HolderBubble, HolderMapRead } from "@/hooks/useListings";
import { cn } from "@/lib/utils";

/**
 * Top-holder bubble map.
 *
 * Area encodes share of supply, and the layout arrives pre-computed from the
 * backend (`smc.holder_map`) so the picture is identical on every client and
 * every render — no physics simulation, nothing that drifts between reloads.
 *
 * The colouring carries the one distinction that matters for reading risk: a
 * liquidity pool or burn address holding 40% is *not* a whale, so those are
 * rendered muted and struck out of the concentration numbers, while ordinary
 * wallets carry the accent. Anything unlabelled but contract-shaped stays
 * counted — an unknown contract holding 30% is exactly the risk this shows.
 */

const KIND_FILL: Record<HolderBubble["kind"], string> = {
  wallet: "fill-[var(--chart-1)]",
  contract: "fill-[var(--chart-4)]",
  team: "fill-[var(--warning)]",
  exchange: "fill-[var(--chart-3)]",
  pool: "fill-muted-foreground/25",
  burn: "fill-muted-foreground/15",
};

const KIND_STROKE: Record<HolderBubble["kind"], string> = {
  wallet: "stroke-[var(--chart-1)]",
  contract: "stroke-[var(--chart-4)]",
  team: "stroke-[var(--warning)]",
  exchange: "stroke-[var(--chart-3)]",
  pool: "stroke-muted-foreground/40",
  burn: "stroke-muted-foreground/30",
};

function shortAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function ConcentrationStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bearish" | "warning" | "default";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          "num text-sm font-semibold",
          tone === "bearish" && "text-bearish",
          tone === "warning" && "text-warning",
        )}
      >
        {value}
      </span>
    </div>
  );
}

export function HolderBubbleMap({
  map,
  symbol,
  className,
}: {
  map: HolderMapRead | null;
  symbol: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<HolderBubble | null>(null);

  const bubbles = useMemo(
    // Draw largest first so small bubbles land on top and stay clickable.
    () => [...(map?.bubbles ?? [])].sort((a, b) => b.r - a.r),
    [map],
  );

  if (!map || map.unavailableReason || bubbles.length === 0) {
    const reason = map?.unavailableReason ?? "no_holder_rows";
    return (
      <IqCard className={className}>
        <CardEyebrow>{t("listings.holders.title")}</CardEyebrow>
        <p className="mt-3 text-sm text-muted-foreground">
          {t(`listings.holders.unavailable.${reason}`, {
            defaultValue: t("listings.holders.unavailable.generic"),
          })}
        </p>
      </IqCard>
    );
  }

  const top10 = map.top10Pct;
  const largest = map.largestHolderPct;

  return (
    <IqCard className={className}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardEyebrow>{t("listings.holders.title")}</CardEyebrow>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("listings.holders.subtitle", { symbol })}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <ConcentrationStat
          label={t("listings.holders.top10")}
          value={top10 != null ? `${(top10 * 100).toFixed(1)}%` : "—"}
          tone={
            top10 != null && top10 > 0.6
              ? "bearish"
              : top10 != null && top10 > 0.4
                ? "warning"
                : "default"
          }
        />
        <ConcentrationStat
          label={t("listings.holders.largest")}
          value={largest != null ? `${(largest * 100).toFixed(1)}%` : "—"}
          tone={largest != null && largest > 0.3 ? "bearish" : "default"}
        />
        <ConcentrationStat
          label={t("listings.holders.pooled")}
          value={`${(map.poolPct * 100).toFixed(1)}%`}
        />
        <ConcentrationStat
          label={t("listings.holders.burned")}
          value={`${(map.burnPct * 100).toFixed(1)}%`}
        />
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-surface">
        <svg
          viewBox="-1.08 -1.08 2.16 2.16"
          className="h-auto w-full"
          role="img"
          aria-label={t("listings.holders.mapAria", {
            symbol,
            count: bubbles.length,
            top10: top10 != null ? Math.round(top10 * 100) : 0,
          })}
        >
          {bubbles.map((bubble) => {
            const selected = active?.address === bubble.address;
            return (
              <g key={bubble.address}>
                <circle
                  cx={bubble.x}
                  cy={bubble.y}
                  r={bubble.r}
                  className={cn(
                    KIND_FILL[bubble.kind],
                    KIND_STROKE[bubble.kind],
                    "cursor-pointer transition-opacity",
                    selected ? "opacity-100" : "opacity-80 hover:opacity-100",
                  )}
                  strokeWidth={selected ? 0.012 : 0.006}
                  tabIndex={0}
                  onMouseEnter={() => setActive(bubble)}
                  onFocus={() => setActive(bubble)}
                  onMouseLeave={() => setActive(null)}
                  onBlur={() => setActive(null)}
                >
                  <title>{`${bubble.label} — ${(bubble.pct * 100).toFixed(2)}%`}</title>
                </circle>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Reserve the row so hovering a bubble never reflows the card. */}
      <div className="mt-2 min-h-[2.25rem]">
        {active ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="num text-sm font-semibold">{(active.pct * 100).toFixed(2)}%</span>
            <span className="truncate text-xs text-foreground">{active.label}</span>
            <span className="num text-[10px] text-muted-foreground">
              {shortAddress(active.address)}
            </span>
            {!active.counted && (
              <span className="text-[10px] italic text-muted-foreground">
                {t("listings.holders.notCounted")}
              </span>
            )}
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">{t("listings.holders.hint")}</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2">
        {(["wallet", "contract", "team", "exchange", "pool", "burn"] as const).map((kind) => (
          <span key={kind} className="flex items-center gap-1 text-[10px] text-muted-foreground">
            <svg viewBox="0 0 8 8" className="h-2 w-2" aria-hidden="true">
              <circle cx="4" cy="4" r="4" className={KIND_FILL[kind]} />
            </svg>
            {t(`listings.holders.kind.${kind}`)}
          </span>
        ))}
      </div>
    </IqCard>
  );
}
