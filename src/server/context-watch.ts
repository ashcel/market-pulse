import { publishNotification } from "@/lib/engine/notifications";
import { contextHealth, type ContextHealth } from "./external-context/service";

/**
 * Server-side watcher over external-context ingestion, mirroring health-watch:
 * degraded external context must stay non-blocking for analysis but LOUD in
 * the notification stream — a failing configured provider is an outage, never
 * silently healthy. Unconfigured sources are exempt by construction
 * (contextHealth never counts them against status), so a keyless install
 * stays quiet.
 */
const CHECK_MS = 5 * 60_000;
const REALERT_MS = 6 * 60 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastStatus: ContextHealth["status"] | null = null;
let lastAlertAt = 0;

async function check(): Promise<void> {
  const health = await contextHealth();
  const now = Date.now();
  const unhealthy = health.status !== "ok";
  const wasUnhealthy = lastStatus !== null && lastStatus !== "ok";

  if (unhealthy && (!wasUnhealthy || now - lastAlertAt >= REALERT_MS)) {
    lastAlertAt = now;
    const failing = health.sources
      .filter((s) => s.status === "error")
      .map((s) => `${s.source}: ${s.lastError ?? "error"}`);
    const detail = failing.length
      ? failing.join("; ")
      : "a configured source has not succeeded within its freshness window";
    publishNotification({
      id: `context-health-${health.status}-${now}`,
      type: "context-health",
      title:
        health.status === "degraded"
          ? "External-context ingestion failing"
          : "External-context data going stale",
      body: `${detail}. The AI analyst degrades to technicals-only for the affected sections.`,
      createdAt: new Date().toISOString(),
    });
  } else if (!unhealthy && wasUnhealthy) {
    publishNotification({
      id: `context-health-recovered-${now}`,
      type: "context-health",
      title: "External-context ingestion recovered",
      body: "All configured context sources are healthy again.",
      createdAt: new Date().toISOString(),
    });
  }

  lastStatus = health.status;
}

/** Idempotent: first caller starts the loop, later calls are no-ops. */
export function ensureContextWatch(): void {
  if (timer) return;
  check().catch((error) => console.error("context watch failed", error));
  timer = setInterval(() => {
    check().catch((error) => console.error("context watch failed", error));
  }, CHECK_MS);
}
