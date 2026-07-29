import { useState } from "react";
import { TrendingUp, TrendingDown, Minus, Brain, Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { IqCard, CardEyebrow } from "@/components/features/iq-card";
import { MarkdownText } from "@/components/features/markdown-text";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface AnalysisResult {
  response: string;
  positions_analyzed: number;
  conversation_id: string;
}

async function fetchAnalysis(): Promise<AnalysisResult> {
  const res = await fetch("/api/v1/ai-desk/analyze-trades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    credentials: "same-origin",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error?.message || body?.detail || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  const json = await res.json();
  return json.data;
}

export function AiTradeAnalysis() {
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const analyze = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const data = await fetchAnalysis();
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <IqCard padded={false} className="flex flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3 sm:px-5 sm:pt-4">
        <CardEyebrow>
          <Brain className="mr-1.5 inline h-3.5 w-3.5 text-info" aria-hidden />
          AI Trade Analysis
        </CardEyebrow>
        {result && (
          <span className="text-[10px] text-muted-foreground">
            {result.positions_analyzed} positions analyzed
          </span>
        )}
      </div>

      <div className="px-3 pb-3 sm:px-5 sm:pb-4">
        {!result && !loading && !error && (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/50 bg-surface/30 p-6 text-center">
            <Brain className="h-8 w-8 text-info/60" />
            <p className="text-sm text-muted-foreground max-w-md">
              Get an AI-powered review of your open positions — including chart
              analysis, market sentiment, recent news, and specific action
              suggestions for each trade.
            </p>
            <Button onClick={analyze} className="mt-1">
              <Brain className="mr-2 h-4 w-4" />
              Analyze My Trades
            </Button>
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-6 w-6 animate-spin text-info" />
            <p className="text-sm text-muted-foreground">
              Analyzing your portfolio — checking charts, sentiment, and news...
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-bearish/30 bg-bearish-soft p-4">
            <p className="text-sm font-medium text-bearish">Analysis failed</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={analyze}
              className="mt-3"
            >
              Retry
            </Button>
          </div>
        )}

        {result && (
          <div className="space-y-3">
            <div className="max-h-[500px] overflow-y-auto rounded-lg border border-border bg-surface p-4">
              <MarkdownText text={result.response} />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={analyze}
              className="w-full"
            >
              <Brain className="mr-2 h-3.5 w-3.5" />
              Re-analyze
            </Button>
          </div>
        )}
      </div>
    </IqCard>
  );
}