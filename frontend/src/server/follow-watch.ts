import { publishNotification } from "@/lib/engine/notifications";
import { INTENTS } from "@/lib/engine/intent";
import { listSettledTrackedSince } from "./db/repo";
import type { TrackedSignal } from "@/lib/engine/tracker";

/**
 * P1.2 — settlement notifications for follows. The worker settles
 * `tracked_signal` rows in its own process, so the web process (which owns
 * the SSE stream) polls the record for fresh settlements and pushes each one
 * as an owner-scoped notification — only the user who followed the call sees
 * it. Starts at boot time ("now"), deliberately not replaying settlements
 * that happened while the web service was down: the tracker page shows the
 * authoritative list anyway.
 */
const CHECK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSeenIso = new Date().toISOString();

const INTENT_LABEL = new Map(INTENTS.map((def) => [def.intent, def.label]));

const STATUS_HEADLINE: Record<string, string> = {
  "target1-hit": "hit target 1",
  "target2-hit": "hit target 2",
  "stopped-out": "stopped out",
};

function describe(signal: TrackedSignal): { title: string; body: string } {
  const outcome = STATUS_HEADLINE[signal.status] ?? signal.status;
  const r =
    signal.resultR !== undefined ? ` (${signal.resultR >= 0 ? "+" : ""}${signal.resultR}R)` : "";
  const intentLabel = INTENT_LABEL.get(signal.intent) ?? signal.intent;
  return {
    title: `${signal.symbol}: your follow ${outcome}${r}`,
    body: `${intentLabel} ${signal.direction} from ${signal.entryPrice} closed at ${signal.closePrice ?? "—"}, settled against real candles by the worker.`,
  };
}

async function check(): Promise<void> {
  const settled = await listSettledTrackedSince(lastSeenIso);
  for (const { signal, ownerId } of settled) {
    if (signal.closedAt && signal.closedAt > lastSeenIso) lastSeenIso = signal.closedAt;
    const { title, body } = describe(signal);
    publishNotification({
      id: `follow-settled-${signal.id}`,
      type: "follow-settled",
      title,
      body,
      ticker: signal.symbol,
      createdAt: signal.closedAt ?? new Date().toISOString(),
      ownerId,
    });
  }
}

/** Idempotent: first caller starts the loop, later calls are no-ops. */
export function ensureFollowWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    check().catch((error) => console.error("follow watch failed", error));
  }, CHECK_MS);
}
