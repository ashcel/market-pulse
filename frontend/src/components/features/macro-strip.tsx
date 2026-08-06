import { useTranslation } from "react-i18next";

import { MiniChart } from "@/components/features/mini-chart";
import { Change } from "@/components/features/change";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { StatusBadge } from "@/components/features/status-badge";
import { useMacro } from "@/hooks/queries";
import { cn } from "@/lib/utils";
import type { CorrelationRegime, MacroInstrument } from "@/lib/engine/macro";

/** Keys under `macro.*` in the i18n resources — see `REGIME_TITLE_KEY`. */
const REGIME_TITLE_KEY: Record<CorrelationRegime, string> = {
  coupled: "tradingWithTech",
  decoupled: "decoupled",
  inverse: "movingAgainstTech",
};

import { SkeletonCard } from "@/components/features/skeletons";

export function MacroStrip() {
  const { t } = useTranslation();
  const macro = useMacro();
  const data = macro.data;

  if (!data) {
    return <SkeletonCard className="h-full min-h-[160px]" />;
  }

  const regime = data.correlationRegime;
  const correlation = data.btcNdxCorrelation;

  return (
    <IqCard padded={false} className="p-5 flex flex-col h-full">
      <div className="flex flex-col gap-2 mb-4">
        <div className="flex items-center gap-2">
          <CardEyebrow>{t("macro.eyebrow")}</CardEyebrow>
          {data.source === "demo" && <StatusBadge tone="warning">{t("topBar.demo")}</StatusBadge>}
        </div>
        {regime && correlation !== null && (
          <div className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "rounded-md border px-2 py-0.5 font-semibold",
                regime === "coupled" && "border-info/30 bg-info-soft text-info",
                regime === "decoupled" && "border-border bg-muted text-muted-foreground",
                regime === "inverse" && "border-warning/30 bg-warning-soft text-warning",
              )}
            >
              BTC↔NDX {correlation > 0 ? "+" : ""}
              {correlation} · {t(`macro.${REGIME_TITLE_KEY[regime]}`)}
            </span>
          </div>
        )}
      </div>

      <div className="mt-auto grid grid-cols-2 gap-2">
        {data.instruments.map((instrument) => (
          <MacroCell key={instrument.id} instrument={instrument} />
        ))}
      </div>
    </IqCard>
  );
}

function MacroCell({ instrument }: { instrument: MacroInstrument }) {
  const spark = instrument.spark.map((v, t) => ({ t, v }));
  const tone =
    instrument.changePercent > 0 ? "bullish" : instrument.changePercent < 0 ? "bearish" : "neutral";
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface p-2.5">
      <div className="min-w-0 leading-tight">
        <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {instrument.label}
        </div>
        <div className="num mt-0.5 text-sm font-semibold">
          {instrument.last.toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </div>
        <Change value={instrument.changePercent} showIcon className="text-[11px]" />
      </div>
      <div className="w-16 shrink-0 sm:w-20">
        <MiniChart data={spark} tone={tone} height={30} />
      </div>
    </div>
  );
}
