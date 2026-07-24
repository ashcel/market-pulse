import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/features/page-header";
import { ReviewPanel } from "@/components/features/review-panel";

// Thin wrapper: body lives in `review-panel.tsx` and is shared with the
// Habits tab on `/journal` (IA-REDESIGN-2026-07-23 §4.3). This route stays
// live for existing links/bookmarks — no redirect.
export const Route = createFileRoute("/review")({
  head: () => ({
    meta: [
      { title: "Trade Review — Market Pulse" },
      {
        name: "description",
        content: "Sync your Binance trade history and generate AI-powered per-trade reviews.",
      },
      { property: "og:title", content: "Trade Review — Market Pulse" },
      {
        property: "og:description",
        content: "RR, best/worst trades, time-of-day edge, session breakdown, and AI reviews.",
      },
    ],
  }),
  component: ReviewPage,
});

function ReviewPage() {
  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow="Trade Review"
        title="Trade Review"
        subtitle="Sync your Binance history, see where your edge actually is, and get an honest per-trade AI review — generated in your browser with your own AI key. Now also merged into the full Journal at /journal."
      />
      <ReviewPanel />
    </div>
  );
}
