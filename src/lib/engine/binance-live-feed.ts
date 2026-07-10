import { useLivePriceStore } from "@/stores/live-prices";

import type { MarketType } from "./binance";
import { resolveExchangeSymbol } from "./symbol-map";

/**
 * Binance-specific multiplexed live-price feed. Deliberately named for the
 * provider it actually talks to rather than "provider-agnostic" — the
 * combined-stream URL shape, the miniTicker envelope, and MarketType's
 * spot/perp split are all Binance vocabulary. A second exchange would need
 * its own module and a real adapter seam designed once it exists, not a
 * speculative one guessed at now.
 *
 * Every consumer (useLivePrice, the universe-wide dashboard subscription)
 * registers a single ticker+market "want" under its own stable id via
 * registerLiveInterest/unregisterLiveInterest. Replacing or deleting a
 * caller's own entry is idempotent, so there's no refcount to drift under
 * React StrictMode's mount→cleanup→mount double-invoke. Two sockets total
 * exist at any time (one per market) — reconciled by closing and reopening
 * with the full desired stream list embedded in the connect URL, since the
 * whole registry only changes at human-navigation pace (opening a token
 * page, following/removing a tracked signal, flipping the market switch),
 * not at tick pace. That trades a sub-second gap in ticks across a
 * reconnect for not needing the incremental SUBSCRIBE/UNSUBSCRIBE protocol,
 * request-id tracking, or an idle-teardown grace timer at all.
 */

const WS_BASE: Record<MarketType, string> = {
  spot: "wss://stream.binance.com:9443/stream",
  perp: "wss://fstream.binance.com/stream",
};

const MAX_RECONNECT_ATTEMPTS = 5;

interface Want {
  market: MarketType;
  ticker: string;
}

// callerId -> single want. The union of these values (per market) is the
// desired subscription set — recomputed from scratch on every registry
// change, never incremented/decremented.
const registry = new Map<string, Want>();

interface MarketSocket {
  socket: WebSocket | null;
  streams: string[];
  /** Exchange symbol (upper) -> internal ticker/scale, matching `streams`. */
  symbolToTicker: Map<string, { ticker: string; priceScale: number }>;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function emptySocket(): MarketSocket {
  return {
    socket: null,
    streams: [],
    symbolToTicker: new Map(),
    reconnectAttempts: 0,
    reconnectTimer: null,
  };
}

const sockets: Record<MarketType, MarketSocket> = {
  spot: emptySocket(),
  perp: emptySocket(),
};

function wantedFor(market: MarketType): Map<string, { ticker: string; priceScale: number }> {
  const map = new Map<string, { ticker: string; priceScale: number }>();
  for (const want of registry.values()) {
    if (want.market !== market) continue;
    const { symbol, priceScale } = resolveExchangeSymbol(want.ticker, market);
    map.set(symbol.toUpperCase(), { ticker: want.ticker.toUpperCase(), priceScale });
  }
  return map;
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

  const symbolToTicker = wantedFor(market);
  const streams = [...symbolToTicker.keys()].map((s) => `${s.toLowerCase()}@miniTicker`).sort();

  const state = sockets[market];
  const unchanged =
    streams.length === state.streams.length && streams.every((s, i) => s === state.streams[i]);
  if (unchanged) return;

  // Prior subscribers' ticks go stale the moment they're no longer wanted.
  for (const { ticker } of state.symbolToTicker.values()) {
    if (![...symbolToTicker.values()].some((w) => w.ticker === ticker)) {
      useLivePriceStore.getState().clearTick(market, ticker);
    }
  }

  teardown(market);
  state.streams = streams;
  state.symbolToTicker = symbolToTicker;
  if (streams.length === 0) return;
  connect(market);
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
        data?: { c?: string; o?: string };
      };
      const exchangeSymbol = payload.stream?.split("@")[0]?.toUpperCase();
      const mapped = exchangeSymbol ? state.symbolToTicker.get(exchangeSymbol) : undefined;
      if (!mapped) return;

      const price = Number(payload.data?.c);
      const open = Number(payload.data?.o);
      if (!Number.isFinite(price) || !Number.isFinite(open) || open === 0) return;

      useLivePriceStore.getState().setTick(market, mapped.ticker, {
        price: price / mapped.priceScale,
        change24h: Number((((price - open) / open) * 100).toFixed(2)),
        updatedAt: Date.now(),
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
    // Reconnecting always re-reads state.streams/symbolToTicker live (not a
    // value captured when this timer was scheduled), so a want registered
    // mid-outage is never silently missed.
    state.reconnectTimer = setTimeout(() => connect(market), delay);
  };
  socket.onerror = () => socket.close();
}

/** Registers (or replaces) a single caller's live-price interest. Idempotent. */
export function registerLiveInterest(callerId: string, want: Want): void {
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
