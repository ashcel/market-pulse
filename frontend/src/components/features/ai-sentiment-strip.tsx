import { useAiSentiment } from "@/hooks/use-ai-sentiment";
import { SentimentGaugeCard } from "@/components/features/sentiment-gauge-card";
import { SkeletonCard } from "@/components/features/skeletons";

/**
 * AI News Sentiment strip for the home dashboard.
 * Shows only when the backend has a snapshot (LLM_API_KEY configured + worker ran).
 */
export function AiSentimentStrip() {
  const { data, isLoading } = useAiSentiment();

  if (isLoading) {
    return <SkeletonCard className="h-48 w-full" />;
  }

  if (!data) {
    // Silently hidden when not configured yet — no error clutter on home
    return null;
  }

  return <SentimentGaugeCard data={data} />;
}
