import { publishNotification } from "@/lib/engine/notifications";
import { healthSnapshot, type ForwardTestHealthStatus } from "./forward-test/service";

/**
 * Server-side watcher over the forward-test worker's liveness (P0.3 of the
 * 2026-07-12 roadmap). Polls the same `healthSnapshot()` read model behind
 * `/api/forward-test?view=health` and pushes transitions into the notification
 * stream: an alert when the worker goes stale/errored, a recovery note when it
 * comes back, and a reminder at most every `REALERT_MS` while it stays down.
 *
 * Lives in `src/server/` (imports the Postgres repo transitively) and is
 * started from the notifications API route — server-only by construction.
 */
const CHECK_MS = 2 * 60_000;
const REALERT_MS = 30 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastStatus: ForwardTestHealthStatus | null = null;
let lastAlertAt = 0;

function isUnhealthy(status: ForwardTestHealthStatus): boolean {
  // "never-run" is a fresh install, not an outage — don't page on it.
  return status === "stale" || status === "error";
}

async function check(): Promise<void> {
  const health = await healthSnapshot();
  const now = Date.now();
  const wasUnhealthy = lastStatus !== null && isUnhealthy(lastStatus);
  const unhealthy = isUnhealthy(health.status);

  if (unhealthy && (!wasUnhealthy || now - lastAlertAt >= REALERT_MS)) {
    lastAlertAt = now;
    const age = health.lastRunAgeSeconds;
    const ageNote =
      age !== undefined ? `Last pass ${Math.round(age / 60)}m ago.` : "No finished pass found.";
    publishNotification({
      id: `worker-health-${health.status}-${now}`,
      type: "worker-health",
      title:
        health.status === "error"
          ? "Forward-test worker: last pass errored"
          : "Forward-test worker looks stale",
      body: `${ageNote} Open records: ${health.openRecords.shadow} shadow / ${health.openRecords.anticipatory} anticipatory / ${health.openRecords.tracked} tracked. Check the VPS if this persists.`,
      createdAt: new Date().toISOString(),
    });
  } else if (!unhealthy && wasUnhealthy) {
    publishNotification({
      id: `worker-health-recovered-${now}`,
      type: "worker-health",
      title: "Forward-test worker recovered",
      body: "The eval+settle loop is passing again.",
      createdAt: new Date().toISOString(),
    });
  }

  lastStatus = health.status;
}

/** Idempotent: first caller starts the loop, later calls are no-ops. */
export function ensureHealthWatch(): void {
  if (timer) return;
  check().catch((error) => console.error("health watch failed", error));
  timer = setInterval(() => {
    check().catch((error) => console.error("health watch failed", error));
  }, CHECK_MS);
}
