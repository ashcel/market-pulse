import { createFileRoute } from "@tanstack/react-router";

import { subscribeToNotifications, type NotificationEvent } from "@/lib/engine/notifications";
import { getAuth } from "@/server/auth/session";
import { ensureFollowWatch } from "@/server/follow-watch";
import { ensureHealthWatch } from "@/server/health-watch";

const HEARTBEAT_MS = 25_000;

export const Route = createFileRoute("/api/notifications")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        ensureHealthWatch();
        ensureFollowWatch();
        // The stream itself stays public (global market events); a session
        // additionally unlocks the user's own owner-scoped events (follows).
        const auth = await getAuth(request);
        const encoder = new TextEncoder();
        let unsubscribe: (() => void) | null = null;
        let heartbeat: ReturnType<typeof setInterval> | null = null;

        const cleanup = () => {
          unsubscribe?.();
          unsubscribe = null;
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = null;
        };

        const stream = new ReadableStream({
          start(controller) {
            const send = (event: NotificationEvent) => {
              const payload = `event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`;
              try {
                controller.enqueue(encoder.encode(payload));
              } catch {
                cleanup();
              }
            };
            unsubscribe = subscribeToNotifications(send, auth?.user.id);
            heartbeat = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(`: ping\n\n`));
              } catch {
                cleanup();
              }
            }, HEARTBEAT_MS);
          },
          cancel: cleanup,
        });

        request.signal.addEventListener("abort", cleanup);

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          },
        });
      },
    },
  },
});
