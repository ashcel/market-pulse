import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  ShieldAlert,
  TriangleAlert,
  Hammer,
  Ban,
} from "lucide-react";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { PageHeader } from "@/components/features/page-header";
import { ExecutionPanel } from "@/components/features/execution-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { TradeTicketState } from "@/hooks/useTradeTicket";
import {
  useSkipCheck,
  type SkipBlock,
  type SkipObjective,
  type SkipDirection,
  type SkipCheckAnswer,
} from "@/hooks/useSkipCheck";

interface CheckSearch {
  symbol?: string;
}

export const Route = createFileRoute("/check")({
  validateSearch: (search: Record<string, unknown>): CheckSearch => ({
    symbol: typeof search.symbol === "string" ? search.symbol : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Check — Market Pulse" },
      {
        name: "description",
        content: "Skip Check: pick a symbol and objective, get a deterministic answer.",
      },
    ],
  }),
  component: CheckPage,
});

const OBJECTIVES: SkipObjective[] = ["scalp", "intraday", "swing"];

function num(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function CheckPage() {
  const { symbol: symbolParam } = Route.useSearch();
  const { answer, loading, error, runCheck } = useSkipCheck();

  const [symbol, setSymbol] = useState((symbolParam ?? "BTCUSDT").toUpperCase());
  const [objective, setObjective] = useState<SkipObjective>("intraday");
  const [direction, setDirection] = useState<SkipDirection>("LONG");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    if (symbolParam) setSymbol(symbolParam.toUpperCase());
  }, [symbolParam]);

  const submit = () => {
    setBuilding(false);
    void runCheck({
      symbol: symbol.trim().toUpperCase(),
      objective,
      direction,
      entry_price: num(entry),
      planned_stop: num(stop),
      take_profit: num(target),
    });
  };

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-5">
      <PageHeader
        eyebrow="Check"
        title="Check a Trade"
        subtitle="Symbol, objective, direction — a deterministic supportive / cautioned / no-opinion answer, with what would flip it."
      />

      {/* ── input row ─────────────────────────────────────────────────── */}
      <IqCard className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="symbol" className="text-xs text-muted-foreground/70">
              Symbol
            </Label>
            <Input
              id="symbol"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="BTCUSDT"
              className="num uppercase"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground/70">Direction</Label>
            <ToggleGroup
              type="single"
              value={direction}
              onValueChange={(v) => v && setDirection(v as SkipDirection)}
              className="justify-start gap-2"
            >
              <ToggleGroupItem
                value="LONG"
                className="flex-1 font-bold data-[state=on]:bg-bullish data-[state=on]:text-bullish-foreground"
              >
                LONG
              </ToggleGroupItem>
              <ToggleGroupItem
                value="SHORT"
                className="flex-1 font-bold data-[state=on]:bg-bearish data-[state=on]:text-bearish-foreground"
              >
                SHORT
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label className="text-xs text-muted-foreground/70">Objective</Label>
          <ToggleGroup
            type="single"
            value={objective}
            onValueChange={(v) => v && setObjective(v as SkipObjective)}
            className="justify-start gap-2"
          >
            {OBJECTIVES.map((o) => (
              <ToggleGroupItem key={o} value={o} className="flex-1 capitalize">
                {o}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="c-entry" className="text-xs text-muted-foreground/70">
              Entry <span className="text-muted-foreground/40">(opt)</span>
            </Label>
            <Input
              id="c-entry"
              type="number"
              inputMode="decimal"
              value={entry}
              onChange={(e) => setEntry(e.target.value)}
              placeholder="mark"
              className="num text-sm"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="c-stop" className="text-xs text-muted-foreground/70">
              Planned stop <span className="text-muted-foreground/40">(opt)</span>
            </Label>
            <Input
              id="c-stop"
              type="number"
              inputMode="decimal"
              value={stop}
              onChange={(e) => setStop(e.target.value)}
              placeholder="—"
              className="num text-sm"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="c-target" className="text-xs text-muted-foreground/70">
              Target <span className="text-muted-foreground/40">(opt)</span>
            </Label>
            <Input
              id="c-target"
              type="number"
              inputMode="decimal"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="—"
              className="num text-sm"
            />
          </div>
        </div>

        <Button
          onClick={submit}
          disabled={loading || !symbol.trim()}
          size="lg"
          className="font-bold"
        >
          {loading ? "Checking…" : "Run Check"}
        </Button>
        {error && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>
        )}
      </IqCard>

      {/* ── answer ────────────────────────────────────────────────────── */}
      {answer && (
        <AnswerCard
          answer={answer}
          building={building}
          onBuild={() => setBuilding(true)}
          onCancelBuild={() => setBuilding(false)}
          initialTicket={{
            symbol: answer.symbol,
            side: answer.direction,
            entry_type: num(entry) ? "LIMIT" : "MARKET",
            entry_price: num(entry) ?? "",
            stop_price: num(stop) ?? "",
            target_price: num(target) ?? "",
          }}
        />
      )}
    </div>
  );
}

const ANSWER_STYLE: Record<
  SkipCheckAnswer["answer"],
  { label: string; cls: string; Icon: typeof CheckCircle2 }
> = {
  supportive: {
    label: "Supportive read",
    cls: "text-bullish border-bullish/40",
    Icon: CheckCircle2,
  },
  caution: { label: "Cautions stated", cls: "text-warning border-warning/40", Icon: TriangleAlert },
  no_opinion: {
    label: "No opinion — insufficient evidence",
    cls: "text-muted-foreground border-border",
    Icon: CircleHelp,
  },
};

