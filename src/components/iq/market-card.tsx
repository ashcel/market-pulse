import { cn } from "@/lib/utils";
import { IqCard, CardEyebrow } from "./iq-card";
import { MiniChart } from "./mini-chart";
import { Change } from "./change";
import type { Asset } from "@/lib/types";
import { AssetIcon } from "./asset-icon";

export function MarketCard({ asset, className }: { asset: Asset; className?: string }) {
  const tone = asset.change24h >= 0 ? "bullish" : "bearish";
  return (
    <IqCard interactive className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <AssetIcon ticker={asset.ticker} className="h-5 w-5" />
          <CardEyebrow>{asset.ticker}</CardEyebrow>
        </div>
        <Change value={asset.change24h} />
      </div>
      <div className="num text-lg font-semibold tracking-tight">
        {formatPrice(asset.price)}
      </div>
      <MiniChart data={asset.spark} tone={tone} height={44} />
    </IqCard>
  );
}

export function formatPrice(price: number) {
  if (price >= 1000) return `$${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (price >= 1) return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}
