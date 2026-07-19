import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Slider } from "@/components/ui/slider";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
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
  return (
    <IqCard className="flex flex-col gap-6">
      <CardEyebrow>Trade Ticket</CardEyebrow>

      <div className="flex flex-col gap-4">
        {/* Symbol & Side */}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="symbol" className="text-xs font-medium text-muted-foreground">
              Symbol
            </Label>
            <Input
              id="symbol"
              placeholder="e.g. BTCUSDT"
              value={state.symbol}
              onChange={(e) => setField("symbol", e.target.value.toUpperCase())}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium text-muted-foreground">Side</Label>
            <ToggleGroup
              type="single"
              value={state.side}
              onValueChange={(val) => val && setField("side", val as "LONG" | "SHORT")}
              className="justify-start"
            >
              <ToggleGroupItem
                value="LONG"
                className="flex-1 data-[state=on]:bg-bullish data-[state=on]:text-bullish-foreground"
              >
                LONG
              </ToggleGroupItem>
              <ToggleGroupItem
                value="SHORT"
                className="flex-1 data-[state=on]:bg-bearish data-[state=on]:text-bearish-foreground"
              >
                SHORT
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        {/* Entry Type & Price */}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label className="text-xs font-medium text-muted-foreground">Entry Type</Label>
            <ToggleGroup
              type="single"
              value={state.entry_type}
              onValueChange={(val) => val && setField("entry_type", val as "MARKET" | "LIMIT")}
              className="justify-start"
            >
              <ToggleGroupItem value="MARKET" className="flex-1">
                MKT
              </ToggleGroupItem>
              <ToggleGroupItem value="LIMIT" className="flex-1">
                LMT
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="entry_price" className="text-xs font-medium text-muted-foreground">
              Entry Price
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
              className="num"
            />
          </div>
        </div>

        {/* Stop & Target */}
        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="stop_price" className="text-xs font-medium text-muted-foreground">
              Stop Price
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
              className="num"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="target_price" className="text-xs font-medium text-muted-foreground">
              Target Price
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
              className="num"
            />
          </div>
        </div>

        {/* Risk Slider */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium text-muted-foreground">Risk per Trade</Label>
            <span className="text-sm font-semibold num">{state.risk_percent.toFixed(1)}%</span>
          </div>
          <Slider
            min={0.5}
            max={3.0}
            step={0.1}
            value={[state.risk_percent]}
            onValueChange={([val]) => setField("risk_percent", val)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3 text-sm">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Est. Reward/Risk</span>
          <span className="font-semibold num">
            {estimatedRR !== null ? `${estimatedRR.toFixed(2)}R` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Position Size</span>
          <span className="text-xs italic text-muted-foreground">calculated at submission</span>
        </div>
      </div>

      <Button
        size="lg"
        className="w-full font-semibold"
        disabled={!isValid || isSubmitting}
        onClick={onSubmit}
      >
        {isSubmitting ? "Evaluating..." : "Request Permit"}
      </Button>
    </IqCard>
  );
}
