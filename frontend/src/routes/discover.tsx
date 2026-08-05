import { createFileRoute } from "@tanstack/react-router";

import { FundingPlaysCard } from "@/components/features/funding-plays-card";
import { CardEyebrow } from "@/components/features/iq-card";
import { MarketOpportunitiesCard } from "@/components/features/market-opportunities-card";
import { PageHeader } from "@/components/features/page-header";
import { RsScanCard } from "@/components/features/rs-scan-card";
import { useOpportunityScan } from "@/hooks/queries";

/**
 * The discovery plane in one place: the liquidity/activity scan, relative
 * strength vs BTC, and the funding window. Everything here ranks the whole
 * exchange and says "there is action here" — never long/short. Engine verdicts
 * live on the token page.
 */
export const Route = createFileRoute("/discover")({
  head: () => ({
    meta: [
      { title: "Discover — Market Pulse" },
      {
        name: "description",
        content:
          "Scan every liquid Binance USDT pair: activity, relative strength versus BTC, and the funding window.",
      },
    ],
  }),
  component: DiscoverPage,
});

function DiscoverPage() {
  const scan = useOpportunityScan();

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow="Overview"
        title="Discover"
        subtitle="Exchange-wide scans — a discovery list, not a trade signal. Open a token for the engine's verdict."
      />

      {scan.data && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>
            {scan.data.pairsRanked} of {scan.data.pairsSeen} USDT pairs passed the liquidity gates
          </span>
          <span>
            Source: {scan.data.source === "live" ? "Binance live" : "offline demo build"} · updated{" "}
            {new Date(scan.data.updatedAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <CardEyebrow>Worth Scanning</CardEyebrow>
        <MarketOpportunitiesCard />
      </div>

      <RsScanCard />

      <FundingPlaysCard />
    </div>
  );
}
