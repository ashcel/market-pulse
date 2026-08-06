import { Link } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";
import { ChevronRight, Clock, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetIcon } from "./asset-icon";
import { CardEyebrow, IqCard } from "./iq-card";
import { MiniChart } from "./mini-chart";
import { SkeletonCard } from "./skeletons";
import { useAssets } from "@/hooks/queries";
import { useAttention } from "@/hooks/useAttention";
import { useNow } from "@/hooks/useNow";
import { humanRelative } from "@/lib/time";
import { filterAttention, type AttentionItem, type AttentionKind } from "@/lib/engine/attention";
import { cn } from "@/lib/utils";
import type { SparkPoint } from "@/lib/types";

/**
 * "What's worth paying attention to today" — the dashboard's single ranked
 * feed across setups, spikes, liquidity, news and unlocks. Each card states
 * which plane it came from: engine setups are the only rows that carry a
 * direction, and the discovery/news rows are explicitly labelled as context.
 */

const FILTERS: { labelKey: string; value: AttentionKind | "all" }[] = [
  { labelKey: "all", value: "all" },
  { labelKey: "setups", value: "setup" },
  { labelKey: "spikeVol", value: "spike" },
  { labelKey: "liquidity", value: "liquidity" },
  { labelKey: "news", value: "news" },
  { labelKey: "unlocks", value: "unlock" },
];

const KIND_STYLE: Record<AttentionKind, { badge: string; accent: string; dot: string }> = {
  setup: {
    badge: "bg-bullish-soft text-bullish border-bullish/30",
    accent: "text-bullish",
    dot: "bg-bullish",
  },
  spike: {
    badge: "bg-warning-soft text-warning border-warning/30",
    accent: "text-warning",
    dot: "bg-warning",
  },
  liquidity: {
    badge: "bg-info-soft text-info border-info/30",
    accent: "text-info",
    dot: "bg-info",
  },
  news: {
    badge: "bg-muted text-muted-foreground border-border",
    accent: "text-foreground",
    dot: "bg-muted-foreground",
  },
  unlock: {
    badge: "bg-bearish-soft text-bearish border-bearish/30",
    accent: "text-bearish",
    dot: "bg-bearish",
  },
};

const PRIORITY_STYLE = {
  high: { dot: "bg-bullish", text: "text-bullish" },
  medium: { dot: "bg-warning", text: "text-warning" },
  low: { dot: "bg-muted-foreground", text: "text-muted-foreground" },
} as const;

