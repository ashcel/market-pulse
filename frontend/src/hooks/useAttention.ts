import { useMemo } from "react";

import {
  calendarItems,
  liquidityItems,
  newsItems,
  rankAttention,
  setupItems,
  spikeItems,
  tokenEventItems,
  type AttentionItem,
} from "@/lib/engine/attention";
import { useAssets, useEconomicEvents, useNews, useOpportunityScan } from "@/hooks/queries";
import { useActionableSetups } from "@/hooks/useActionableSetups";
import { useTokenEventsForSymbols } from "@/hooks/useTokenEvents";
import { useWatchlistStore } from "@/stores/watchlist";

/** Cards per source before ranking — the feed is a shortlist, not a firehose. */
const PER_SOURCE = { spikes: 4, liquidity: 4, news: 5, calendar: 3, events: 4 } as const;

/**
 * The unified "what's worth paying attention to today" feed. Every source is
 * an existing query — this hook only normalises and ranks. It never blocks on
 * the slowest source: whatever has resolved is shown, and `isLoading` is true
 * only while nothing at all has arrived.
 */
export function useAttention(): { items: AttentionItem[]; isLoading: boolean } {
  const setups = useActionableSetups();
  const assets = useAssets();
  const scan = useOpportunityScan();
  const news = useNews();
  const calendar = useEconomicEvents(3, "high");
  const watched = useWatchlistStore((s) => s.tickers);
  const tokenEvents = useTokenEventsForSymbols(watched);

  const priceByTicker = useMemo(() => {
    const map = new Map<string, number>();
    for (const a of assets.data ?? []) map.set(a.ticker, a.price);
    return map;
  }, [assets.data]);

  const items = useMemo(() => {
    const now = Date.now();
    const out: AttentionItem[] = [];

    if (setups.data) {
      out.push(
        ...setupItems(
          setups.data.map((s) => ({
            ticker: s.ticker,
            assessment: s.assessment,
            price: priceByTicker.get(s.ticker) ?? s.assessment.plan?.entry ?? 0,
          })),
          now,
        ),
      );
    }
    if (scan.data) {
      out.push(...spikeItems(scan.data.spikes.slice(0, PER_SOURCE.spikes), now));
      out.push(...liquidityItems(scan.data.opportunities.slice(0, PER_SOURCE.liquidity), now));
    }
    if (news.data) {
      out.push(
        ...newsItems(news.data.filter((n) => n.impact !== "low").slice(0, PER_SOURCE.news), now),
      );
    }
    if (calendar.data) out.push(...calendarItems(calendar.data.slice(0, PER_SOURCE.calendar)));
    if (tokenEvents.data) {
      out.push(...tokenEventItems(tokenEvents.data.slice(0, PER_SOURCE.events), now));
    }

    return rankAttention(out, now);
  }, [setups.data, scan.data, news.data, calendar.data, tokenEvents.data, priceByTicker]);

  const anyResolved =
    !!setups.data || !!scan.data || !!news.data || !!calendar.data || !!tokenEvents.data;

  return { items, isLoading: !anyResolved };
}
