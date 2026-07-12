import { fetchMarketSnapshot } from "./market";

export type NotificationType =
  "bias-summary" | "setup-found" | "trigger-hit" | "worker-health" | "follow-settled";

export interface NotificationEvent {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  ticker?: string;
  createdAt: string;
  /** When set, the event is private: only streams to this user's sessions. */
  ownerId?: string;
}

const POLL_MS = 60_000;
const RECENT_LIMIT = 30;
const HIGH_QUALITY_CONFIDENCE = 75;
/** Minimum backtest win rate for notification, when reliable data exists.
 *  Prevents notifying on 100% technical-alignment setups that historically
 *  lose (e.g. ADA short at 5% win rate). Low-sample results are excluded. */
const HIGH_QUALITY_WIN_RATE = 30;
// Caps how often the *same ticker* can re-alert, independent of how often a
// decision flips. Without this, a setup wobbling near the confidence/decision
// boundary during a volatile tape re-fires on every poll.
const RENOTIFY_COOLDOWN_MS = 15 * 60_000;

interface Subscriber {
  send: (event: NotificationEvent) => void;
  /** Authenticated user behind this stream, if any — gates owner-scoped events. */
  userId?: string;
}

const subscribers = new Set<Subscriber>();
const recentEvents: NotificationEvent[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastBiasDate: string | null = null;
let lastRegimeLabel: string | null = null;
const lastNotified = new Map<string, { decision: string; at: number }>();

function visibleTo(event: NotificationEvent, userId?: string): boolean {
  return event.ownerId === undefined || event.ownerId === userId;
}

function emit(event: NotificationEvent) {
  recentEvents.unshift(event);
  recentEvents.length = Math.min(recentEvents.length, RECENT_LIMIT);
  for (const sub of subscribers) {
    if (visibleTo(event, sub.userId)) sub.send(event);
  }
}

/**
 * Lets server-side watchers (e.g. the forward-test health watch) push events
 * into the same SSE stream + replay buffer the market poller uses. Events
 * emitted while nobody is connected are buffered and replayed on the next
 * connect, so a transition is never silently dropped.
 */
export function publishNotification(event: NotificationEvent): void {
  emit(event);
}

function titleCase(slug: string): string {
  return slug.replaceAll("-", " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function evaluate() {
  const snapshot = await fetchMarketSnapshot();
  const today = new Date().toISOString().slice(0, 10);
  const regimeLabel = snapshot.regime.regime;

  if (today !== lastBiasDate || regimeLabel !== lastRegimeLabel) {
    const isNewDay = today !== lastBiasDate;
    lastBiasDate = today;
    lastRegimeLabel = regimeLabel;
    emit({
      id: `bias-${today}-${Date.now()}`,
      type: "bias-summary",
      title: isNewDay ? `Today's bias: ${regimeLabel}` : `Regime shifted to ${regimeLabel}`,
      body: `Rotation favors ${snapshot.rotation.winning} over ${snapshot.rotation.losing}. Sentiment is ${snapshot.sentiment.label.toLowerCase()} (${snapshot.sentiment.fearGreed}/100).`,
      createdAt: new Date().toISOString(),
    });
  }

  const now = Date.now();
  for (const asset of snapshot.assets) {
    const decision = asset.decision;
    if (decision !== "buy-candidate" && decision !== "short-candidate") continue;
    const signals = snapshot.assetSignals[asset.ticker];
    const confidence = signals?.confidence ?? asset.confidence ?? 0;
    if (confidence < HIGH_QUALITY_CONFIDENCE) continue;

    // Gate on backtest win rate: if the engine has reliable historical data
    // for this setup and it shows a sub-30% win rate, suppress the notification
    // — strong technical alignment doesn't mean the trade works historically.
    const bt = signals?.backtest;
    if (bt && !bt.lowSample && bt.winRate < HIGH_QUALITY_WIN_RATE) continue;

    // Same decision as last time we alerted on this ticker: never re-fire,
    // no matter how many polls it spent below the confidence bar in between.
    const prior = lastNotified.get(asset.ticker);
    if (prior?.decision === decision) continue;
    // A genuinely new decision still can't re-alert more than once per
    // cooldown window, so a wobble near a threshold can't spam either.
    if (prior && now - prior.at < RENOTIFY_COOLDOWN_MS) continue;

    lastNotified.set(asset.ticker, { decision, at: now });

    // Body: describe the signal qualitatively, not as a percentage that reads
    // like a probability of success. Include win rate when available so the
    // user sees the full picture before opening the page.
    const dir = decision === "short-candidate" ? "Bearish" : "Bullish";
    const setupLabel = titleCase(asset.setupType ?? "setup");
    const winRateNote =
      bt && bt.winRate >= 0
        ? ` — historically ${bt.lowSample ? "~" : ""}${bt.winRate}% win rate`
        : "";
    emit({
      id: `setup-${asset.ticker}-${decision}-${now}`,
      type: "setup-found",
      title: `${asset.ticker}: ${dir} signal`,
      body: `${setupLabel} on ${asset.ticker}. Strong technical alignment.${winRateNote}`,
      ticker: asset.ticker,
      createdAt: new Date().toISOString(),
    });
  }
}

function ensurePolling() {
  if (pollTimer) return;
  evaluate().catch((error) => console.error("notification evaluate failed", error));
  pollTimer = setInterval(() => {
    evaluate().catch((error) => console.error("notification evaluate failed", error));
  }, POLL_MS);
}

function stopPollingIfIdle() {
  if (subscribers.size === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Subscribes to live notifications; replays recent buffered events
 * immediately. Owner-scoped events (`ownerId` set) are only delivered —
 * live or replayed — to streams authenticated as that user. Returns an
 * unsubscribe fn.
 */
export function subscribeToNotifications(
  send: (event: NotificationEvent) => void,
  userId?: string,
): () => void {
  const sub: Subscriber = { send, userId };
  subscribers.add(sub);
  ensurePolling();
  for (const event of [...recentEvents].reverse()) {
    if (visibleTo(event, userId)) send(event);
  }
  return () => {
    subscribers.delete(sub);
    stopPollingIfIdle();
  };
}
