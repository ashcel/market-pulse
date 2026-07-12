import { publishNotification } from "@/lib/engine/notifications";
import { listTokenEventsSince, tokenEventRecipients } from "./db/repo";
import type { TokenEventKind } from "@/lib/engine/token-events";
import type { TokenEventRow } from "./db/repo";

/**
 * Phase 2.5 — token-event notifications. The worker ingests events into
 * Postgres in its own process; this web-process watcher (same pattern as
 * follow-watch) polls for fresh rows and pushes each warning/critical event
 * to exactly the users it concerns: owners of an active followed signal on
 * the token plus users watching it server-side. Info events (listings,
 * upgrades) are stored and shown in the UI but never push — the alert channel
 * stays reserved for things that can hurt an open position.
 */
const CHECK_MS = 2 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastSeenIso = new Date().toISOString();

const KIND_LABEL: Record<TokenEventKind, string> = {
  unlock: "Token unlock",
  security: "Security alert",
  regulatory: "Regulatory action",
  delisting: "Delisting",
  listing: "Exchange listing",
  upgrade: "Protocol upgrade",
};

function describe(event: TokenEventRow): { title: string; body: string } {
  return {
    title: `${event.symbol}: ${KIND_LABEL[event.kind] ?? event.kind}`,
    body: `${event.title} — you're watching ${event.symbol} or holding a followed signal on it. (${event.source})`,
  };
}

async function check(): Promise<void> {
  const fresh = await listTokenEventsSince(lastSeenIso);
  for (const event of fresh) {
    if (event.createdAt > lastSeenIso) lastSeenIso = event.createdAt;
    if (event.severity === "info") continue;

    const recipients = await tokenEventRecipients(event.symbol);
    const { title, body } = describe(event);
    for (const ownerId of recipients) {
      publishNotification({
        id: `token-event-${event.id}-${ownerId}`,
        type: "token-event",
        title,
        body,
        ticker: event.symbol,
        createdAt: event.createdAt,
        ownerId,
      });
    }
  }
}

/** Idempotent: first caller starts the loop, later calls are no-ops. */
export function ensureEventWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    check().catch((error) => console.error("event watch failed", error));
  }, CHECK_MS);
}
