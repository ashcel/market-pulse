import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { PageHeader } from "@/components/features/page-header";
import { useSignals, useAssets } from "@/hooks/queries";
import { SignalCard } from "@/components/features/signal-card";
import { SkeletonCard } from "@/components/features/skeletons";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { ConfidenceGauge } from "@/components/features/confidence-gauge";
import { TradingViewWidget } from "@/components/features/tradingview-widget";
import { usePreferencesStore } from "@/stores/preferences";
import { AssetIcon } from "@/components/features/asset-icon";
import { tradingViewSymbol } from "@/lib/engine/market";
import {
  HelpButton,
  ProductTour,
  useProductTour,
  type TourStep,
} from "@/components/features/product-tour";

export const Route = createFileRoute("/technical")({
  head: () => ({
    meta: [
      { title: "Technical — Market Pulse" },
      { name: "description", content: "Chart + smart-money signals per asset." },
      { property: "og:title", content: "Technical — Market Pulse" },
      {
        property: "og:description",
        content: "Structure, order blocks, EMAs, volume, and ATR at a glance.",
      },
    ],
  }),
  component: TechnicalPage,
});

const TOUR_SEEN_KEY = "iq-technical-tour-v1";
const TOUR_TARGETS = ["picker", "chart", "signal-strength", "signals"] as const;

function useTourSteps(): TourStep[] {
  const { t } = useTranslation();
  return TOUR_TARGETS.map((target) => ({
    target,
    title: t(`routes.technical.tour.${target}.title`),
    body: t(`routes.technical.tour.${target}.body`),
  }));
}

function TechnicalPage() {
  const { t } = useTranslation();
  const { activeAsset, setActiveAsset } = usePreferencesStore();
  const { data: assets } = useAssets();
  const tour = useProductTour(TOUR_SEEN_KEY);
  const tourSteps = useTourSteps();

  // Fall back to BTC if a previously persisted selection is no longer tracked.
  const ticker = assets?.some((a) => a.ticker === activeAsset) ? activeAsset : "BTC";
  const { data: signalsData } = useSignals(ticker);
  const asset = assets?.find((a) => a.ticker === ticker);

  const symbol = tradingViewSymbol(ticker);

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow={t("routes.technical.eyebrow")}
        title={t("routes.technical.title")}
        subtitle={t("routes.technical.subtitle")}
        action={
          <div className="flex items-center gap-2">
            <div
              data-tour="picker"
              className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5"
            >
              <span className="text-xs text-muted-foreground">{t("routes.technical.asset")}</span>
              <select
                value={ticker}
                onChange={(e) => setActiveAsset(e.target.value)}
                className="bg-transparent text-sm font-semibold outline-none"
              >
                {assets?.map((a) => (
                  <option key={a.id} value={a.ticker} className="bg-popover text-foreground">
                    {a.ticker} · {a.name}
                  </option>
                ))}
              </select>
            </div>
            <HelpButton onClick={tour.start} />
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div data-tour="chart">
          <TradingViewWidget symbol={symbol} height={480} />
        </div>

        {signalsData ? (
          <IqCard
            data-tour="signal-strength"
            className="flex flex-col items-center gap-4 text-center"
          >
            <CardEyebrow>{t("routes.technical.signalStrength")}</CardEyebrow>
            <ConfidenceGauge
              value={signalsData.confidence}
              size={200}
              label={t("routes.technical.overall")}
            />
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <AssetIcon ticker={ticker} className="h-5 w-5" />
              <span className="font-semibold">{ticker}</span>
              <span className="text-xs capitalize text-muted-foreground">
                — {asset?.setupType?.replaceAll("-", " ") ?? t("routes.technical.analyzing")}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("routes.technical.signalStrengthNote")}
            </p>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}
      </div>

      <div data-tour="signals">
        <CardEyebrow>{t("routes.technical.signalCards")}</CardEyebrow>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {signalsData
            ? signalsData.signals.map((s) => <SignalCard key={s.label} signal={s} />)
            : Array.from({ length: 9 }).map((_, i) => <SkeletonCard key={i} height={130} />)}
        </div>
      </div>

      <ProductTour steps={tourSteps} open={tour.open && !!signalsData} onClose={tour.close} />
    </div>
  );
}
