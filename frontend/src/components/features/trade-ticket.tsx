import { useQuery } from "@tanstack/react-query";
import { ChevronDown, Settings2, TriangleAlert, Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Slider } from "@/components/ui/slider";
import { Separator } from "@/components/ui/separator";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { fetchHealthServer } from "@/lib/engine/system";
import { cn } from "@/lib/utils";
import { computeTicketSizingRead, buildLeverageChips } from "@/hooks/useTicketSizing";
import type { TradeTicketState } from "@/hooks/useTradeTicket";
import type { SizingPreview } from "@/hooks/useSkipCheck";

interface TradeTicketProps {
  state: TradeTicketState;
  setField: <K extends keyof TradeTicketState>(field: K, value: TradeTicketState[K]) => void;
  isValid: boolean;
  estimatedRR: number | null;
  /** Constitution max leverage — caps the chip ladder. */
  maxLeverage: number;
  /** Constitution configured per-trade risk (the band ceiling, ≤3%). */
  maxRiskPercent: number;
  /** Server-derived balance numbers (qty / notional / margin) from the latest
   * dry-run or permit — the client never holds the account balance. */
  serverSizing?: SizingPreview | null;
  /** "Adjust" disclosure state — Simple collapses Zone 2, Pro pins it open. */
  depthOpen: boolean;
  onDepthChange: (open: boolean) => void;
}

function fmtPrice(value: number | "" | null | undefined): string {
  if (value === "" || value === undefined || value === null || Number.isNaN(Number(value))) {
    return "—";
  }
  const n = Number(value);
  return n < 10 ? n.toPrecision(5) : n.toFixed(2);
}

