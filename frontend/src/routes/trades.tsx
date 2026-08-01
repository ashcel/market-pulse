import { createFileRoute } from "@tanstack/react-router";

import { PageHeader } from "@/components/features/page-header";
import { TradesPanel } from "@/components/features/trades-panel";

import { redirectIfNavV2 } from "@/lib/nav-redirects";

// Thin wrapper: body lives in `trades-panel.tsx` and is shared with the
// Open/History tabs on `/journal` (IA-REDESIGN-2026-07-23 §4.3). It stayed
// live for existing links/bookmarks until Sprint 5, which sends it to Book
// under NAV_V2 — still resolving, never a 404.
export const Route = createFileRoute("/trades")({
  // Retired by the 4-tab nav (Sprint 5): positions live in Book. No-op while NAV_V2=0.
  beforeLoad: () => redirectIfNavV2("/trades"),
  head: () => ({
    meta: [
      { title: "Positions & Journal — Market Pulse" },
      {
        name: "description",
        content:
          "Live open positions with real-time unrealized PnL, plus your closed-trade journal.",
      },
      { property: "og:title", content: "Positions & Journal — Market Pulse" },
      {
        property: "og:description",
        content: "Track running positions live and review your trade history.",
      },
    ],
  }),
  component: TradesPage,
});

function TradesPage() {
  return (
    <div className="space-y-5 pb-20 lg:pb-6">
      <PageHeader
        eyebrow="Live Positions & Journal"
        title="Trades"
        subtitle="Running positions update in real time from live market data. Closed trades are journaled below for review. Now also merged into the full Journal at /journal."
      />
      <TradesPanel />
    </div>
  );
}
