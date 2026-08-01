import { Link, createFileRoute } from "@tanstack/react-router";

import { CardEyebrow, IqCard } from "@/components/features/iq-card";
import { Badge } from "@/components/ui/badge";
import { useIdeas, type Opportunity, type OpportunitySource } from "@/hooks/useIdeas";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/ideas")({ component: IdeasPage });

function sourceLabel(source: OpportunitySource): string {
  const name = source.source === "quant" ? "Quant" : source.source.toUpperCase();
  return `${name} · ${source.kind.replace("-alignment", "-align")}`;
}

function IdeaCard({ idea }: { idea: Opportunity }) {
  const sourceCount = new Set(idea.sources.map((source) => source.source)).size;
  const evidence = idea.evidence.status === "ok" && idea.evidence.hit_rate != null
    ? `hit-rate ${idea.evidence.window_days} hari · ${(idea.evidence.hit_rate * 100).toFixed(0)}%`
    : "Belum cukup data";

  return (
    <Link to="/token/$symbol" params={{ symbol: idea.symbol }} className="block">
      <IqCard className="transition-colors hover:border-info/40 hover:bg-surface/40">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardEyebrow>Idea · {idea.horizon}</CardEyebrow>
            <div className="mt-1 flex items-center gap-2">
              <h2 className="text-lg font-bold">{idea.symbol}</h2>
              <Badge className={cn("text-[10px] uppercase", idea.side === "long" ? "bg-bullish-soft text-bullish" : "bg-bearish-soft text-bearish")}>
                {idea.side === "long" ? "Naik" : "Turun"}
              </Badge>
            </div>
          </div>
          {idea.regime_alignment === "counter" && <Badge variant="outline" className="border-warning/40 text-warning">melawan regime</Badge>}
        </div>
        <p className="mt-3 truncate text-sm text-muted-foreground">{idea.sources[0]?.reason}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {idea.sources.map((source) => <Badge key={`${source.source}-${source.kind}`} variant="outline">{sourceLabel(source)}</Badge>)}
          {sourceCount > 1 && <Badge variant="outline" className="border-info/30 text-info">{sourceCount} sumber sepakat</Badge>}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{evidence}</p>
      </IqCard>
    </Link>
  );
}

function IdeasPage() {
  const ideasQuery = useIdeas();
  const ideas = ideasQuery.data ?? [];
  const main = ideas.filter((idea) => idea.regime_alignment !== "counter");
  const counter = ideas.filter((idea) => idea.regime_alignment === "counter");

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 pb-24">
      <div>
        <CardEyebrow>Ideas</CardEyebrow>
        <h1 className="mt-1 text-2xl font-bold tracking-tight">Ide yang layak ditinjau</h1>
      </div>
      {ideasQuery.isLoading && <IqCard className="h-32 animate-pulse" />}
      {ideasQuery.isError && <IqCard><p className="text-sm text-muted-foreground">Ideas belum bisa dimuat.</p></IqCard>}
      {!ideasQuery.isLoading && !ideasQuery.isError && ideas.length === 0 && <IqCard><p className="text-sm text-muted-foreground">Belum ada ide lolos gate hari ini — regime choppy.</p></IqCard>}
      {main.map((idea) => <IdeaCard key={idea.key} idea={idea} />)}
      {counter.length > 0 && <section className="flex flex-col gap-3 pt-2"><p className="text-xs font-semibold uppercase tracking-wider text-warning">Melawan regime</p>{counter.map((idea) => <IdeaCard key={idea.key} idea={idea} />)}</section>}
    </main>
  );
}