function fmtNum(value: number | null | undefined, digits = 2): string {
  if (value === undefined || value === null || Number.isNaN(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function TradeTicket({
  state,
  setField,
  maxLeverage,
  maxRiskPercent,
  serverSizing,
  depthOpen,
  onDepthChange,
}: TradeTicketProps) {
  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: () => fetchHealthServer(),
  });
  const isLive = health?.environment === "production" || health?.environment === "live";

  const entry = state.entry_price === "" ? 0 : Number(state.entry_price);
  const stop = state.stop_price === "" ? 0 : Number(state.stop_price);
  const read = computeTicketSizingRead({
    entry,
    stop,
    side: state.side,
    leverage: state.leverage,
    riskPercent: state.risk_percent,
  });
  const chips = buildLeverageChips({ entry, stop, side: state.side, maxLeverage });

  const riskCeiling = Math.min(3, maxRiskPercent || 3);

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

      {/* ── ZONE 1 · TRADE ─────────────────────────────────────────────── */}
      <div className="flex flex-col gap-4">
        <ToggleGroup
          type="single"
          value={state.side}
          onValueChange={(val) => val && setField("side", val as "LONG" | "SHORT")}
          className="w-full justify-start gap-2"
        >
          <ToggleGroupItem
            value="LONG"
            className="h-12 flex-1 text-base font-bold data-[state=on]:bg-bullish data-[state=on]:text-bullish-foreground"
          >
            LONG
          </ToggleGroupItem>
          <ToggleGroupItem
            value="SHORT"
            className="h-12 flex-1 text-base font-bold data-[state=on]:bg-bearish data-[state=on]:text-bearish-foreground"
          >
            SHORT
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground/60">Entry</Label>
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
              className="num text-sm"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="stop_price" className="text-xs text-muted-foreground/60">
              Stop <span className="text-bearish">*</span>
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

      {/* ── ZONE 2 · RISK (behind the Adjust disclosure) ────────────────── */}
      <Collapsible open={depthOpen} onOpenChange={onDepthChange}>
        <CollapsibleTrigger className="group flex w-full items-center justify-between rounded-md bg-muted/30 px-3 py-2.5 text-left hover:bg-muted/50">
          <div className="flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Adjust risk, leverage &amp; margin</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground num">
            <span>
              {state.risk_percent.toFixed(1)}% · {state.leverage}× · {state.margin_type[0]}
            </span>
            <ChevronDown className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180" />
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent className="flex flex-col gap-5 pt-4">
          {/* Risk % slider — bound to the constitution band */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
                Risk per Trade
              </Label>
              <span className="num text-sm font-semibold">{state.risk_percent.toFixed(1)}%</span>
            </div>
            <Slider
              value={[state.risk_percent]}
              min={0.5}
              max={riskCeiling}
              step={0.1}
              onValueChange={(v) => setField("risk_percent", v[0])}
            />
            <span className="text-[10px] text-muted-foreground/60">
              Constitution band 0.5–{riskCeiling.toFixed(1)}% · sizing derives from balance × stop ×
              risk (never a quantity you type)
            </span>
          </div>

          {/* Leverage chips */}
          <div className="flex flex-col gap-2">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Leverage
            </Label>
            <div className="flex flex-wrap gap-2">
              {chips.map((chip) => {
                const active = state.leverage === chip.value;
                return (
                  <button
                    key={chip.value}
                    type="button"
                    disabled={chip.disabled}
                    title={chip.reason}
                    onClick={() => setField("leverage", chip.value)}
                    className={cn(
                      "min-w-[3rem] rounded-md border px-3 py-1.5 text-sm font-semibold num transition-colors",
                      chip.disabled
                        ? "cursor-not-allowed border-border/50 bg-muted/30 text-muted-foreground/40 line-through"
                        : active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-background hover:bg-muted/50",
                    )}
                  >
                    {chip.value}×
                  </button>
                );
              })}
            </div>
            {chips.some((c) => c.disabled) && (
              <span className="flex items-center gap-1 text-[10px] text-warning">
                <TriangleAlert className="h-3 w-3" />
                greyed leverages would put liquidation inside your stop (or over your max)
              </span>
            )}
          </div>

          {/* Margin mode */}
          <div className="flex flex-col gap-2">
            <Label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              Margin Mode
            </Label>
            <ToggleGroup
              type="single"
              value={state.margin_type}
              onValueChange={(val) => val && setField("margin_type", val as "ISOLATED" | "CROSSED")}
              className="justify-start gap-2"
            >
              <ToggleGroupItem value="ISOLATED" className="flex-1 text-xs">
                Isolated
              </ToggleGroupItem>
              <ToggleGroupItem value="CROSSED" className="flex-1 text-xs">
                Cross
              </ToggleGroupItem>
            </ToggleGroup>
            <span className="text-[10px] text-muted-foreground/60">
              {state.margin_type === "ISOLATED"
                ? "Isolated: only this position's margin is at risk (default)."
                : "Cross: the whole account backs the position — liquidation estimate is conservative."}
            </span>
          </div>

          {/* Live-computed read-only line */}
          <div className="flex flex-col gap-2 rounded-lg bg-muted/30 p-3 text-xs">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              <ReadRow label="Quantity" value={fmtNum(serverSizing?.quantity ?? null, 6)} />
              <ReadRow label="Notional" value={fmtNum(serverSizing?.notional ?? null)} />
              <ReadRow label="Req. margin" value={fmtNum(serverSizing?.required_margin ?? null)} />
              <ReadRow
                label="Eff. leverage"
                value={
                  serverSizing?.effective_leverage != null
                    ? `${serverSizing.effective_leverage.toFixed(2)}×`
                    : "—"
                }
              />
              <ReadRow
                label="Liq. price (est.)"
                value={fmtPrice(read.liquidationPrice ?? serverSizing?.liquidation_price ?? null)}
              />
              <ReadRow
                label="Liq. vs stop"
                value={
                  read.stopDistance && read.liqGapBeyondStop !== null
                    ? `${(read.liqGapBeyondStop / read.stopDistance).toFixed(1)}× stop`
                    : "n/a"
                }
                tone={read.liqBufferOk ? "ok" : "bad"}
              />
            </div>

            <Separator className="my-1 opacity-50" />

            {/* The §3.1 max-risk triple */}
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground/70">Risk now</span>
                <span className="num font-semibold">{state.risk_percent.toFixed(1)}%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground/70">
                  Max at {state.leverage}× with this stop
                </span>
                <span className="num font-semibold">
                  {read.maxRiskPercentAtLeverage != null
                    ? `${read.maxRiskPercentAtLeverage.toFixed(1)}%`
                    : "—"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground/70">Liq. buffer</span>
                <span
                  className={cn(
                    "num font-semibold",
                    read.liqBufferOk ? "text-bullish" : "text-bearish",
                  )}
                >
                  {state.leverage <= 1 ? "n/a (1×)" : read.liqBufferOk ? "safe ✓" : "inside stop ✕"}
                </span>
              </div>
            </div>

            {read.isCapped && (
              <div className="mt-1 flex items-start gap-1.5 rounded bg-warning/10 p-2 text-[11px] text-warning">
                <Info className="mt-0.5 h-3 w-3 shrink-0" />
                <span>
                  {state.risk_percent.toFixed(1)}% requested,{" "}
                  {read.maxRiskPercentAtLeverage?.toFixed(1)}% possible at {state.leverage}× — raise
                  leverage or widen the risk band.
                </span>
              </div>
            )}

            <span className="text-[9px] uppercase tracking-wider text-muted-foreground/50">
              Liquidation is an estimate (flat MMR, no funding/fees/tiered brackets)
            </span>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </IqCard>
  );
}

function ReadRow({ label, value, tone }: { label: string; value: string; tone?: "ok" | "bad" }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground/70">{label}</span>
      <span
        className={cn(
          "num font-semibold",
          tone === "ok" && "text-bullish",
          tone === "bad" && "text-bearish",
        )}
      >
        {value}
      </span>
    </div>
  );
}
