import { PageHeader, SectionHeader } from "@/components/features/page-header";
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

const TOUR_SEEN_KEY = "iq-technical-tour-v1";

const TOUR_STEPS: TourStep[] = [
  {
    target: "picker",
    title: "Pick an asset",
    body: "Everything on this page — the chart, the signal strength, and the signal cards — recalculates for the asset you select here. Your choice is remembered between visits.",
  },
  {
    target: "chart",
    title: "TradingView chart",
    body: "A full TradingView chart for the selected asset. Use its own toolbar to change timeframes, add indicators, or draw on the chart.",
  },
  {
    target: "signal-strength",
    title: "Signal strength",
    body: "How strongly the engine's evidence points in one direction — not a probability of success. A composite of trend, structure, volume, and risk checks on live 1H bars.",
  },
  {
    target: "signals",
    title: "Signal cards",
    body: "The individual checks behind the score: structure, order blocks, EMAs, volume, ATR, and more. Each card shows its own reading and direction, so you can see exactly what supports — or contradicts — the overall verdict.",
  },
];

/**
 * `asSection` folds this in below the Rankings table on the Assets tab (no
 * page eyebrow/title, just a section header + asset picker) instead of its
 * own tab (IA-REDESIGN-2026-07-23 §4.5 — Rankings + Technical merge into
 * one Assets tab).
 */
export function TechnicalPanel({ asSection = false }: { asSection?: boolean } = {}) {
  const { activeAsset, setActiveAsset } = usePreferencesStore();
  const { data: assets } = useAssets();
  const tour = useProductTour(TOUR_SEEN_KEY);

  // Fall back to BTC if a previously persisted selection is no longer tracked.
  const ticker = assets?.some((a) => a.ticker === activeAsset) ? activeAsset : "BTC";
  const { data: signalsData } = useSignals(ticker);
  const asset = assets?.find((a) => a.ticker === ticker);

  const symbol = tradingViewSymbol(ticker);

  const pickerAndHelp = (
    <div className="flex items-center gap-2">
      <div
        data-tour="picker"
        className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5"
      >
        <span className="text-xs text-muted-foreground">Asset</span>
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
  );

  return (
    <div className="flex flex-col gap-6">
      {asSection ? (
        <SectionHeader title="Technical" action={pickerAndHelp} />
      ) : (
        <PageHeader
          eyebrow="Technical"
          title="Technical Analysis"
          subtitle="Chart + smart-money signals for the selected asset."
          action={pickerAndHelp}
        />
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <div data-tour="chart">
          <TradingViewWidget symbol={symbol} height={480} />
        </div>

        {signalsData ? (
          <IqCard
            data-tour="signal-strength"
            className="flex flex-col items-center gap-4 text-center"
          >
            <CardEyebrow>Signal Strength</CardEyebrow>
            <ConfidenceGauge value={signalsData.confidence} size={200} label="Overall" />
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <AssetIcon ticker={ticker} className="h-5 w-5" />
              <span className="font-semibold">{ticker}</span>
              <span className="text-xs capitalize text-muted-foreground">
                — {asset?.setupType?.replaceAll("-", " ") ?? "analyzing"}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              How strongly the engine's evidence points in one direction — not the probability the
              trade wins. Composite of trend, structure, volume, and risk on live 1H bars.
            </p>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}
      </div>

      <div data-tour="signals">
        <CardEyebrow>Signal Cards</CardEyebrow>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {signalsData
            ? signalsData.signals.map((s) => <SignalCard key={s.label} signal={s} />)
            : Array.from({ length: 9 }).map((_, i) => <SkeletonCard key={i} height={130} />)}
        </div>
      </div>

      <ProductTour steps={TOUR_STEPS} open={tour.open && !!signalsData} onClose={tour.close} />
    </div>
  );
}
