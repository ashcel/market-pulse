import { createFileRoute } from "@tanstack/react-router";
import { RecordPanel } from "@/components/features/record-panel";

// Body lives in components/features/record-panel.tsx — shared with the
// "Record" tab inside /markets (IA-REDESIGN-2026-07-23 §4.5). This route
// keeps /tracker itself working as a direct deep link.
export const Route = createFileRoute("/tracker")({
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
