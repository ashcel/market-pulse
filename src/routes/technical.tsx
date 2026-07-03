import { createFileRoute } from "@tanstack/react-router";
import { PageHeader } from "@/components/iq/page-header";
import { useSignals, useAssets } from "@/hooks/queries";
import { SignalCard } from "@/components/iq/signal-card";
import { SkeletonCard } from "@/components/iq/skeletons";
import { IqCard, CardEyebrow } from "@/components/iq/iq-card";
import { ConfidenceGauge } from "@/components/iq/confidence-gauge";
import { TradingViewWidget } from "@/components/iq/tradingview-widget";
import { usePreferencesStore } from "@/stores/preferences";
import { AssetIcon } from "@/components/iq/asset-icon";

export const Route = createFileRoute("/technical")({
  head: () => ({
    meta: [
      { title: "Technical — IQ" },
      { name: "description", content: "Chart + smart-money signals per asset." },
      { property: "og:title", content: "Technical — IQ" },
      { property: "og:description", content: "Structure, order blocks, EMAs, volume, and ATR at a glance." },
    ],
  }),
  component: TechnicalPage,
});

const SYMBOL_MAP: Record<string, string> = {
  BTC: "BINANCE:BTCUSDT",
  ETH: "BINANCE:ETHUSDT",
  SOL: "BINANCE:SOLUSDT",
  NVDA: "NASDAQ:NVDA",
  SPY: "AMEX:SPY",
  QQQ: "NASDAQ:QQQ",
  MSFT: "NASDAQ:MSFT",
  AAPL: "NASDAQ:AAPL",
  TSLA: "NASDAQ:TSLA",
  META: "NASDAQ:META",
  GOLD: "TVC:GOLD",
  DXY: "TVC:DXY",
  VIX: "CBOE:VIX",
  AVAX: "BINANCE:AVAXUSDT",
  MUU: "BINANCE:BTCUSDT",
};

function TechnicalPage() {
  const { activeAsset, setActiveAsset } = usePreferencesStore();
  const { data: signalsData } = useSignals();
  const { data: assets } = useAssets();

  const symbol = SYMBOL_MAP[activeAsset] ?? "BINANCE:BTCUSDT";

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-6">
      <PageHeader
        eyebrow="Technical"
        title="Technical Analysis"
        subtitle="Chart + smart-money signals for the selected asset."
        action={
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2 py-1.5">
            <span className="text-xs text-muted-foreground">Asset</span>
            <select
              value={activeAsset}
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
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,340px)]">
        <TradingViewWidget symbol={symbol} height={480} />

        {signalsData ? (
          <IqCard className="flex flex-col items-center gap-4 text-center">
            <CardEyebrow>Confidence Score</CardEyebrow>
            <ConfidenceGauge value={signalsData.confidence} size={200} label="Overall" />
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <AssetIcon ticker={activeAsset} className="h-5 w-5" />
              <span className="font-semibold">{activeAsset}</span>
              <span className="text-xs text-muted-foreground">— Bullish setup</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Composite of structure, momentum, volume, and volatility signals across the last 3 sessions.
            </p>
          </IqCard>
        ) : (
          <SkeletonCard height={340} />
        )}
      </div>

      <div>
        <CardEyebrow>Signal Cards</CardEyebrow>
        <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {signalsData
            ? signalsData.signals.map((s) => <SignalCard key={s.label} signal={s} />)
            : Array.from({ length: 7 }).map((_, i) => <SkeletonCard key={i} height={130} />)}
        </div>
      </div>
    </div>
  );
}
