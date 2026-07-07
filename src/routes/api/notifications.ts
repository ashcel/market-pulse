import { createFileRoute } from "@tanstack/react-router";

import { subscribeToNotifications, type NotificationEvent } from "@/lib/engine/notifications";

const HEARTBEAT_MS = 25_000;

export const Route = createFileRoute("/api/notifications")({
  server: {
    handlers: {
      GET: async ({ request }) => {
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
            unsubscribe = subscribeToNotifications(send);
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
