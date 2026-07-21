import { fundingKey, useLiveFundingStore } from "@/stores/live-funding";
import { klineKey, useLiveKlineStore } from "@/stores/live-klines";
import { useLivePriceStore } from "@/stores/live-prices";

import { BINANCE_INTERVALS, type MarketType } from "./binance";
import type { TokenTimeframe } from "./mock-candles";
import { resolveExchangeSymbol } from "./symbol-map";

/**
 * Binance-specific multiplexed live feed. Deliberately named for the
 * provider it actually talks to rather than "provider-agnostic" — the
 * combined-stream URL shape, the miniTicker/kline envelopes, and MarketType's
 * spot/perp split are all Binance vocabulary. A second exchange would need
 * its own module and a real adapter seam designed once it exists, not a
 * speculative one guessed at now.
 *
 * Carries two kinds of stream, multiplexed onto the same two sockets (one
 * per market):
 *  - "ticker" (miniTicker): last price + 24h change, written to live-prices.ts.
 *    Used app-wide (dashboard overlay, token header, tracker R-multiple).
 *  - "kline" (kline_<interval>): the actual forming-candle OHLCV Binance
 *    computes for one specific symbol+interval, written to live-klines.ts.
 *    Only ever wanted for whichever timeframe is currently open on the
 *    token page — miniTicker alone can't give a correct per-interval bar.
 *  - "markPrice" (markPrice, perp only): mark/index price + current funding
 *    rate + next funding time, updated ~every 3s by Binance. Written to
 *    live-funding.ts. Lets the token page show funding + a countdown that
 *    updates in real time instead of only on usePerpContext's 120s REST poll.
 *
 * Every consumer registers a single want under its own stable id via
 * registerLiveInterest/unregisterLiveInterest. Replacing or deleting a
 * caller's own entry is idempotent, so there's no refcount to drift under
 * React StrictMode's mount→cleanup→mount double-invoke. Reconciliation
 * closes and reopens the affected market's socket with the full desired
 * stream list embedded in the connect URL, since the whole registry only
 * changes at human-navigation pace (opening a token page, switching its
 * timeframe, following/removing a tracked signal, flipping the market
 * switch), not at tick pace. That trades a sub-second gap in ticks across a
 * reconnect for not needing the incremental SUBSCRIBE/UNSUBSCRIBE protocol,
 * request-id tracking, or an idle-teardown grace timer at all.
 */

const WS_BASE: Record<MarketType, string> = {
  spot: "wss://stream.binance.com:9443/stream",
  perp: "wss://fstream.binance.com/stream",
};

const MAX_RECONNECT_ATTEMPTS = 5;

export type LiveWant =
  | { kind: "ticker"; market: MarketType; ticker: string }
  | { kind: "kline"; market: MarketType; ticker: string; timeframe: TokenTimeframe }
  | { kind: "markPrice"; market: MarketType; ticker: string };

// callerId -> single want. The union of these values (per market) is the
// desired subscription set — recomputed from scratch on every registry
// change, never incremented/decremented.
const registry = new Map<string, LiveWant>();

type ResolvedWant =
  | { kind: "ticker"; ticker: string; priceScale: number }
  | { kind: "kline"; ticker: string; timeframe: TokenTimeframe; priceScale: number }
  | { kind: "markPrice"; ticker: string; priceScale: number };

