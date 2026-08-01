import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/features/page-header";
import { ReviewPanel } from "@/components/features/review-panel";

import { redirectIfNavV2 } from "@/lib/nav-redirects";

// Thin wrapper: body lives in `review-panel.tsx` and is shared with the
// Habits tab on `/journal` (IA-REDESIGN-2026-07-23 §4.3). It stayed live for
// existing links/bookmarks until Sprint 5, which sends it to Lab under NAV_V2.
export const Route = createFileRoute("/review")({
  // Retired by the 4-tab nav (Sprint 5): trade review lives in Lab. No-op while NAV_V2=0.
  beforeLoad: () => redirectIfNavV2("/review"),
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
