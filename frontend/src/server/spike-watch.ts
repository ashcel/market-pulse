import { publishNotification } from "@/lib/engine/notifications";
import { refreshSpikes, type SpikeHit } from "@/lib/engine/discovery";

/**
 * Market-wide spike alerts. On a timer this web-process watcher refreshes the
 * discovery spike scan (vertical spike + abnormal volume + immediate rejection
 * across the whole liquidity tier) and pushes a notification for each pair that
 * just printed one. The same refresh call feeds the discovery UI's cache, so
 * the two never double-fetch klines.
 *
 * Unlike token-events these are global, not owner-scoped — a spike-and-reject
 * on any liquid pair is a "look now" discovery signal, the whole point being to
 * not miss action on pairs you aren't already tracking. Noise is held down by
 * the detector's own gates plus a per-ticker cooldown here. Strictly a
 * discovery signal: it touches no engine semantics and writes no record.
 */
const CHECK_MS = 2 * 60_000;
// A pair can re-alert at most once per window, even across distinct spike bars,
// so a chop zone printing rejection after rejection can't spam the channel.
const RENOTIFY_COOLDOWN_MS = 15 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
const lastAlerted = new Map<string, { spikeTime: number; at: number }>();

function describe(hit: SpikeHit): { title: string; body: string } {
  const dir = hit.spike.direction === "up" ? "Up" : "Down";
  return {
    title: `${hit.ticker}: Don't chase — ${dir.toLowerCase()}-spike fading`,
    body: `${hit.spike.reason} — a ${hit.spike.rangePct.toFixed(1)}% 15m bar. Don't chase this move — post-spike cooldown active.`,

  };
}

async function check(): Promise<void> {
  const hits = await refreshSpikes();
  const now = Date.now();
  for (const hit of hits) {
    const prior = lastAlerted.get(hit.ticker);
    // Already alerted this exact spike bar, or still inside the cooldown from
    // the last alert on this ticker: skip.
    if (prior && (prior.spikeTime === hit.spike.time || now - prior.at < RENOTIFY_COOLDOWN_MS)) {
      continue;
    }
    lastAlerted.set(hit.ticker, { spikeTime: hit.spike.time, at: now });
    const { title, body } = describe(hit);
    publishNotification({
      id: `spike-${hit.ticker}-${hit.spike.time}`,
      type: "spike-alert",
      title,
      body,
      ticker: hit.ticker,
      createdAt: new Date().toISOString(),
    });
  }
}

/** Idempotent: first caller starts the loop, later calls are no-ops. */
export function ensureSpikeWatch(): void {
  if (timer) return;
  check().catch((error) => console.error("spike watch failed", error));
  timer = setInterval(() => {
    check().catch((error) => console.error("spike watch failed", error));
  }, CHECK_MS);
}
