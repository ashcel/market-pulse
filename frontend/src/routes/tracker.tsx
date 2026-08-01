import { createFileRoute } from "@tanstack/react-router";
import { RecordPanel } from "@/components/features/record-panel";

import { redirectIfNavV2 } from "@/lib/nav-redirects";

// Body lives in components/features/record-panel.tsx — shared with the
// "Record" tab inside /markets (IA-REDESIGN-2026-07-23 §4.5). This route
// kept /tracker working as a direct deep link; Sprint 5 sends it to Book
// under NAV_V2.
export const Route = createFileRoute("/tracker")({
  // Retired by the 4-tab nav (Sprint 5): followed signals live in Book. No-op while NAV_V2=0.
  beforeLoad: () => redirectIfNavV2("/tracker"),
  head: () => ({
    meta: [
      { title: "Signal Tracker — Market Pulse" },
      {
        name: "description",
        content: "Forward-test the signals you've followed against live price.",
      },
      { property: "og:title", content: "Signal Tracker — Market Pulse" },
      {
        property: "og:description",
        content: "No backtest hindsight — just what actually happened after you followed a call.",
      },
    ],
  }),
  component: RecordPanel,
});