interface MarketSocket {
  socket: WebSocket | null;
  streams: string[];
  /** Exact exchange stream name (e.g. "btcusdt@miniticker") -> resolved want. */
  streamToWant: Map<string, ResolvedWant>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function emptySocket(): MarketSocket {
  return {
    socket: null,
    streams: [],
    streamToWant: new Map(),
    reconnectAttempts: 0,
    reconnectTimer: null,
  };
}

const sockets: Record<MarketType, MarketSocket> = {
  spot: emptySocket(),
  perp: emptySocket(),
};

function streamNameFor(want: LiveWant): { stream: string; resolved: ResolvedWant } {
  const { symbol, priceScale } = resolveExchangeSymbol(want.ticker, want.market);
  const ticker = want.ticker.toUpperCase();
  if (want.kind === "ticker") {
    return {
      stream: `${symbol.toLowerCase()}@miniTicker`.toLowerCase(),
      resolved: { kind: "ticker", ticker, priceScale },
    };
  }
  if (want.kind === "markPrice") {
    return {
      stream: `${symbol.toLowerCase()}@markPrice`.toLowerCase(),
      resolved: { kind: "markPrice", ticker, priceScale },
    };
  }
  const interval = BINANCE_INTERVALS[want.timeframe];
  return {
    stream: `${symbol.toLowerCase()}@kline_${interval}`.toLowerCase(),
    resolved: { kind: "kline", ticker, timeframe: want.timeframe, priceScale },
  };
}

function wantedFor(market: MarketType): Map<string, ResolvedWant> {
  const map = new Map<string, ResolvedWant>();
  for (const want of registry.values()) {
    if (want.market !== market) continue;
    const { stream, resolved } = streamNameFor(want);
    map.set(stream, resolved);
  }
  return map;
}

function clearStaleStreams(
  market: MarketType,
  previous: Map<string, ResolvedWant>,
  next: Map<string, ResolvedWant>,
): void {
  for (const [stream, want] of previous) {
    if (next.has(stream)) continue;
    if (want.kind === "ticker") {
      useLivePriceStore.getState().clearTick(market, want.ticker);
    } else if (want.kind === "markPrice") {
      useLiveFundingStore.getState().clearFunding(market, want.ticker);
    } else {
      useLiveKlineStore.getState().clearKline(klineKey(market, want.ticker, want.timeframe));
    }
  }
}

function teardown(market: MarketType): void {
  const state = sockets[market];
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  state.socket?.close();
  state.socket = null;
  state.reconnectAttempts = 0;
}

function reconcile(market: MarketType): void {
  if (typeof WebSocket === "undefined") return;

  const streamToWant = wantedFor(market);
  const streams = [...streamToWant.keys()].sort();

  const state = sockets[market];
  const unchanged =
    streams.length === state.streams.length && streams.every((s, i) => s === state.streams[i]);
  if (unchanged) return;

  clearStaleStreams(market, state.streamToWant, streamToWant);

  teardown(market);
  state.streams = streams;
  state.streamToWant = streamToWant;
  if (streams.length === 0) return;
  connect(market);
}

interface TickerFrame {
  c?: string;
  o?: string;
}

interface KlineFrame {
  k?: { t?: number; o?: string; h?: string; l?: string; c?: string; v?: string; x?: boolean };
}

interface MarkPriceFrame {
  e?: string; // "markPriceUpdate"
  s?: string; // symbol
  p?: string; // mark price
  i?: string; // index price
  r?: string; // current funding rate
  T?: number; // next funding time, epoch ms
}

function connect(market: MarketType): void {
  const state = sockets[market];
  const url = `${WS_BASE[market]}?streams=${state.streams.join("/")}`;
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data as string) as {
        stream?: string;
        data?: TickerFrame & KlineFrame & MarkPriceFrame;
      };
      const streamName = payload.stream?.toLowerCase();
      const want = streamName ? state.streamToWant.get(streamName) : undefined;
      if (!want || !payload.data) return;

      if (want.kind === "ticker") {
        const price = Number(payload.data.c);
        const open = Number(payload.data.o);
        if (!Number.isFinite(price) || !Number.isFinite(open) || open === 0) return;
        useLivePriceStore.getState().setTick(market, want.ticker, {
          price: price / want.priceScale,
          change24h: Number((((price - open) / open) * 100).toFixed(2)),
          updatedAt: Date.now(),
        });
        return;
      }

      if (want.kind === "markPrice") {
        const markPrice = Number(payload.data.p);
        const indexPrice = Number(payload.data.i);
        const fundingRate = Number(payload.data.r);
        const nextFundingMs = Number(payload.data.T);
        if (![markPrice, indexPrice, fundingRate, nextFundingMs].every(Number.isFinite)) return;
        useLiveFundingStore.getState().setFunding(market, want.ticker, {
          markPrice: markPrice / want.priceScale,
          indexPrice: indexPrice / want.priceScale,
          fundingRate,
          nextFundingMs,
          updatedAt: Date.now(),
        });
        return;
      }

      const k = payload.data.k;
      if (!k) return;
      const open = Number(k.o);
      const high = Number(k.h);
      const low = Number(k.l);
      const close = Number(k.c);
      const volume = Number(k.v);
      const time = Math.floor(Number(k.t) / 1000);
      if (![open, high, low, close, volume, time].every(Number.isFinite)) return;
      useLiveKlineStore.getState().setKline(klineKey(market, want.ticker, want.timeframe), {
        time,
        open: open / want.priceScale,
        high: high / want.priceScale,
        low: low / want.priceScale,
        close: close / want.priceScale,
        volume: volume * want.priceScale,
        closed: k.x === true,
      });
    } catch {
      // Ignore malformed frames.
    }
  };

  socket.onclose = () => {
    if (state.socket !== socket) return; // superseded by a reconcile already
    if (state.streams.length === 0 || state.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    state.reconnectAttempts++;
    const delay = Math.min(30_000, 1_000 * 2 ** state.reconnectAttempts);
    // Reconnecting always re-reads state.streams/streamToWant live (not a
    // value captured when this timer was scheduled), so a want registered
    // mid-outage is never silently missed.
    state.reconnectTimer = setTimeout(() => connect(market), delay);
  };
  socket.onerror = () => socket.close();
}

/** Registers (or replaces) a single caller's live-feed interest. Idempotent. */
export function registerLiveInterest(callerId: string, want: LiveWant): void {
  if (typeof WebSocket === "undefined") return;
  const previous = registry.get(callerId);
  registry.set(callerId, want);
  if (previous && previous.market !== want.market) reconcile(previous.market);
  reconcile(want.market);
}

/** Removes a caller's interest. Safe to call even if never registered. */
export function unregisterLiveInterest(callerId: string): void {
  const previous = registry.get(callerId);
  if (!previous) return;
  registry.delete(callerId);
  reconcile(previous.market);
}
