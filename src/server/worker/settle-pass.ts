import { settleAnticipatorySignal } from "@/lib/engine/anticipatory";
import { dropUnclosedCandle, fetchBinanceKlinesDirect } from "@/lib/engine/binance";
import { STEP_SECONDS } from "@/lib/engine/mock-candles";
import { settleShadowSignal } from "@/lib/engine/shadow";
import { settleTrackedSignalWithCandles } from "@/lib/engine/tracker";
import {
  listOpenAnticipatory,
  listOpenShadow,
  listOpenTracked,
  patchAnticipatory,
  patchShadow,
  patchTracked,
} from "../db/repo";
import type { AnticipatorySignal } from "@/lib/engine/anticipatory";
import type { MarketType } from "@/lib/engine/binance";
import type { TokenTimeframe } from "@/lib/engine/mock-candles";
import type { ShadowSignal } from "@/lib/engine/shadow";
import type { TrackedSignal } from "@/lib/engine/tracker";

interface Group {
  symbol: string;
  timeframe: TokenTimeframe;
  market: MarketType;
  earliestSec: number;
  shadow: ShadowSignal[];
  anticipatory: AnticipatorySignal[];
  tracked: TrackedSignal[];
}

function key(symbol: string, tf: TokenTimeframe, market: MarketType): string {
  return `${symbol}:${tf}:${market}`;
}

/**
 * One settlement pass over every open record (Phase C). The exact kline-walk
 * catch-up `useSignalSettlement` did client-side — same pure settlement
 * functions — but run in the worker so records settle whether or not a browser
 * is open. Walking real intrabar highs/lows since each record opened also makes
 * worker restarts self-healing.
 */
export async function runSettlePass(): Promise<{ settled: number }> {
  const [shadow, anticipatory, tracked] = await Promise.all([
    listOpenShadow(),
    listOpenAnticipatory(),
    listOpenTracked(),
  ]);

  const groups = new Map<string, Group>();
  const add = (
    symbol: string,
    tf: TokenTimeframe,
    market: MarketType,
    openedAt: string,
    assign: (g: Group) => void,
  ) => {
    const sec = Date.parse(openedAt) / 1000;
    if (!Number.isFinite(sec)) return;
    const k = key(symbol, tf, market);
    const g =
      groups.get(k) ??
      ({
        symbol,
        timeframe: tf,
        market,
        earliestSec: sec,
        shadow: [],
        anticipatory: [],
        tracked: [],
      } as Group);
    g.earliestSec = Math.min(g.earliestSec, sec);
    assign(g);
    groups.set(k, g);
  };

  for (const s of shadow) add(s.symbol, s.timeframe, s.market, s.openedAt, (g) => g.shadow.push(s));
  for (const s of anticipatory)
    add(s.symbol, s.timeframe, s.market, s.openedAt, (g) => g.anticipatory.push(s));
  for (const s of tracked)
    add(s.symbol, s.timeframe, s.market ?? "spot", s.followedAt, (g) => g.tracked.push(s));

  let settled = 0;
  for (const g of groups.values()) {
    const step = STEP_SECONDS[g.timeframe];
    const elapsedBars = Math.ceil((Date.now() / 1000 - g.earliestSec) / step) + 3;
    const limit = Math.min(1000, Math.max(10, elapsedBars));
    const candles = dropUnclosedCandle(
      await fetchBinanceKlinesDirect({
        symbol: g.symbol,
        timeframe: g.timeframe,
        limit,
        market: g.market,
      }),
    );
    if (candles.length === 0) continue;

    for (const signal of g.shadow) {
      const patch = settleShadowSignal(signal, candles);
      if (patch) {
        await patchShadow(signal.id, patch);
        settled += 1;
      }
    }
    for (const signal of g.anticipatory) {
      const patch = settleAnticipatorySignal(signal, candles);
      if (patch) {
        await patchAnticipatory(signal.id, patch);
        settled += 1;
      }
    }
    for (const signal of g.tracked) {
      const patch = settleTrackedSignalWithCandles(signal, candles);
      if (patch) {
        await patchTracked(signal.id, patch);
        settled += 1;
      }
    }
  }

  return { settled };
}