export function AttentionFeed() {
  const { t } = useTranslation();
  const { items, isLoading } = useAttention();
  const { data: assets } = useAssets();
  const [filter, setFilter] = useState<AttentionKind | "all">("all");
  const scroller = useRef<HTMLDivElement>(null);
  // Minute ticker so every "in 4 hours" / "30 mins ago" stays current.
  const now = useNow();

  const sparkByTicker = useMemo(() => {
    const map = new Map<string, SparkPoint[]>();
    for (const a of assets ?? []) map.set(a.ticker, a.spark);
    return map;
  }, [assets]);

  const shown = useMemo(() => filterAttention(items, filter).slice(0, 12), [items, filter]);

  const counts = useMemo(() => {
    const map = new Map<AttentionKind | "all", number>([["all", items.length]]);
    for (const i of items) map.set(i.kind, (map.get(i.kind) ?? 0) + 1);
    return map;
  }, [items]);

  return (
    <IqCard padded={false} data-tour="attention" className="flex flex-col p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardEyebrow>{t("attention.title")}</CardEyebrow>
          <p className="mt-1 text-xs text-muted-foreground">{t("attention.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {FILTERS.map((f) => {
            const n = counts.get(f.value) ?? 0;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                disabled={n === 0 && f.value !== "all"}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                  filter === f.value
                    ? "bg-info text-background"
                    : "text-muted-foreground hover:bg-surface hover:text-foreground",
                  n === 0 && f.value !== "all" && "opacity-40 hover:bg-transparent",
                )}
              >
                {t(`attention.filters.${f.labelKey}`)}
              </button>
            );
          })}
        </div>
      </div>

      {isLoading ? (
        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <SkeletonCard key={i} height={260} />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border/60 bg-surface/30 p-8 text-center">
          <p className="text-sm font-medium text-foreground">{t("attention.emptyTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("attention.emptyBody")}</p>
        </div>
      ) : (
        <div className="relative mt-4">
          <div
            ref={scroller}
            className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 [scrollbar-width:thin]"
          >
            {shown.map((item) => (
              <AttentionCard
                key={item.id}
                item={item}
                now={now}
                spark={item.symbol ? sparkByTicker.get(item.symbol) : undefined}
              />
            ))}
          </div>
          {shown.length > 2 && (
            <button
              type="button"
              aria-label={t("attention.scrollForMore")}
              onClick={() => scroller.current?.scrollBy({ left: 320, behavior: "smooth" })}
              className="absolute -right-2 top-1/2 hidden h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors hover:text-foreground lg:flex"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      )}
    </IqCard>
  );
}

function AttentionCard({
  item,
  now,
  spark,
}: {
  item: AttentionItem;
  now: number;
  spark?: SparkPoint[];
}) {
  const { t } = useTranslation();
  const style = KIND_STYLE[item.kind];
  const priority = PRIORITY_STYLE[item.priority];
  const when = humanRelative(item.at, now);

  const body = (
    <div className="flex h-full w-[280px] shrink-0 snap-start flex-col gap-3 rounded-xl border border-border bg-surface/40 p-4 transition-colors hover:border-info/40">
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider",
            style.badge,
          )}
        >
          {item.kindLabel}
        </span>
        <span className={cn("flex items-center gap-1.5 text-[10px] font-medium", priority.text)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", priority.dot)} />
          {item.priority}
        </span>
      </div>

      <div className="min-w-0">
        <div className="flex items-center gap-2">
          {item.symbol && <AssetIcon ticker={item.symbol} className="h-5 w-5" />}
          <span className="truncate text-base font-semibold">
            {item.symbol ?? t("attention.market")}
            {item.symbol && <span className="text-muted-foreground"> / USDT</span>}
          </span>
        </div>
        <p className="mt-1 line-clamp-2 text-sm font-medium leading-snug text-foreground">
          {item.title}
        </p>
        <p className="mt-0.5 truncate text-[11px] capitalize text-muted-foreground">
          {item.subtitle}
        </p>
      </div>

      <div className="flex items-end justify-between gap-2">
        {item.score !== null ? (
          <div>
            <div className={cn("num text-2xl font-bold", style.accent)}>{item.score}%</div>
            <div className="text-[10px] text-muted-foreground">{item.scoreLabel}</div>
          </div>
        ) : (
          <div
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-semibold",
              item.upcoming ? "bg-warning-soft text-warning" : "bg-muted/40 text-muted-foreground",
            )}
          >
            <Clock className="h-3 w-3" />
            {when}
          </div>
        )}
        {spark && spark.length > 1 && (
          <div className="w-[110px]">
            <MiniChart
              data={spark}
              tone={item.kind === "unlock" ? "bearish" : "bullish"}
              height={40}
            />
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-1.5">
        {item.reasons.slice(0, 3).map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-[11px] leading-snug">
            <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", style.dot)} />
            <span className="line-clamp-2 text-muted-foreground">{r}</span>
          </li>
        ))}
      </ul>

      {item.stats.length > 0 && (
        <div className="mt-auto grid grid-cols-2 gap-2">
          {item.stats.map((s) => (
            <div key={s.label} className="rounded-lg border border-border/60 bg-background/40 p-2">
              <div className="text-[10px] text-muted-foreground">{s.label}</div>
              <div className="num truncate text-xs font-semibold capitalize">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border/60 pt-2 text-[10px] text-muted-foreground">
        <span>{when}</span>
        {item.url && <ExternalLink className="h-3 w-3" />}
      </div>
    </div>
  );

  if (item.symbolLink) {
    return (
      <Link to="/token/$symbol" params={{ symbol: item.symbolLink }} className="shrink-0">
        {body}
      </Link>
    );
  }
  if (item.url) {
    return (
      <a href={item.url} target="_blank" rel="noreferrer" className="shrink-0">
        {body}
      </a>
    );
  }
  return body;
}