function AnswerCard({
  answer,
  building,
  onBuild,
  onCancelBuild,
  initialTicket,
}: {
  answer: SkipCheckAnswer;
  building: boolean;
  onBuild: () => void;
  onCancelBuild: () => void;
  initialTicket: Partial<TradeTicketState>;
}) {
  const style = ANSWER_STYLE[answer.answer];
  const StyleIcon = style.Icon;

  const dryRun = answer.permit_preview;
  const groups = useMemo(
    () => [
      { title: "Supportive", blocks: answer.supportive_read, tone: "supportive" as const },
      { title: "Cautions", blocks: answer.cautions, tone: "caution" as const },
      { title: "No opinion", blocks: answer.no_opinion, tone: "no_opinion" as const },
    ],
    [answer],
  );

  return (
    <IqCard className={cn("flex flex-col gap-5 border", style.cls)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <StyleIcon className={cn("h-6 w-6", style.cls)} />
          <div className="flex flex-col">
            <CardEyebrow className={style.cls}>{style.label}</CardEyebrow>
            <span className="text-sm text-foreground/90">{answer.headline}</span>
          </div>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wider num",
            dryRun.status === "APPROVED"
              ? "bg-bullish/20 text-bullish"
              : "bg-destructive/15 text-destructive",
          )}
          title="Dry-run permit — nothing placed, nothing persisted"
        >
          Dry-run: {dryRun.status}
        </span>
      </div>

      {/* typed blocks, grouped + color-coded, each with expandable evidence */}
      <div className="flex flex-col gap-3">
        {groups.map(
          (g) =>
            g.blocks.length > 0 && (
              <div key={g.title} className="flex flex-col gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
                  {g.title}
                </span>
                {g.blocks.map((b, i) => (
                  <BlockRow key={`${g.title}-${i}`} block={b} tone={g.tone} />
                ))}
              </div>
            ),
        )}
      </div>

      {/* what-flips-it — always present */}
      <div className="flex flex-col gap-2 rounded-lg bg-muted/30 p-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
          What would flip it
        </span>
        <ul className="flex flex-col gap-1.5">
          {answer.what_flips_it.map((f, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-foreground/80">
              <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 -rotate-90 text-muted-foreground" />
              <span>{f.condition}</span>
            </li>
          ))}
        </ul>
      </div>

      {dryRun.quality_score != null && (
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Trade Quality Score</span>
          <span className="num font-semibold text-foreground">
            {Math.round(dryRun.quality_score)}
            <span className="ml-1 text-[10px] uppercase text-muted-foreground/60">
              {dryRun.quality_disclaimer ? "evaluation, not prediction" : ""}
            </span>
          </span>
        </div>
      )}

      {/* continuation */}
      {!building && answer.viable && (
        <Button onClick={onBuild} size="lg" className="gap-2 font-bold">
          <Hammer className="h-4 w-4" /> Build ticket
        </Button>
      )}
      {!building && !answer.viable && (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Ban className="h-4 w-4 text-muted-foreground" />
            Sit this one out
          </div>
          <p className="text-xs text-muted-foreground">
            The desk can't clear this trade right now — the cautions above must resolve first.
            Sitting out is a decision, not a dead end. (Ranked alternatives land in a later
            release.)
          </p>
        </div>
      )}

      {building && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Build ticket</span>
            <Button variant="ghost" size="sm" onClick={onCancelBuild}>
              Back to answer
            </Button>
          </div>
          <ExecutionPanel
            initialTicket={initialTicket}
            serverSizing={answer.sizing}
            className="w-full"
          />
        </div>
      )}
    </IqCard>
  );
}

const TONE_CLS = {
  supportive: {
    Icon: CheckCircle2,
    icon: "text-bullish",
    bg: "bg-bullish/5",
  },
  caution: {
    Icon: ShieldAlert,
    icon: "text-warning",
    bg: "bg-warning/5",
  },
  no_opinion: {
    Icon: CircleHelp,
    icon: "text-muted-foreground",
    bg: "bg-muted/30",
  },
};

function BlockRow({
  block,
  tone,
}: {
  block: SkipBlock;
  tone: "supportive" | "caution" | "no_opinion";
}) {
  const t = TONE_CLS[tone];
  const ToneIcon = block.blocking ? TriangleAlert : t.Icon;
  const hasEvidence = block.evidence.length > 0;

  const inner = (
    <div className={cn("flex items-start gap-3 rounded-md p-2.5", t.bg)}>
      <ToneIcon
        className={cn("mt-0.5 h-4 w-4 shrink-0", block.blocking ? "text-destructive" : t.icon)}
      />
      <div className="flex flex-1 flex-col">
        <span className="text-sm font-medium">
          {block.headline}
          {block.blocking && (
            <span className="ml-2 rounded bg-destructive/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-destructive">
              blocking
            </span>
          )}
        </span>
        <span className="text-xs text-muted-foreground">{block.detail}</span>
      </div>
      {hasEvidence && (
        <ChevronDown className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      )}
    </div>
  );

  if (!hasEvidence) return inner;

  return (
    <Collapsible className="group">
      <CollapsibleTrigger className="w-full text-left">{inner}</CollapsibleTrigger>
      <CollapsibleContent className="px-3 pb-2 pt-1">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          {block.evidence.map((ev, i) => (
            <div key={i} className="contents">
              <dt className="text-muted-foreground/70">{ev.label}</dt>
              <dd className="num text-foreground/80">{ev.value}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
}
