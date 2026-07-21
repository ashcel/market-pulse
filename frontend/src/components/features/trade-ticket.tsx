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
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchHealthServer(),
  });

  const isLive = health?.environment === "production" || health?.environment === "live";

  return (
    <IqCard className="flex flex-col gap-5">
      <CardEyebrow className="flex items-center justify-between">
        <span>Trade Ticket</span>
        {health?.environment && (
          <span
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider",
              isLive ? "bg-bullish/20 text-bullish" : "bg-warning/20 text-warning",
            )}
          >
            {isLive ? "LIVE" : "TESTNET"}
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
            LONG
          </ToggleGroupItem>
          <ToggleGroupItem
            value="SHORT"
            className="flex-1 h-12 text-base font-bold data-[state=on]:bg-bearish data-[state=on]:text-bearish-foreground"
          >
            SHORT
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <Separator className="opacity-50" />

      {/* SECONDARY: Entry Group */}
      <div className="flex flex-col gap-3">
        <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          Entry
        </Label>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground/60">Type</Label>
            <ToggleGroup
              type="single"
              value={state.entry_type}
              onValueChange={(val) => val && setField("entry_type", val as "MARKET" | "LIMIT")}
              className="justify-start"
            >
              <ToggleGroupItem value="MARKET" className="flex-1 text-xs">
                MKT
              </ToggleGroupItem>
              <ToggleGroupItem value="LIMIT" className="flex-1 text-xs">
                LMT
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entry_price" className="text-xs text-muted-foreground/60">
              Price
            </Label>
            <Input
              id="entry_price"
              type="number"
              inputMode="decimal"
              placeholder={state.entry_type === "MARKET" ? "Market" : "0.00"}
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
          Risk
        </Label>
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="stop_price" className="text-xs text-muted-foreground/60">
              Stop
            </Label>
            <Input
              id="stop_price"
              type="number"
              inputMode="decimal"
              placeholder="Required"
              value={state.stop_price}
              onChange={(e) =>
                setField("stop_price", e.target.value === "" ? "" : Number(e.target.value))
              }
              className="num text-sm"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="target_price" className="text-xs text-muted-foreground/60">
              Target
            </Label>
            <Input
              id="target_price"
              type="number"
              inputMode="decimal"
              placeholder="Optional"
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
        <Label className="text-xs text-muted-foreground/70">Risk per Trade (Global)</Label>
        <span className="text-sm font-semibold num text-foreground">
          {state.risk_percent.toFixed(1)}%
        </span>
      </div>

      <Separator className="opacity-50" />

      {/* Summary Strip: Est. RR is the star */}
      <div className="flex flex-col gap-3 rounded-lg bg-muted/30 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground/70 uppercase font-semibold tracking-wide">
            Est. Reward/Risk
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
          <span className="text-xs text-muted-foreground/70">Position Size</span>
          <span className="text-xs italic text-muted-foreground/60">calculated at submission</span>
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
        {isSubmitting ? "Requesting Permit..." : state.side === "LONG" ? "Long" : "Short"}
      </Button>
    </IqCard>
  );
}
