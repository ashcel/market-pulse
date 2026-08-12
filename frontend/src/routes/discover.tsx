import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { MomentumRadar } from "@/components/features/momentum-radar";
import { PageHeader } from "@/components/features/page-header";
import { ReaccumulationScanCard } from "@/components/features/reaccumulation-scan-card";
import { RsScanCard } from "@/components/features/rs-scan-card";

/**
 * The discovery plane, led by the realtime market-event radar — an information
 * *compression* engine rather than a signal feed:
 *
 *   ~600 perpetuals → durable events → structurally relevant → developing →
 *   the few situations actually worth opening.
 *
 * Two speeds (fast 1m/3m/5m/15m flow, slow cached 4H/1H/15m/5m structure) and
 * two horizons (scalp, intraday). The slower structural screens
 * (reaccumulation, relative strength vs BTC) stay available underneath,
 * collapsed by default so they never compete with the live radar.
 *
 * Everything here observes: an event, the context it happened in, what is
 * developing, and the structural path that would be in play — never long or
 * short. Engine verdicts and execution live on the token page.
 */
export const Route = createFileRoute("/discover")({
  head: () => ({
    meta: [
      { title: "Discover — Market Pulse" },
      {
        name: "description",
        content:
          "Realtime market-event radar across every liquid Binance perpetual: abnormal volume, displacement and structure events read against cached higher-timeframe context, compressed to the few scalp and intraday situations worth watching.",
      },
    ],
  }),
  component: DiscoverPage,
});

function DiscoverPage() {
  const { t } = useTranslation();

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.discover.eyebrow")}
        title={t("routes.discover.title")}
        subtitle={t("routes.discover.subtitle")}
      />

      <MomentumRadar />

      <details className="rounded-xl border border-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-muted-foreground">
          {t("routes.discover.structuralScreens")}
        </summary>
        <div className="flex flex-col gap-6 p-4 pt-0">
          <ReaccumulationScanCard />
          <RsScanCard />
        </div>
      </details>
    </div>
  );
}
