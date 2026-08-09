import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { PageHeader } from "@/components/features/page-header";
import { ReaccumulationScanCard } from "@/components/features/reaccumulation-scan-card";
import { RallyWatcherCard } from "@/components/features/rally-watcher-card";
import { RsScanCard } from "@/components/features/rs-scan-card";

/**
 * The discovery plane in one place: what's moving right now (Rally Watcher),
 * a reaccumulation screen, and relative strength vs BTC. Everything here
 * ranks the whole exchange and says "there is action here" — never
 * long/short. Engine verdicts live on the token page.
 */
export const Route = createFileRoute("/discover")({
  head: () => ({
    meta: [
      { title: "Discover — Market Pulse" },
      {
        name: "description",
        content:
          "Scan every liquid Binance USDT pair: rally watcher, reaccumulation screening, and relative strength versus BTC.",
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

      <RallyWatcherCard />

      <ReaccumulationScanCard />

      <RsScanCard />
    </div>
  );
}
