import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { useQuery } from "@tanstack/react-query";
import { fetchHealthServer } from "@/lib/engine/system";
import { cn } from "@/lib/utils";
import type { TradeTicketState } from "@/hooks/useTradeTicket";

interface TradeTicketProps {
  state: TradeTicketState;
  setField: <K extends keyof TradeTicketState>(field: K, value: TradeTicketState[K]) => void;
  isValid: boolean;
  estimatedRR: number | null;
  onSubmit: () => void;
  isSubmitting: boolean;
}

export function TradeTicket({
  state,
  setField,
  isValid,
  estimatedRR,
  onSubmit,
  isSubmitting,
}: TradeTicketProps) {
  const { t } = useTranslation();
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchHealthServer(),
  });

  const isLive = health?.environment === "production" || health?.environment === "live";

  return (
    <IqCard className="flex flex-col gap-5">
      <CardEyebrow className="flex items-center justify-between">
        <span>{t("components.batchE.tradeTicket.title")}</span>
        {health?.environment && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
              isLive ? "bg-bullish/20 text-bullish" : "bg-warning/20 text-warning",
            )}
          >
            {isLive ? t("components.batchE.tradeTicket.live") : t("components.batchE.tradeTicket.testnet")}
          </span>
        )}
      </CardEyebrow>

      {/* PRIMARY: Side Selection — Large, Bold, Color-Coded */}
      <div className="flex flex-col gap-2">
        <ToggleGroup
          type="single"
          value={state.side}
          onValueChange={(val) => val && setField("side", val as "LONG" | "SHORT")}
          className="justify-start w-full gap-2"
        >
          <ToggleGroupItem
            value="LONG"
            className="flex-1 h-12 text-base font-bold data-[state=on]:bg-bullish data-[state=on]:text-bullish-foreground"
          >
            {t("components.batchE.tradeTicket.long")}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="SHORT"
            className="flex-1 h-12 text-base font-bold data-[state=on]:bg-bearish data-[state=on]:text-bearish-foreground"
          >
            {t("components.batchE.tradeTicket.short")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <Separator className="opacity-50" />

      {/* SECONDARY: Entry Group */}
      <div className="flex flex-col gap-3">
        <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {t("components.batchE.tradeTicket.entryLabel")}
        </Label>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground/60">
              {t("components.batchE.tradeTicket.type")}
            </Label>
            <ToggleGroup
              type="single"
              value={state.entry_type}
              onValueChange={(val) => val && setField("entry_type", val as "MARKET" | "LIMIT")}
              className="justify-start"
            >
              <ToggleGroupItem value="MARKET" className="flex-1 text-xs">
                {t("components.batchE.tradeTicket.market")}
              </ToggleGroupItem>
              <ToggleGroupItem value="LIMIT" className="flex-1 text-xs">
                {t("components.batchE.tradeTicket.limit")}
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entry_price" className="text-xs text-muted-foreground/60">
              {t("components.batchE.tradeTicket.price")}
            </Label>
            <Input
              id="entry_price"
              type="number"
              inputMode="decimal"
              placeholder={
                state.entry_type === "MARKET"
                  ? t("components.batchE.tradeTicket.marketPlaceholder")
                  : t("components.batchE.tradeTicket.pricePlaceholder")
              }
              value={state.entry_price}
              onChange={(e) =>
                setField("entry_price", e.target.value === "" ? "" : Number(e.target.value))
              }
              disabled={state.entry_type === "MARKET"}
              className="num text-sm"
            />
          </div>
        </div>
      </div>

      {/* SECONDARY: Risk Group (Stop & Target) */}
      <div className="flex flex-col gap-3">
        <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          {t("components.batchE.tradeTicket.risk")}
        </Label>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="stop_price" className="text-xs text-muted-foreground/60">
              {t("components.batchE.tradeTicket.stop")}
            </Label>
            <Input
              id="stop_price"
              type="number"
              inputMode="decimal"
              placeholder={t("components.batchE.tradeTicket.requiredPlaceholder")}
              value={state.stop_price}
              onChange={(e) =>
                setField("stop_price", e.target.value === "" ? "" : Number(e.target.value))
              }
              className="num text-sm"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="target_price" className="text-xs text-muted-foreground/60">
              {t("components.batchE.tradeTicket.target")}
            </Label>
            <Input
              id="target_price"
              type="number"
              inputMode="decimal"
              placeholder={t("components.batchE.tradeTicket.optionalPlaceholder")}
              value={state.target_price}
              onChange={(e) =>
                setField("target_price", e.target.value === "" ? "" : Number(e.target.value))
              }
              className="num text-sm"
            />
          </div>
        </div>
      </div>

      <Separator className="opacity-50" />

      {/* SECONDARY: Risk Display */}
      <div className="flex items-center justify-between px-2 py-1">
        <Label className="text-xs text-muted-foreground/70">
          {t("components.batchE.tradeTicket.riskPerTrade")}
        </Label>
        <span className="text-sm font-semibold num text-foreground">
          {state.risk_percent.toFixed(1)}%
        </span>
      </div>

      <Separator className="opacity-50" />

      {/* Summary Strip: Est. RR is the star */}
      <div className="flex flex-col gap-3 rounded-lg bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground/70 uppercase font-semibold tracking-wide">
            {t("components.batchE.tradeTicket.estRewardRisk")}
          </span>
          <Badge
            variant="secondary"
            className={cn(
              "text-base font-bold num px-3 py-1.5",
              estimatedRR !== null && estimatedRR >= 2
                ? "bg-bullish/20 text-bullish"
                : "bg-muted text-foreground",
            )}
          >
            {estimatedRR !== null ? `${estimatedRR.toFixed(2)}R` : "—"}
          </Badge>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground/70">
            {t("components.batchE.tradeTicket.positionSize")}
          </span>
          <span className="text-xs italic text-muted-foreground/60">
            {t("components.batchE.tradeTicket.calculatedAtSubmission")}
          </span>
        </div>
      </div>

      <Button
        size="lg"
        onClick={onSubmit}
        disabled={!isValid || isSubmitting}
        className={cn(
          "w-full font-bold mt-2",
          state.side === "LONG"
            ? "bg-bullish text-bullish-foreground hover:bg-bullish/90"
            : "bg-bearish text-bearish-foreground hover:bg-bearish/90",
        )}
      >
        {isSubmitting
          ? t("components.batchE.tradeTicket.requestingPermit")
          : state.side === "LONG"
            ? t("components.batchE.tradeTicket.submitLong")
            : t("components.batchE.tradeTicket.submitShort")}
      </Button>
    </IqCard>
  );
}
